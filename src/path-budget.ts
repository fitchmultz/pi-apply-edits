import { basename, dirname, join } from "node:path";
import type { NewFilePlan } from "./file-system.ts";

const PATH_UUID_SHAPE = "00000000-0000-4000-8000-000000000000";

function pathBudget(): { platform: string; limit: number; margin: number } {
  if (process.platform === "darwin") return { platform: "macOS", limit: 1024, margin: 32 };
  if (process.platform === "linux" || process.platform === "android") {
    return { platform: process.platform === "android" ? "Android" : "Linux", limit: 4096, margin: 32 };
  }
  if (process.platform === "win32") return { platform: "Windows", limit: 32767, margin: 64 };
  return { platform: process.platform, limit: 1024, margin: 32 };
}

function pathUnits(path: string): number {
  return process.platform === "win32" ? path.length : Buffer.byteLength(path);
}

function shapedTemporaryPath(targetPath: string): string {
  return join(
    dirname(targetPath),
    `.pi-apply-edits-${process.pid}-${PATH_UUID_SHAPE}.tmp`,
  );
}

function shapedTemporaryDirectory(targetPath: string): string {
  return `${shapedTemporaryPath(targetPath)}dir`;
}

function shapedCleanupEntry(path: string): string {
  return join(shapedTemporaryDirectory(path), "entry");
}

export function assertPlannedPathBudget(displayPath: string, candidates: string[]): void {
  const budget = pathBudget();
  const longest = Math.max(...candidates.map(pathUnits));
  const supportedMaximum = budget.limit - budget.margin - 1;
  if (longest <= supportedMaximum) return;
  throw new Error(
    `Cannot modify ${displayPath}: planned staging and cleanup require a ${longest}-` +
      `${process.platform === "win32" ? "character" : "byte"} path, beyond the supported ` +
      `${supportedMaximum} ${process.platform === "win32" ? "characters" : "bytes"} on ` +
      `${budget.platform} (${budget.margin}-unit safety margin below PATH_MAX ${budget.limit}). ` +
      "No changes were written.",
  );
}

export function assertReplacementPathBudget(targetPath: string, displayPath: string): void {
  const temporaryDirectory = shapedTemporaryDirectory(targetPath);
  const temporary = join(temporaryDirectory, "replacement");
  const recovery = shapedTemporaryPath(targetPath);
  assertPlannedPathBudget(displayPath, [
    targetPath,
    temporaryDirectory,
    temporary,
    recovery,
    shapedCleanupEntry(temporary),
    shapedCleanupEntry(recovery),
  ]);
}

export function assertCreatePathBudget(plan: NewFilePlan, displayPath: string): void {
  if (plan.missingDirectories.length > 0) {
    const container = join(plan.ancestorPath, `.pi-apply-edits-${PATH_UUID_SHAPE}.tmpdir`);
    const staging = join(container, "publish");
    assertPlannedPathBudget(displayPath, [
      plan.targetPath,
      container,
      join(container, "q"),
      join(staging, ...plan.missingDirectories.slice(1), basename(plan.targetPath)),
      shapedCleanupEntry(plan.targetPath),
    ]);
    return;
  }
  const temporaryDirectory = shapedTemporaryDirectory(plan.targetPath);
  const temporary = join(temporaryDirectory, "create");
  assertPlannedPathBudget(displayPath, [
    plan.targetPath,
    temporaryDirectory,
    temporary,
    shapedCleanupEntry(temporary),
  ]);
}

export function assertEntryDeletePathBudget(targetPath: string, displayPath: string): void {
  const retained = shapedCleanupEntry(targetPath);
  assertPlannedPathBudget(displayPath, [targetPath, retained, shapedCleanupEntry(retained)]);
}

export function assertEntryMovePathBudget(sourcePath: string, destination: NewFilePlan, displayPath: string): void {
  assertEntryDeletePathBudget(sourcePath, displayPath);
  const sourceCandidate = join(shapedTemporaryDirectory(sourcePath), "move");
  const sourceProbe = shapedTemporaryPath(sourcePath);
  const destinationProbe = shapedTemporaryPath(join(destination.ancestorPath, "probe"));
  assertPlannedPathBudget(displayPath, [
    sourceCandidate,
    shapedCleanupEntry(sourceCandidate),
    sourceProbe,
    shapedCleanupEntry(sourceProbe),
    destination.targetPath,
    destinationProbe,
    shapedCleanupEntry(destinationProbe),
  ]);
  if (destination.missingDirectories.length > 0) {
    assertCreatePathBudget(destination, destination.inputPath);
  }
}
