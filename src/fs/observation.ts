import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileState } from "./contracts.ts";
import { errorMessage, isCode } from "./errors.ts";

export function samePreservedMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

export function samePublishedState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

export function sameLinkedSnapshot(snapshot: BigIntStats, linked: BigIntStats): boolean {
  return (
    snapshot.dev === linked.dev &&
    snapshot.ino === linked.ino &&
    snapshot.size === linked.size &&
    snapshot.mtimeNs === linked.mtimeNs &&
    snapshot.mode === linked.mode &&
    snapshot.uid === linked.uid &&
    snapshot.gid === linked.gid &&
    snapshot.nlink + 1n === linked.nlink
  );
}

export function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isSymbolicLink() === right.isSymbolicLink()
  );
}

export function sameSnapshotStats(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

export async function lstatIfExists(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

export async function readStableRegularEntry(path: string): Promise<FileState> {
  const entryBefore = await lstat(path, { bigint: true });
  if (!entryBefore.isFile() || entryBefore.isSymbolicLink()) {
    throw new Error(`Created file path changed during publication: ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameSnapshotStats(entryBefore, before)) {
      throw new Error(`Created file path changed during publication: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const entryAfter = await lstat(path, { bigint: true });
    if (!sameSnapshotStats(before, after) || !sameSnapshotStats(after, entryAfter)) {
      throw new Error(`Created file changed during publication: ${path}`);
    }
    return { stats: after, bytes };
  } finally {
    await handle.close();
  }
}

export async function readStableFile(path: string): Promise<FileState> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathStats = await lstat(path, { bigint: true });
    if (!sameSnapshotStats(before, after) || !sameIdentity(after, pathStats)) {
      throw new Error(`File changed while verifying ${path}`);
    }
    return { stats: after, bytes };
  } finally {
    await handle.close();
  }
}

export async function assertPreparedFileCurrent(
  path: string,
  expected: BigIntStats | undefined,
  bytes: Buffer,
  label: string,
): Promise<void> {
  if (!expected) {
    throw new Error(`${label} identity was not recorded. No changes were written.`);
  }
  const current = await readStableFile(path);
  if (!sameSnapshotStats(expected, current.stats) || !current.bytes.equals(bytes)) {
    throw new Error(`${label} changed before commit: ${path}. No changes were written.`);
  }
}

export async function syncDirectory(directory: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    return;
  }
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  } catch (error) {
    return `The edit was committed, but the parent directory could not be synced: ${errorMessage(error)}`;
  }
}
