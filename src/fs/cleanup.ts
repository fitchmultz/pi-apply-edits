import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileState } from "./contracts.ts";
import { errorMessage, isCode } from "./errors.ts";
import {
  readStableFile,
  sameIdentity,
  samePublishedState,
  sameSnapshotStats,
} from "./observation.ts";

export function temporaryPath(targetPath: string): string {
  return join(dirname(targetPath), `.pi-apply-edits-${process.pid}-${randomUUID()}.tmp`);
}

export function temporaryDirectoryPath(targetPath: string): string {
  return `${temporaryPath(targetPath)}dir`;
}

/** Removes an unpublished atomic create candidate, then reports the chosen failure. */
export async function discardAtomicCreateCandidate(
  candidate: string,
  stats: BigIntStats,
  error: unknown,
): Promise<never> {
  try {
    await unlinkOwnedPath(candidate, stats, "Atomic create candidate");
  } catch (cleanupError) {
    throw new Error(
      `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
      { cause: cleanupError },
    );
  }
  throw error instanceof Error ? error : new Error(errorMessage(error));
}

export function assertCreatedDirectoryOwner(stats: BigIntStats, path: string): void {
  // Node exposes no mkdirat/openat API. A same-user substitution remains possible before
  // lstat; this check closes cross-user adoption before recording cleanup ownership.
  if (typeof process.geteuid !== "function") {
    return;
  }
  if (stats.uid !== BigInt(process.geteuid())) {
    throw new Error(`Created directory owner changed at ${path}; it was left untouched.`);
  }
}

export async function currentOwnedPath(
  path: string,
  expected: BigIntStats | undefined,
  label: string,
): Promise<BigIntStats | undefined> {
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (!expected || !sameIdentity(expected, current)) {
    throw new Error(`${label} changed identity and was left untouched at ${path}`);
  }
  return current;
}

interface QuarantinedPath {
  readonly path: string;
  readonly directory: string;
  readonly directoryStats: BigIntStats;
  readonly beforeStats: BigIntStats;
  readonly stats: BigIntStats;
}

/** What identity-checked cleanup observed, without collapsing "never there" into "not removed". */
export type CleanupOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "unlinked" }
  | { readonly kind: "moved-elsewhere" };

type QuarantineOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "moved-elsewhere" }
  | { readonly kind: "quarantined"; readonly entry: QuarantinedPath };

async function quarantineOwnedPath(
  path: string,
  expected: BigIntStats | undefined,
  label: string,
): Promise<QuarantineOutcome> {
  const beforeStats = await currentOwnedPath(path, expected, label);
  if (!beforeStats) {
    return { kind: "absent" };
  }
  const directory = temporaryDirectoryPath(path);
  await mkdir(directory, { mode: 0o700 });
  const directoryStats = await lstat(directory, { bigint: true });
  assertCreatedDirectoryOwner(directoryStats, directory);
  const quarantined = join(directory, "entry");
  try {
    await rename(path, quarantined);
  } catch (error) {
    await removeEmptyOwnedDirectory(directory, directoryStats, "Cleanup quarantine");
    if (isCode(error, "ENOENT")) {
      return { kind: "moved-elsewhere" };
    }
    throw error;
  }
  let stats: BigIntStats;
  try {
    stats = await lstat(quarantined, { bigint: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return { kind: "moved-elsewhere" };
    }
    throw error;
  }
  if (!expected || !sameIdentity(expected, stats)) {
    throw new Error(`${label} changed after validation and was preserved at ${quarantined}`);
  }
  return {
    kind: "quarantined",
    entry: { path: quarantined, directory, directoryStats, beforeStats, stats },
  };
}

export async function removeEmptyOwnedDirectory(
  path: string,
  expected: BigIntStats,
  label: string,
): Promise<void> {
  if (await currentOwnedPath(path, expected, label)) {
    await rmdir(path);
  }
}

export async function unlinkOwnedPath(
  path: string,
  expected: BigIntStats | undefined,
  label: string,
  expectedFile?: FileState,
): Promise<CleanupOutcome> {
  const quarantine = await quarantineOwnedPath(path, expected, label);
  if (quarantine.kind !== "quarantined") {
    return quarantine;
  }
  const { entry } = quarantine;
  if (expectedFile) {
    const current = await readStableFile(entry.path);
    if (
      !sameSnapshotStats(expectedFile.stats, entry.beforeStats) ||
      !samePublishedState(expectedFile.stats, current.stats) ||
      !sameSnapshotStats(entry.stats, current.stats) ||
      !expectedFile.bytes.equals(current.bytes)
    ) {
      throw new Error(`${label} changed after verification and was preserved at ${entry.path}`);
    }
  }
  await unlink(entry.path);
  await removeEmptyOwnedDirectory(entry.directory, entry.directoryStats, "Cleanup quarantine");
  return { kind: "unlinked" };
}

export async function rmdirOwnedPath(
  path: string,
  expected: BigIntStats,
  label: string,
): Promise<void> {
  const current = await currentOwnedPath(path, expected, label);
  if (!current) {
    throw new Error(
      `${label} is no longer at ${path}; its location is uncertain and an empty directory may remain elsewhere`,
    );
  }
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`${label} changed identity and was left untouched at ${path}`);
  }
  // Never quarantine an unconfirmed-empty directory: rmdir fails in place if an entry arrives.
  await rmdir(path);
}

export async function assertPublishedDirectoriesCurrent(
  directories: ReadonlyMap<string, BigIntStats>,
): Promise<void> {
  for (const [path, expected] of directories) {
    const current = await currentOwnedPath(path, expected, "Published create directory");
    if (!current || !current.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`Published create directory changed identity at ${path}.`);
    }
  }
}

export async function chmodOwnedDirectory(
  path: string,
  expected: BigIntStats | undefined,
  mode: number,
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const current = await handle.stat({ bigint: true });
    if (!expected || !sameIdentity(expected, current) || !current.isDirectory()) {
      throw new Error(`Published create directory changed identity at ${path}.`);
    }
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}
