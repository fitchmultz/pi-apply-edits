import { constants, type BigIntStats } from "node:fs";
import { access, lstat, open, readlink, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertFileAddress, nativeRealpath, operationPath } from "../native-path.ts";
import { assertEntryDeletePathBudget, assertPlannedPathBudget } from "../path-budget.ts";
import type { EntrySnapshot, FileSnapshot } from "./contracts.ts";
import { assertDirectoryWritableForPublish } from "./planning.ts";
import { isCode } from "./errors.ts";
import {
  lstatIfExists,
  sameIdentity,
  sameLinkedSnapshot,
  sameSnapshotStats,
} from "./observation.ts";
import {
  assertNoLinuxCapabilities,
  readPreservableAndroidMetadata,
  replacementSupportInfo,
} from "./platform.ts";

const androidMetadataBySnapshot = new WeakMap<FileSnapshot, string>();

export function androidMetadataForSnapshot(snapshot: FileSnapshot): string | undefined {
  return androidMetadataBySnapshot.get(snapshot);
}

/** Bind the parent but retain a final symlink as an entry instead of following its target. */
export async function captureEntrySnapshot(
  path: string,
  requireWritable = true,
): Promise<EntrySnapshot | undefined> {
  const inputPath = operationPath(path);
  assertFileAddress(inputPath);
  assertPlannedPathBudget(inputPath, [inputPath]);
  const inputStats = await lstatIfExists(inputPath);
  if (!inputStats) {
    return;
  }
  if (!inputStats.isFile() && !inputStats.isSymbolicLink()) {
    throw new Error(`Entry is not a regular file or symbolic link: ${inputPath}`);
  }
  const parentPath = await nativeRealpath(dirname(inputPath));
  const parentStats = await stat(parentPath, { bigint: true });
  const actualPath = join(parentPath, basename(inputPath));
  const stats = await lstat(actualPath, { bigint: true });
  if (!sameSnapshotStats(inputStats, stats)) {
    throw new Error(`Entry changed while reading ${inputPath}`);
  }
  if (requireWritable) {
    assertEntryDeletePathBudget(actualPath, inputPath);
    await assertDirectoryWritableForPublish(parentPath, inputPath);
  }
  const symbolicLink = stats.isSymbolicLink();
  const entry: EntrySnapshot = {
    inputPath,
    actualPath,
    stats,
    parentPath,
    parentStats,
    symbolicLink,
    ...(symbolicLink ? { linkTarget: await readlink(actualPath, { encoding: "buffer" }) } : {}),
  };
  await assertEntryCurrent(entry);
  return entry;
}

export async function assertEntryParentCurrent(entry: EntrySnapshot): Promise<void> {
  const parent = await stat(entry.parentPath, { bigint: true });
  if (
    !sameIdentity(entry.parentStats, parent) ||
    (await nativeRealpath(dirname(entry.inputPath))) !== entry.parentPath
  ) {
    throw new Error(`Entry parent changed before commit: ${entry.inputPath}`);
  }
}

export async function assertEntryCurrent(entry: EntrySnapshot): Promise<void> {
  await assertEntryParentCurrent(entry);
  const current = await lstat(entry.actualPath, { bigint: true });
  if (
    !sameSnapshotStats(entry.stats, current) ||
    (entry.linkTarget &&
      !(await readlink(entry.actualPath, { encoding: "buffer" })).equals(entry.linkTarget))
  ) {
    throw new Error(`Entry changed before commit: ${entry.inputPath}. No changes were written.`);
  }
}

export async function captureSnapshot(
  inputPath: string,
  requireWritable = true,
): Promise<FileSnapshot | undefined> {
  assertFileAddress(inputPath);
  const inputStats = await readInputStats(inputPath);
  if (!inputStats) {
    return;
  }
  const symbolicLink = inputStats.isSymbolicLink();
  let actualPath: string;
  try {
    actualPath = await nativeRealpath(inputPath);
  } catch (error) {
    if (symbolicLink && isCode(error, "ENOENT")) {
      throw new Error(`Refusing to edit dangling symbolic link: ${inputPath}`, { cause: error });
    }
    throw error;
  }
  const observed = await stat(actualPath, { bigint: true });
  if (!observed.isFile()) {
    throw new Error(`Target is not a regular file: ${inputPath}`);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    // A failed stable read must finish and close its descriptor before retrying.
    // oxlint-disable-next-line no-await-in-loop
    const state = await tryReadSnapshot(actualPath, inputPath, requireWritable);
    if (state) {
      return {
        inputPath,
        actualPath,
        inputStats,
        stats: state.stats,
        bytes: state.bytes,
        symbolicLink,
      };
    }
  }
  throw new Error(`File changed while it was being read: ${inputPath}. Re-read and retry.`);
}

