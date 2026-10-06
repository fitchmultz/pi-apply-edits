import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { access, mkdtemp, readFile, rm, unlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AndroidReplacementSupport, ReplacementSupport } from "./contracts.ts";
import { AtomicMoveUncertainError, errorMessage } from "./errors.ts";
import { lstatIfExists, sameIdentity, sameSnapshotStats } from "./observation.ts";

export function execText(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8", signal }, (error, stdout) => {
      if (error instanceof Error) {
        reject(error);
      } else if (error !== null) {
        reject(new Error(errorMessage(error), { cause: error }));
      } else {
        resolve(stdout);
      }
    });
  });
}

let cachedReplacementSupport: Promise<ReplacementSupport> | undefined;

export async function supportsExistingFileReplacement(): Promise<boolean> {
  return (await replacementSupportInfo()).supported;
}

export function replacementSupportInfo(): Promise<ReplacementSupport> {
  cachedReplacementSupport ??= detectReplacementSupport();
  return cachedReplacementSupport;
}

async function executableAvailable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    // Conventional locations are tried in precedence order, stopping at the first executable.
    // oxlint-disable-next-line no-await-in-loop
    if (await executableAvailable(candidate)) {
      return candidate;
    }
  }
  return;
}

async function detectReplacementSupport(): Promise<ReplacementSupport> {
  if (process.platform === "android") {
    return detectAndroidReplacementSupport();
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      supported: false,
      reason: `Atomic metadata-preserving replacement is not supported on ${process.platform}`,
    };
  }
  if (!(await executableAvailable("/bin/cp"))) {
    return { supported: false, reason: "Atomic replacement requires executable /bin/cp" };
  }
  if (process.platform === "darwin") {
    if (!(await executableAvailable("/usr/bin/osascript"))) {
      return {
        supported: false,
        reason: "ACL-preserving replacement requires executable /usr/bin/osascript",
      };
    }
    return { supported: true, strategy: "hard-link", cp: "/bin/cp" };
  }
  return detectLinuxReplacementSupport();
}

async function detectLinuxReplacementSupport(): Promise<ReplacementSupport> {
  const getcap = await firstExecutable([
    "/usr/sbin/getcap",
    "/sbin/getcap",
    "/usr/bin/getcap",
    "/bin/getcap",
  ]);
  if (getcap === undefined) {
    return {
      supported: false,
      reason: "Cannot verify Linux file capabilities because getcap is unavailable",
    };
  }
  try {
    const version = await execText("/bin/cp", ["--version"]);
    if (!version.includes("GNU coreutils")) {
      return { supported: false, reason: "Atomic replacement on Linux requires GNU cp" };
    }
  } catch {
    return { supported: false, reason: "Atomic replacement on Linux requires GNU cp" };
  }
  return { supported: true, strategy: "hard-link", cp: "/bin/cp", getcap };
}

async function detectAndroidReplacementSupport(): Promise<ReplacementSupport> {
  const bin = dirname(process.execPath);
  const cp = join(bin, "cp");
  const mv = join(bin, "mv");
  const getfacl = join(bin, "getfacl");
  const getfattr = join(bin, "getfattr");
  for (const executable of [cp, mv, getfacl, getfattr]) {
    // Return the first missing capability in stable executable order.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await executableAvailable(executable))) {
      return {
        supported: false,
        reason: `Atomic replacement on Android/Termux requires executable ${executable}`,
      };
    }
  }
  try {
    const [cpVersion, mvVersion] = await Promise.all([
      execText(cp, ["--version"]),
      execText(mv, ["--version"]),
    ]);
    if (!cpVersion.includes("GNU coreutils") || !mvVersion.includes("GNU coreutils")) {
      throw new Error("GNU coreutils cp and mv are required");
    }
    await probeAndroidAtomicMoves(mv);
  } catch (error) {
    return {
      supported: false,
      reason: `Atomic replacement on Android/Termux is unavailable: ${errorMessage(error)}`,
    };
  }
  return { supported: true, strategy: "exchange", cp, mv, getfacl, getfattr };
}

