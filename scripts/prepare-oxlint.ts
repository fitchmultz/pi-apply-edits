#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.87.0";
const REVISION = "2bd08ebe8f36fcf1954a675ffdeb4c6d0129f609";
const PATCH = fileURLToPath(new URL("../patches/oxlint/import-cycles.patch", import.meta.url));
const require = createRequire(import.meta.url);
const packages: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64-gnu",
  "x86_64-unknown-linux-gnu": "linux-x64-gnu",
  "aarch64-unknown-linux-musl": "linux-arm64-musl",
  "x86_64-unknown-linux-musl": "linux-x64-musl",
  "aarch64-pc-windows-msvc": "win32-arm64-msvc",
  "x86_64-pc-windows-msvc": "win32-x64-msvc",
};

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
function developmentOxlint(): boolean {
  try {
    const metadata: unknown = JSON.parse(
      readFileSync(require.resolve("oxlint/package.json"), "utf8"),
    );
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("version" in metadata) ||
      metadata.version !== VERSION
    ) {
      throw new Error(
        `Native correction requires lockfile-resolved Oxlint ${VERSION}; review before upgrading.`,
      );
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}
function toolchain(): {
  readonly cargo: string;
  readonly rustc: string;
  readonly version: string;
  readonly target: string;
  readonly compiler: string;
} {
  const version = run("rustc", ["--version"]);
  const minor = /^rustc 1\.(\d+)\./u.exec(version)?.[1];
  if (minor === undefined || Number(minor) < 97) {
    throw new Error(
      "Building the native Oxlint correction requires Rust 1.97 or later (qualified with 1.99.0).",
    );
  }
  const target = /^host: (.+)$/mu.exec(run("rustc", ["-vV"]))?.[1];
  if (target === undefined || !Object.hasOwn(packages, target)) {
    throw new Error("The installed Rust host target is not supported by this native correction.");
  }
  const platform = packages[target];
  if (!platform.startsWith(`${process.platform}-${process.arch}`)) {
    throw new Error("Rust's host target must match the Node platform and architecture.");
  }
  const bin = join(run("rustc", ["--print", "sysroot"]), "bin");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const cargo = join(bin, `cargo${suffix}`);
  const rustc = join(bin, `rustc${suffix}`);
  return {
    cargo,
    rustc,
    version: `${version}\n${run(cargo, ["--version"])}`,
    target,
    compiler: run("cc", ["--version"]),
  };
}
function cachedAddon(cache: string): string | undefined {
  const addon = join(cache, "oxlint.node");
  const receipt = join(cache, "sha256");
  if (!existsSync(addon) || !existsSync(receipt)) {
    return;
  }
  if (sha256(addon) !== readFileSync(receipt, "utf8").trim()) {
    throw new Error(
      `Cached native Oxlint failed checksum verification: ${cache}. Remove this cache directory and prepare again.`,
    );
  }
  return addon;
}
function checkout(directory: string): void {
  run("git", ["init", "--quiet", directory]);
  run("git", ["remote", "add", "origin", "https://github.com/oxc-project/oxc.git"], directory);
  run("git", ["fetch", "--quiet", "--depth=1", "origin", REVISION], directory);
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], directory);
  if (run("git", ["rev-parse", "HEAD"], directory) !== REVISION) {
    throw new Error("Fetched Oxlint source does not match the immutable revision.");
  }
  run("git", ["apply", "--check", PATCH], directory);
  run("git", ["apply", PATCH], directory);
}
function libraryName(): string {
  if (process.platform === "darwin") {
    return "liboxlint.dylib";
  }
  return process.platform === "win32" ? "oxlint.dll" : "liboxlint.so";
}
function build(cache: string, tools: ReturnType<typeof toolchain>): string {
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(join(cache, "build-"));
  try {
    const source = join(staging, "source");
    checkout(source);
    const lock = sha256(join(source, "Cargo.lock"));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !/^CARGO_(?:PROFILE_|BUILD_|TARGET_|ENCODED_RUSTFLAGS$)/u.test(name) &&
          !/^RUST(?:FLAGS$|C_)/u.test(name) &&
          !/^(?:(?:HOST|TARGET)_)?(?:CC|CXX|AR|CFLAGS|CXXFLAGS|LDFLAGS)(?:_|$)/u.test(name),
      ),
    );
    execFileSync(
      tools.cargo,
      ["build", "--locked", "--release", "-p", "oxlint", "--lib", "--features", "allocator"],
      {
        cwd: source,
        stdio: "inherit",
        env: { ...env, RUSTC: tools.rustc, CC: "cc", CARGO_TARGET_DIR: join(staging, "target") },
      },
    );
    if (sha256(join(source, "Cargo.lock")) !== lock) {
      throw new Error("Native build changed the immutable Cargo lockfile.");
    }
    const compiled = join(staging, "target", "release", libraryName());
    const checksum = sha256(compiled);
    const addon = join(cache, "oxlint.node");
    renameSync(compiled, addon);
    const receipt = join(staging, "sha256");
    writeFileSync(receipt, `${checksum}\n`);
    renameSync(receipt, join(cache, "sha256"));
    return addon;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
function install(addon: string, target: string): void {
  const installed = require.resolve(`@oxlint/binding-${packages[target]}`);
  if (sha256(installed) === sha256(addon)) {
    return;
  }
  const temporary = join(dirname(installed), `.oxlint-${randomUUID()}.node`);
  try {
    copyFileSync(addon, temporary);
    if (sha256(temporary) !== sha256(addon)) {
      throw new Error(
        "Native addon copy failed checksum verification; installation was not changed.",
      );
    }
    renameSync(temporary, installed);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function prepareOxlint(): void {
  if (!developmentOxlint()) {
    console.log("Skipped native Oxlint preparation: development Oxlint is not installed.");
    return;
  }
  const tools = toolchain();
  const fingerprint = createHash("sha256")
    .update(
      [
        REVISION,
        sha256(PATCH),
        sha256(fileURLToPath(import.meta.url)),
        process.platform,
        process.arch,
        tools.target,
        tools.version,
        tools.compiler,
      ].join("\n"),
    )
    .digest("hex");
  const cache = join(homedir(), ".cache", "pi-apply-edits", "oxlint", fingerprint);
  install(cachedAddon(cache) ?? build(cache, tools), tools.target);
  console.log(`Prepared native Oxlint ${VERSION} (${REVISION.slice(0, 12)}), ${tools.target}.`);
}
function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Prepare the native Oxlint import-cycle correction. Requires Git, Rust >=1.97, Cargo and a C compiler.\n\nUsage: node scripts/prepare-oxlint.ts\n       npm run quality:prepare\n\nBuilds the exact locked upstream NAPI addon plus the repository patch, verifies an outside-repository cache, and atomically installs the addon used by raw Oxlint and its editor/LSP. Run after npm ci --ignore-scripts; restart existing language servers afterward.\n\nExit: 0 prepared/help/production skip; 1 invalid options, missing prerequisites, incompatible version, build or checksum failure.",
    );
    return;
  }
  if (args.length > 0) {
    throw new Error(`Unknown arguments: ${args.join(" ")}. Use --help.`);
  }
  prepareOxlint();
}
const entry = process.argv.at(1);
if (
  entry !== undefined &&
  existsSync(entry) &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native Oxlint preparation failed.");
    process.exitCode = 1;
  }
}
