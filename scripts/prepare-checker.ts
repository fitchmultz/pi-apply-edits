#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareOxlint } from "./prepare-oxlint.ts";

const VERSION = "7.0.2003";
const REVISION = "eb9339115edde6811ca94c3433adf69ea9852880";
const TYPESCRIPT_REVISION = "2bd066d87f5bafd315be9f40889d0a60b9e58e0b";
const SOURCE = "https://github.com/oxc-project/tsgolint.git";
const PATCHES = ["safe-call.patch", "value-and-readonly.patch"].map((name) =>
  fileURLToPath(new URL(`../patches/tsgolint/${name}`, import.meta.url)),
);
const require = createRequire(import.meta.url);

function run(executable: string, args: readonly string[], cwd?: string): string {
  return execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checkedVersion(): void {
  const metadata: unknown = JSON.parse(
    readFileSync(require.resolve("oxlint-tsgolint/package.json"), "utf8"),
  );
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    metadata.version !== VERSION
  ) {
    throw new Error(
      `Checker patch requires lockfile-resolved oxlint-tsgolint ${VERSION}; review the correction before upgrading.`,
    );
  }
}

function checkedGoVersion(): string {
  const version = run("go", ["version"]);
  const match = /^go version go1\.(\d+)(?:\.\d+)?\s/u.exec(version);
  if (match === null || Number(match[1]) < 26) {
    throw new Error("Building the pinned checker requires Go 1.26 or later.");
  }
  return version;
}

function hasDevelopmentChecker(): boolean {
  try {
    require.resolve("oxlint-tsgolint/package.json");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

function checkoutSource(directory: string): void {
  run("git", ["init", "--quiet", directory]);
  run("git", ["remote", "add", "origin", SOURCE], directory);
  run("git", ["fetch", "--quiet", "--depth=1", "origin", REVISION], directory);
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], directory);
  if (run("git", ["rev-parse", "HEAD"], directory) !== REVISION) {
    throw new Error("Fetched checker source does not match its immutable revision.");
  }
  run("git", ["submodule", "update", "--init", "--depth=1"], directory);
  const typescript = join(directory, "typescript-go");
  if (run("git", ["rev-parse", "HEAD"], typescript) !== TYPESCRIPT_REVISION) {
    throw new Error("Fetched TypeScript source does not match the checker submodule revision.");
  }
  const patches = readdirSync(join(directory, "patches"))
    .filter((name) => name.endsWith(".patch"))
    .sort();
  run(
    "git",
    [
      "-c",
      "user.name=Pi quality builder",
      "-c",
      "user.email=pi@example.invalid",
      "am",
      "--3way",
      "--no-gpg-sign",
      ...patches.map((name) => join(directory, "patches", name)),
    ],
    typescript,
  );
  // Canonical upstream initialization generates collections from the patched submodule.
  const collections = join(directory, "internal", "collections");
  mkdirSync(collections, { recursive: true });
  const source = join(typescript, "internal", "collections");
  for (const name of readdirSync(source).filter(
    (entry) => entry.endsWith(".go") && !entry.endsWith("_test.go"),
  )) {
    copyFileSync(join(source, name), join(collections, name));
  }
  for (const patch of PATCHES) {
    run("git", ["apply", "--check", patch], directory);
    run("git", ["apply", patch], directory);
  }
}

function cachedBinary(cache: string): string | undefined {
  const binary = join(cache, process.platform === "win32" ? "tsgolint.exe" : "tsgolint");
  const checksum = join(cache, "sha256");
  if (!existsSync(binary) || !existsSync(checksum)) {
    return;
  }
  if (sha256(binary) !== readFileSync(checksum, "utf8").trim()) {
    throw new Error(
      `Cached checker failed its checksum: ${cache}. Remove this cache directory and rerun preparation.`,
    );
  }
  return binary;
}

function buildChecker(cache: string): string {
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(join(cache, "build-"));
  try {
    const source = join(staging, "source");
    checkoutSource(source);
    const stagedBinary = join(staging, process.platform === "win32" ? "tsgolint.exe" : "tsgolint");
    buildSource(source, stagedBinary);
    const checksum = sha256(stagedBinary);
    const binary = join(cache, process.platform === "win32" ? "tsgolint.exe" : "tsgolint");
    renameSync(stagedBinary, binary);
    const receipt = join(staging, "sha256");
    writeFileSync(receipt, `${checksum}\n`);
    renameSync(receipt, join(cache, "sha256"));
    return binary;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function buildSource(source: string, output: string): void {
  execFileSync(
    "go",
    [
      "build",
      "-mod=readonly",
      "-modcacherw",
      "-buildvcs=false",
      "-ldflags=-s -w",
      "-trimpath",
      "-o",
      output,
      "./cmd/tsgolint",
    ],
    {
      cwd: source,
      stdio: "inherit",
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: process.platform === "win32" ? "windows" : process.platform,
        GOARCH: process.arch === "x64" ? "amd64" : process.arch,
      },
    },
  );
}

function installChecker(binary: string): void {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const installed = require.resolve(
    `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${suffix}`,
  );
  if (sha256(installed) === sha256(binary)) {
    return;
  }
  const temporary = join(dirname(installed), `.tsgolint-${randomUUID()}${suffix}`);
  try {
    copyFileSync(binary, temporary);
    chmodSync(temporary, 0o755);
    if (sha256(temporary) !== sha256(binary)) {
      throw new Error(
        "Checker copy failed checksum verification; installed binary was not changed.",
      );
    }
    // Same-directory rename publishes only the completely built and verified binary.
    renameSync(temporary, installed);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Prepare the strict native checkers. Requires Git, Go >=1.26, Rust >=1.97, Cargo and a C compiler.\n\nUsage: node scripts/prepare-checker.ts\n       npm run quality:prepare\n\nBuilds immutable upstream sources plus repository corrections, verifies outside-repository\ncaches, and atomically installs the native Oxlint addon and type-aware engine used by\nraw CLI and editor/LSP invocations. Run after npm ci --ignore-scripts and restart existing\nlanguage servers.\n\nExit: 0 prepared/help; 1 missing prerequisites, incompatible version or build failure.",
    );
    return;
  }
  if (args.length > 0) {
    throw new Error(`Unknown arguments: ${args.join(" ")}. Use --help.`);
  }
  prepareOxlint();
  if (!hasDevelopmentChecker()) {
    console.log("Skipped development checker preparation: oxlint-tsgolint is not installed.");
    return;
  }
  checkedVersion();
  const goVersion = checkedGoVersion();
  const patchDigest = createHash("sha256").update(PATCHES.map(sha256).join("\n")).digest("hex");
  const fingerprint = createHash("sha256")
    .update(
      [REVISION, TYPESCRIPT_REVISION, patchDigest, process.platform, process.arch, goVersion].join(
        "\n",
      ),
    )
    .digest("hex");
  const cache = join(homedir(), ".cache", "pi-apply-edits", "tsgolint", fingerprint);
  installChecker(cachedBinary(cache) ?? buildChecker(cache));
  console.log(
    `Prepared tsgolint ${VERSION} (${REVISION.slice(0, 12)} + ${patchDigest.slice(0, 12)}), ${process.platform}/${process.arch}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Checker preparation failed with an unknown error.",
  );
  process.exitCode = 1;
}