async function probeAndroidAtomicMoves(mv: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-apply-edits-mv-"));
  try {
    const left = join(directory, "left");
    const right = join(directory, "right");
    await writeFile(left, "left");
    await writeFile(right, "right");
    await execText(mv, ["--exchange", "--", left, right]);
    if ((await readFile(left, "utf8")) !== "right" || (await readFile(right, "utf8")) !== "left") {
      throw new Error("mv --exchange did not exchange files");
    }
    await probeAndroidNoClobber(mv, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function probeAndroidNoClobber(mv: string, directory: string): Promise<void> {
  const source = join(directory, "source");
  const target = join(directory, "target");
  await writeFile(source, "source");
  await writeFile(target, "target");
  await execText(mv, ["--no-clobber", "--", source, target]);
  if (
    (await readFile(source, "utf8")) !== "source" ||
    (await readFile(target, "utf8")) !== "target"
  ) {
    throw new Error("mv --no-clobber replaced an existing file");
  }
  await unlink(target);
  await execText(mv, ["--no-clobber", "--", source, target]);
  if ((await readFile(target, "utf8")) !== "source" || (await lstatIfExists(source))) {
    throw new Error("mv --no-clobber did not publish a missing file");
  }
}

export async function transferMacosAcl(
  source: string,
  target: string,
  mode: "inherit" | "copy",
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  await execText(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      fileURLToPath(new URL("../macos-acl.js", import.meta.url)),
      mode,
      source,
      target,
    ],
    signal,
  );
}

export async function readPreservableAndroidMetadata(
  path: string,
  support: AndroidReplacementSupport,
  signal?: AbortSignal,
): Promise<string> {
  const [xattrOutput, aclOutput] = await Promise.all([
    execText(
      support.getfattr,
      ["--absolute-names", "--dump", "--encoding=hex", "-m", ".", "--", path],
      signal,
    ),
    execText(support.getfacl, ["--absolute-names", "--omit-header", "--", path], signal),
  ]);
  const xattrs = xattrOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const unsupportedXattrs = xattrs.filter((line) => !line.startsWith("security.selinux="));
  if (unsupportedXattrs.length > 0) {
    throw new Error(
      `Refusing to replace ${path}: Termux cp cannot preserve extended attribute${unsupportedXattrs.length === 1 ? "" : "s"} ` +
        unsupportedXattrs.map((line) => line.slice(0, line.indexOf("="))).join(", "),
    );
  }
  const acl = aclOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((left, right) => (left < right ? -1 : Number(left > right)));
  if (
    acl.length !== 3 ||
    acl.some((line) => !/^(?:user::|group::|other::)[r-][w-][x-]$/.test(line))
  ) {
    throw new Error(`Refusing to replace ${path}: Termux cp cannot preserve its extended ACL`);
  }
  return `${xattrs.sort((left, right) => (left < right ? -1 : Number(left > right))).join("\n")}\n${acl.join("\n")}`;
}

export async function cloneWithMetadata(
  source: string,
  target: string,
  signal?: AbortSignal,
  expectedAndroidMetadata?: string,
): Promise<void> {
  const support = await replacementSupportInfo();
  if (!support.supported) {
    throw new Error(support.reason);
  }
  // Explicit xattr routes Linux labels through strict native copying, unlike best-effort `all`.
  const args =
    process.platform === "darwin"
      ? ["-p", source, target]
      : [
          process.platform === "linux"
            ? "--preserve=mode,ownership,timestamps,links,xattr"
            : "--preserve=all",
          "--",
          source,
          target,
        ];
  await execText(support.cp, args, signal);
  await transferMacosAcl(source, target, "copy", signal);
  if (support.strategy === "exchange") {
    const sourceMetadata =
      expectedAndroidMetadata ?? (await readPreservableAndroidMetadata(source, support, signal));
    const targetMetadata = await readPreservableAndroidMetadata(target, support, signal);
    if (sourceMetadata !== targetMetadata) {
      throw new Error(`Termux could not preserve ACL or SELinux metadata for ${source}`);
    }
  }
}

export async function assertNoLinuxCapabilities(path: string, signal?: AbortSignal): Promise<void> {
  const support = await replacementSupportInfo();
  if (!support.supported || support.strategy !== "hard-link" || support.getcap === undefined) {
    throw new Error("Cannot verify Linux file capabilities because getcap is unavailable");
  }
  const output = await execText(support.getcap, ["-n", path], signal);
  if (output.trim().length > 0) {
    throw new Error(`Refusing to replace capability-bearing Linux file ${path}`);
  }
}

export async function linkEntry(
  source: string,
  target: string,
  symbolicLink: boolean,
): Promise<void> {
  if (process.platform !== "darwin" || !symbolicLink) {
    return link(source, target);
  }
  // macOS link(2) follows symlinks; linkat(2) flags=0 links the entry itself.
  let result: string;
  try {
    result = await execText("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      `
      ObjC.import("Foundation");
      ObjC.bindFunction("linkat", ["int", ["int", "char *", "int", "char *", "int"]]);
      ObjC.bindFunction("__error", ["int *", []]);
      ObjC.bindFunction("strerror", ["char *", ["int"]]);
      function run(args) {
        return $.linkat(-2, args[0], -2, args[1], 0) === 0 ? "linked" : $.strerror($.__error()[0]);
      }
    `,
      source,
      target,
    ]);
  } catch (error) {
    throw new AtomicMoveUncertainError(
      `Entry link publication could not be verified: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (result.trim() !== "linked") {
    throw new Error(`Could not link entry ${source} to ${target}: ${result.trim()}`);
  }
}

function pairMatches(
  source: BigIntStats | undefined,
  target: BigIntStats | undefined,
  expectedSource: BigIntStats,
  expectedTarget: BigIntStats,
): boolean {
  return (
    source !== undefined &&
    target !== undefined &&
    sameIdentity(source, expectedSource) &&
    sameIdentity(target, expectedTarget)
  );
}

function moveComplete(
  source: BigIntStats | undefined,
  target: BigIntStats | undefined,
  expectedSource: BigIntStats,
): boolean {
  return source === undefined && target !== undefined && sameIdentity(target, expectedSource);
}

function sourceUnchanged(source: BigIntStats | undefined, expected: BigIntStats): boolean {
  return source !== undefined && sameSnapshotStats(source, expected);
}

export async function exchangePreparedFiles(
  source: string,
  target: string,
  expectedSource: BigIntStats,
  expectedTarget: BigIntStats,
): Promise<void> {
  const support = await replacementSupportInfo();
  if (!support.supported || support.strategy !== "exchange") {
    throw new Error("Atomic file exchange is unavailable");
  }
  let commandError: Error | undefined;
  try {
    await execText(support.mv, ["--exchange", "--", source, target]);
  } catch (error) {
    commandError =
      error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
  }
  const [currentSource, currentTarget] = await Promise.all([
    lstatIfExists(source),
    lstatIfExists(target),
  ]);
  if (pairMatches(currentSource, currentTarget, expectedTarget, expectedSource)) {
    return;
  }
  if (commandError && pairMatches(currentSource, currentTarget, expectedSource, expectedTarget)) {
    throw commandError;
  }
  throw new AtomicMoveUncertainError(
    `Atomic exchange could not be verified. Commit status is uncertain; inspect ${source} and ${target}`,
    { cause: commandError },
  );
}

export async function movePreparedFileNoReplace(
  source: string,
  target: string,
  expectedSource: BigIntStats,
): Promise<boolean> {
  const support = await replacementSupportInfo();
  if (!support.supported || support.strategy !== "exchange") {
    throw new Error("Atomic no-clobber publication is unavailable");
  }
  let commandError: Error | undefined;
  try {
    await execText(support.mv, ["--no-clobber", "--", source, target]);
  } catch (error) {
    commandError =
      error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
  }
  const [currentSource, currentTarget] = await Promise.all([
    lstatIfExists(source),
    lstatIfExists(target),
  ]);
  if (moveComplete(currentSource, currentTarget, expectedSource)) {
    return true;
  }
  if (sourceUnchanged(currentSource, expectedSource)) {
    if (currentTarget) {
      return false;
    }
    if (commandError) {
      throw commandError;
    }
  }
  throw new AtomicMoveUncertainError(
    `Atomic no-clobber publication changed during publication or could not be verified. Commit status is uncertain; inspect ${source} and ${target}`,
    { cause: commandError },
  );
}