async function readInputStats(inputPath: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(inputPath, { bigint: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return;
    }
    if (isCode(error, "ENOTDIR")) {
      throw new Error(
        `Cannot access ${inputPath}: a parent path is not a directory. No changes were written.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function tryReadSnapshot(
  actualPath: string,
  inputPath: string,
  requireWritable: boolean,
): Promise<{ readonly stats: BigIntStats; readonly bytes: Buffer } | undefined> {
  const handle = await open(actualPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error(`Target is not a regular file: ${inputPath}`);
    }
    if (requireWritable) {
      try {
        await access(actualPath, constants.R_OK | constants.W_OK);
      } catch (error) {
        throw new Error(
          `File must be readable and writable: ${inputPath}. No changes were written.`,
          { cause: error },
        );
      }
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (sameSnapshotStats(before, after) && BigInt(bytes.length) === after.size) {
      return { stats: after, bytes };
    }
    return;
  } finally {
    await handle.close();
  }
}

/** Run deterministic replacement refusals during planning, before any member of a batch writes. */
export async function assertSafeToReplace(
  snapshot: FileSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  if ((snapshot.stats.mode & 0o6000n) !== 0n) {
    throw new Error(
      `Refusing to replace setuid or setgid file ${snapshot.inputPath}. No changes were written.`,
    );
  }
  if (snapshot.stats.nlink > 1n) {
    throw new Error(
      `Refusing to atomically replace hard-linked file ${snapshot.inputPath} (link count ${snapshot.stats.nlink.toString()}). No changes were written.`,
    );
  }
  const support = await replacementSupportInfo();
  if (!support.supported) {
    throw new Error(`${support.reason}. No changes were written.`);
  }
  await assertDirectoryWritableForPublish(dirname(snapshot.actualPath), snapshot.inputPath);
  if (process.platform === "linux") {
    await assertNoLinuxCapabilities(snapshot.actualPath, signal);
  } else if (support.strategy === "exchange") {
    androidMetadataBySnapshot.set(
      snapshot,
      await readPreservableAndroidMetadata(snapshot.actualPath, support, signal),
    );
  }
}

export async function assertSnapshotCurrent(snapshot: FileSnapshot): Promise<void> {
  let currentInput: BigIntStats;
  try {
    currentInput = await lstat(snapshot.inputPath, { bigint: true });
  } catch (error) {
    throw new Error(`File changed before commit: ${snapshot.inputPath}. No changes were written.`, {
      cause: error,
    });
  }
  if (!sameIdentity(snapshot.inputStats, currentInput)) {
    throw new Error(
      `File path changed before commit: ${snapshot.inputPath}. No changes were written.`,
    );
  }
  if (snapshot.symbolicLink && (await nativeRealpath(snapshot.inputPath)) !== snapshot.actualPath) {
    throw new Error(
      `Symbolic-link target changed before commit: ${snapshot.inputPath}. No changes were written.`,
    );
  }
  const handle = await open(snapshot.actualPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameSnapshotStats(snapshot.stats, before)) {
      throw new Error(
        `File changed before commit: ${snapshot.inputPath}. No changes were written.`,
      );
    }
    const currentBytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshotStats(before, after) || !currentBytes.equals(snapshot.bytes)) {
      throw new Error(
        `File content changed before commit: ${snapshot.inputPath}. No changes were written.`,
      );
    }
  } finally {
    await handle.close();
  }
}

export async function assertLinkedTargetCurrent(
  snapshot: FileSnapshot,
  linkedBaseline?: BigIntStats,
): Promise<BigIntStats> {
  await assertLinkedInputCurrent(snapshot);
  const current = await assertLinkedActualCurrent(snapshot, linkedBaseline);
  await assertLinkedInputCurrent(snapshot);
  return current;
}

async function assertLinkedInputCurrent(snapshot: FileSnapshot): Promise<void> {
  const currentInput = await lstat(snapshot.inputPath, { bigint: true }).catch(() => {
    // Missing or inaccessible entries fail the following identity guard closed.
  });
  if (!currentInput || !sameIdentity(snapshot.inputStats, currentInput)) {
    throw new Error(
      `File path changed before commit: ${snapshot.inputPath}. No changes were written.`,
    );
  }
  if (snapshot.symbolicLink && (await nativeRealpath(snapshot.inputPath)) !== snapshot.actualPath) {
    throw new Error(
      `Symbolic-link target changed before commit: ${snapshot.inputPath}. No changes were written.`,
    );
  }
}

async function assertLinkedActualCurrent(
  snapshot: FileSnapshot,
  linkedBaseline?: BigIntStats,
): Promise<BigIntStats> {
  const pathStats = await lstat(snapshot.actualPath, { bigint: true }).catch(() => {
    // Missing or inaccessible entries fail the following identity guard closed.
  });
  const matchesExpected =
    pathStats &&
    (linkedBaseline
      ? sameSnapshotStats(linkedBaseline, pathStats)
      : sameLinkedSnapshot(snapshot.stats, pathStats));
  if (matchesExpected !== true) {
    throw new Error(
      `File path changed before commit: ${snapshot.inputPath}. No changes were written.`,
    );
  }
  const handle = await open(snapshot.actualPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const handleMatches = linkedBaseline
      ? sameSnapshotStats(linkedBaseline, before)
      : sameLinkedSnapshot(snapshot.stats, before);
    if (!handleMatches) {
      throw new Error(
        `File changed before commit: ${snapshot.inputPath}. No changes were written.`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshotStats(before, after) || !bytes.equals(snapshot.bytes)) {
      throw new Error(
        `File content changed before commit: ${snapshot.inputPath}. No changes were written.`,
      );
    }
    return after;
  } finally {
    await handle.close();
  }
}
