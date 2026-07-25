import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface FileSnapshot {
  inputPath: string;
  actualPath: string;
  inputStats: BigIntStats;
  stats: BigIntStats;
  bytes: Buffer;
  symbolicLink: boolean;
}

export interface ReplacementPublishHooks {
  afterRename?: (paths: { target: string; recovery: string }) => void | Promise<void>;
  beforeConflictReturn?: (paths: { target: string; recovery: string }) => void | Promise<void>;
  beforeRecoveryCleanup?: (paths: { target: string; recovery: string }) => void | Promise<void>;
}

export interface NewFilePlan {
  inputPath: string;
  targetPath: string;
  ancestorPath: string;
  ancestorDev: bigint;
  ancestorIno: bigint;
  missingDirectories: string[];
}

export interface NewFilePublishHooks {
  beforeDirectoryPublish?: (paths: { staging: string; target: string }) => void | Promise<void>;
}

export interface PlannedNewFile {
  plan: NewFilePlan;
  bytes: Buffer;
}

export interface PreparedNestedFiles {
  entries: PlannedNewFile[];
  firstPlan: NewFilePlan;
  publishRoot: string;
  staging: string;
  stagingParent: string;
  warnings: string[];
  hooks?: NewFilePublishHooks;
  published: boolean;
}

export async function captureSnapshot(inputPath: string): Promise<FileSnapshot | undefined> {
  let inputStats: BigIntStats;
  try {
    inputStats = await lstat(inputPath, { bigint: true });
  } catch (error) {
    // Only a true missing path is creatable. ENOTDIR means a parent is a non-directory.
    if (isCode(error, "ENOENT")) return undefined;
    if (isCode(error, "ENOTDIR")) {
      throw new Error(`Cannot access ${inputPath}: a parent path is not a directory. No changes were written.`);
    }
    throw error;
  }

  const symbolicLink = inputStats.isSymbolicLink();
  let actualPath = inputPath;
  if (symbolicLink) {
    try {
      actualPath = await realpath(inputPath);
    } catch (error) {
      if (isCode(error, "ENOENT")) throw new Error(`Refusing to edit dangling symbolic link: ${inputPath}`);
      throw error;
    }
  }

  const observed = await stat(actualPath, { bigint: true });
  if (!observed.isFile()) throw new Error(`Target is not a regular file: ${inputPath}`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = await open(actualPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error(`Target is not a regular file: ${inputPath}`);
      try {
        await access(actualPath, constants.R_OK | constants.W_OK);
      } catch {
        throw new Error(`File must be readable and writable: ${inputPath}. No changes were written.`);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (sameSnapshotStats(before, after) && BigInt(bytes.length) === after.size) {
        return { inputPath, actualPath, inputStats, stats: after, bytes, symbolicLink };
      }
    } finally {
      await handle.close();
    }
  }
  throw new Error(`File changed while it was being read: ${inputPath}. Re-read and retry.`);
}

/** Deterministic replacement refusals. Safe to call during plan so multi-file batches fail closed before any write. */
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
      `Refusing to atomically replace hard-linked file ${snapshot.inputPath} ` +
        `(link count ${snapshot.stats.nlink}). No changes were written.`,
    );
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Atomic metadata-preserving replacement is not supported on ${process.platform}. No changes were written.`,
    );
  }
  await assertDirectoryWritableForPublish(dirname(snapshot.actualPath), snapshot.inputPath);
  if (process.platform === "linux") {
    await assertNoLinuxCapabilities(snapshot.actualPath, signal);
  }
}

/** Bind a missing create target to the canonical parent validated during planning. */
export async function planNewFile(targetPath: string): Promise<NewFilePlan> {
  const inputPath = resolve(targetPath);
  const targetName = basename(inputPath);
  const missingDirectories: string[] = [];
  let current = dirname(inputPath);

  while (true) {
    let currentStats: BigIntStats;
    try {
      currentStats = await lstat(current, { bigint: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        const parent = dirname(current);
        if (parent === current) {
          throw new Error(
            `Cannot create ${targetPath}: no existing parent directory. No changes were written.`,
          );
        }
        missingDirectories.unshift(basename(current));
        current = parent;
        continue;
      }
      if (isCode(error, "ENOTDIR")) {
        throw new Error(
          `Cannot create ${targetPath}: a parent path is not a directory. No changes were written.`,
        );
      }
      throw error;
    }

    let ancestorPath: string;
    try {
      ancestorPath = await realpath(current);
    } catch (error) {
      if (currentStats.isSymbolicLink() && isCode(error, "ENOENT")) {
        throw new Error(
          `Cannot create ${targetPath}: a parent path is a dangling symbolic link. No changes were written.`,
        );
      }
      throw error;
    }
    const ancestorStats = await stat(ancestorPath, { bigint: true });
    if (!ancestorStats.isDirectory()) {
      throw new Error(
        `Cannot create ${targetPath}: a parent path is not a directory. No changes were written.`,
      );
    }
    await assertDirectoryWritableForPublish(ancestorPath, targetPath);
    return {
      inputPath,
      targetPath: join(ancestorPath, ...missingDirectories, targetName),
      ancestorPath,
      ancestorDev: ancestorStats.dev,
      ancestorIno: ancestorStats.ino,
      missingDirectories,
    };
  }
}

async function assertNewFilePlanCurrent(plan: NewFilePlan): Promise<void> {
  const ancestor = await stat(plan.ancestorPath, { bigint: true });
  if (
    !ancestor.isDirectory() ||
    ancestor.dev !== plan.ancestorDev ||
    ancestor.ino !== plan.ancestorIno
  ) {
    throw new Error(
      `Create parent changed after planning ${plan.inputPath}. No changes were written.`,
    );
  }
  await assertDirectoryWritableForPublish(plan.ancestorPath, plan.inputPath);

  let current = plan.ancestorPath;
  for (const part of plan.missingDirectories) {
    current = join(current, part);
    try {
      const stats = await lstat(current, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Create parent changed after planning ${plan.inputPath}. No changes were written.`,
        );
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) break;
      throw error;
    }
  }
}

async function assertDirectoryWritableForPublish(directoryPath: string, labelPath: string): Promise<void> {
  try {
    await access(directoryPath, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(
      `Directory must be writable to publish ${labelPath} (${directoryPath}). No changes were written.`,
    );
  }
}

export async function publishReplacement(
  snapshot: FileSnapshot,
  bytes: Buffer,
  signal?: AbortSignal,
  hooks?: ReplacementPublishHooks,
): Promise<string[]> {
  await assertSafeToReplace(snapshot, signal);

  const directory = dirname(snapshot.actualPath);
  const temporary = temporaryPath(snapshot.actualPath);
  const recovery = temporaryPath(snapshot.actualPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryStats: BigIntStats | undefined;
  let recoveryLinked = false;
  let replacementPublished = false;
  let published = false;
  let failure: unknown;
  const warnings: string[] = [];
  try {
    try {
      await cloneWithMetadata(snapshot.actualPath, temporary, signal);
    } catch (error) {
      throwIfAborted(signal);
      throw new Error(
        `Could not prepare an atomic metadata-preserving replacement for ${snapshot.inputPath}: ` +
          `${errorMessage(error)}. No changes were written.`,
      );
    }
    handle = await open(temporary, "r+");
    const clonedStats = await handle.stat({ bigint: true });
    if (!samePreservedMetadata(snapshot.stats, clonedStats)) {
      throw new Error(`Could not preserve file metadata for ${snapshot.inputPath}. No changes were written.`);
    }
    await handle.truncate(0);
    await handle.writeFile(bytes);
    await handle.sync();
    temporaryStats = await handle.stat({ bigint: true });
    if (!samePreservedMetadata(snapshot.stats, temporaryStats)) {
      throw new Error(`File metadata changed while preparing ${snapshot.inputPath}. No changes were written.`);
    }
    if (process.platform === "linux") await assertNoLinuxCapabilities(temporary, signal);
    await handle.close();
    handle = undefined;

    throwIfAborted(signal);
    const currentTemporary = await lstat(temporary, { bigint: true });
    if (!temporaryStats || !sameSnapshotStats(temporaryStats, currentTemporary)) {
      throw new Error(`Temporary file changed before commit: ${temporary}. No changes were written.`);
    }
    // ponytail: Node has no portable compare-and-swap rename. A recovery link protects in-place
    // external writes; use a platform exchange primitive if atomic-replacement races are observed.
    await assertSnapshotCurrent(snapshot);
    await link(snapshot.actualPath, recovery);
    recoveryLinked = true;
    await assertLinkedTargetCurrent(snapshot);
    throwIfAborted(signal);
    await rename(temporary, snapshot.actualPath);
    replacementPublished = true;

    let recoveryBytes: Buffer;
    let publishedStats: BigIntStats;
    let publishedBytes: Buffer;
    try {
      await hooks?.afterRename?.({ target: snapshot.actualPath, recovery });
      recoveryBytes = (await readStableFile(recovery)).bytes;
      const publishedState = await readStableFile(snapshot.actualPath);
      publishedStats = publishedState.stats;
      publishedBytes = publishedState.bytes;
    } catch (error) {
      throw new Error(
        `Atomic replacement reached ${snapshot.inputPath}, but verification failed. Commit status is uncertain; ` +
          `inspect the target and recovery path ${recovery}. Cause: ${errorMessage(error)}`,
      );
    }

    const targetMatchesPrepared =
      temporaryStats !== undefined &&
      samePublishedState(temporaryStats, publishedStats) &&
      publishedBytes.equals(bytes);
    if (!recoveryBytes.equals(snapshot.bytes)) {
      try {
        await hooks?.beforeConflictReturn?.({ target: snapshot.actualPath, recovery });
      } catch (error) {
        throw new Error(
          `File conflict handling failed for ${snapshot.inputPath}. Commit status is uncertain; ` +
            `inspect the target and recovery path ${recovery}. Cause: ${errorMessage(error)}`,
        );
      }
      throw new Error(
        `File versions changed during commit: ${snapshot.inputPath}. No automatic rollback was attempted; ` +
          `the current target was left untouched, and the earlier external content remains at ${recovery}.`,
      );
    }

    if (!targetMatchesPrepared) {
      throw new Error(
        `File changed immediately after commit: ${snapshot.inputPath}. The external content was kept, and ` +
          `the pre-edit content remains at ${recovery}. Retry after inspecting both files.`,
      );
    }

    published = true;
    try {
      await hooks?.beforeRecoveryCleanup?.({ target: snapshot.actualPath, recovery });
    } catch (error) {
      throw new Error(
        `The edit was verified committed to ${snapshot.inputPath}, but recovery cleanup did not run. ` +
          `The previous content remains at ${recovery}. Cause: ${errorMessage(error)}`,
      );
    }
    try {
      await unlink(recovery);
      recoveryLinked = false;
    } catch (error) {
      warnings.push(`The edit was committed, but its recovery link remains at ${recovery}: ${errorMessage(error)}`);
    }
    const warning = await syncDirectory(directory);
    if (warning) warnings.push(warning);
    return warnings;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    const cleanupFailures: string[] = [];
    if (!published && !replacementPublished) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isCode(error, "ENOENT")) cleanupFailures.push(`${temporary}: ${errorMessage(error)}`);
      }
    }
    if (recoveryLinked && !replacementPublished) {
      try {
        await unlink(recovery);
      } catch (error) {
        if (!isCode(error, "ENOENT")) cleanupFailures.push(`${recovery}: ${errorMessage(error)}`);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new Error(
        `${failure ? `${errorMessage(failure)} ` : ""}Cleanup was incomplete: ${cleanupFailures.join("; ")}`,
      );
    }
  }
}

export async function preparePlannedNestedFiles(
  entries: PlannedNewFile[],
  signal?: AbortSignal,
  hooks?: NewFilePublishHooks,
): Promise<PreparedNestedFiles> {
  const firstPlan = entries[0]?.plan;
  const firstMissing = firstPlan?.missingDirectories[0];
  if (!firstPlan || !firstMissing || entries.length === 0) {
    throw new Error("Nested create publication requires at least one valid plan");
  }
  for (const { plan } of entries) {
    if (
      plan.ancestorPath !== firstPlan.ancestorPath ||
      plan.missingDirectories[0] !== firstMissing
    ) {
      throw new Error("Nested create publication plans must share one missing root");
    }
  }

  const ancestorParent = dirname(firstPlan.ancestorPath);
  let stagingParent = firstPlan.ancestorPath;
  try {
    const parentStats = await stat(ancestorParent, { bigint: true });
    if (parentStats.dev === firstPlan.ancestorDev) {
      await access(ancestorParent, constants.W_OK | constants.X_OK);
      stagingParent = ancestorParent;
    }
  } catch {
    // A mount root or non-writable parent must stage inside the verified ancestor.
  }

  const prepared: PreparedNestedFiles = {
    entries,
    firstPlan,
    publishRoot: join(firstPlan.ancestorPath, firstMissing),
    staging: join(stagingParent, `.pi-apply-edits-${randomUUID()}.tmpdir`),
    stagingParent,
    warnings: [],
    hooks,
    published: false,
  };
  const stagedDirectories = new Set<string>();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    throwIfAborted(signal);
    for (const { plan } of entries) await assertNewFilePlanCurrent(plan);
    await mkdir(prepared.staging);

    for (const { plan, bytes } of entries) {
      const stagedDirectory = join(prepared.staging, ...plan.missingDirectories.slice(1));
      if (stagedDirectory !== prepared.staging) await mkdir(stagedDirectory, { recursive: true });
      stagedDirectories.add(stagedDirectory);
      const stagedTarget = join(stagedDirectory, basename(plan.targetPath));
      handle = await open(stagedTarget, "wx", 0o666);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
    }

    for (const directory of stagedDirectories) {
      const warning = await syncDirectory(directory);
      if (warning) prepared.warnings.push(warning);
    }
    return prepared;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    try {
      await discardPreparedNestedFiles(prepared);
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

export async function publishPreparedNestedFiles(
  prepared: PreparedNestedFiles,
  signal?: AbortSignal,
): Promise<string[]> {
  const { entries, firstPlan, publishRoot, staging } = prepared;
  try {
    await prepared.hooks?.beforeDirectoryPublish?.({ staging, target: publishRoot });
    throwIfAborted(signal);
    for (const { plan } of entries) await assertNewFilePlanCurrent(plan);
    try {
      await lstat(publishRoot);
      throw new Error(
        `Create parent changed after planning ${firstPlan.inputPath}. No changes were written.`,
      );
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }

    try {
      await rename(staging, publishRoot);
      prepared.published = true;
    } catch (error) {
      if (
        isCode(error, "EEXIST") ||
        isCode(error, "ENOTEMPTY") ||
        isCode(error, "ENOTDIR") ||
        isCode(error, "EISDIR")
      ) {
        throw new Error(
          `Create parent changed after planning ${firstPlan.inputPath}. No changes were written.`,
        );
      }
      throw error;
    }

    const ancestorWarning = await syncDirectory(firstPlan.ancestorPath);
    if (ancestorWarning) prepared.warnings.push(ancestorWarning);
    if (prepared.stagingParent !== firstPlan.ancestorPath) {
      const stagingParentWarning = await syncDirectory(prepared.stagingParent);
      if (stagingParentWarning) prepared.warnings.push(stagingParentWarning);
    }
    return prepared.warnings;
  } catch (error) {
    try {
      await discardPreparedNestedFiles(prepared);
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

export async function discardPreparedNestedFiles(prepared: PreparedNestedFiles): Promise<void> {
  if (prepared.published) return;
  await rm(prepared.staging, { recursive: true, force: true });
}

export async function publishPlannedNestedFiles(
  entries: PlannedNewFile[],
  signal?: AbortSignal,
  hooks?: NewFilePublishHooks,
): Promise<string[]> {
  const prepared = await preparePlannedNestedFiles(entries, signal, hooks);
  return publishPreparedNestedFiles(prepared, signal);
}

async function publishPlannedNestedFile(
  plan: NewFilePlan,
  bytes: Buffer,
  signal?: AbortSignal,
  hooks?: NewFilePublishHooks,
): Promise<string[]> {
  return publishPlannedNestedFiles([{ plan, bytes }], signal, hooks);
}

export async function publishNewFile(
  inputTargetPath: string,
  bytes: Buffer,
  signal?: AbortSignal,
  plan?: NewFilePlan,
  hooks?: NewFilePublishHooks,
): Promise<string[]> {
  if (plan) {
    await assertNewFilePlanCurrent(plan);
    if (plan.missingDirectories.length > 0) {
      return publishPlannedNestedFile(plan, bytes, signal, hooks);
    }
  }
  const targetPath = plan?.targetPath ?? inputTargetPath;
  const directory = dirname(targetPath);
  let firstCreatedDirectory: string | undefined;
  try {
    firstCreatedDirectory = await mkdir(directory, { recursive: true });
  } catch (error) {
    const reason = isCode(error, "EEXIST") || isCode(error, "ENOTDIR")
      ? "a parent path is not a directory"
      : errorMessage(error);
    throw new Error(`Cannot create ${targetPath}: ${reason}. No changes were written.`);
  }
  const temporary = temporaryPath(targetPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryStats: BigIntStats | undefined;
  let published = false;
  let failure: unknown;
  const warnings: string[] = [];
  try {
    throwIfAborted(signal);
    try {
      await lstat(targetPath);
      throw new Error(`File appeared before create: ${targetPath}. No changes were written.`);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }

    handle = await open(temporary, "wx", 0o666);
    await handle.writeFile(bytes);
    await handle.sync();
    temporaryStats = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    throwIfAborted(signal);
    const currentTemporary = await lstat(temporary, { bigint: true });
    if (!temporaryStats || !sameSnapshotStats(temporaryStats, currentTemporary)) {
      throw new Error(`Temporary file changed before create: ${temporary}. No changes were written.`);
    }

    try {
      await link(temporary, targetPath);
      published = true;
    } catch (error) {
      if (isCode(error, "EEXIST")) {
        throw new Error(`File appeared before create: ${targetPath}. No changes were written.`);
      }
      if (!isCode(error, "EPERM") && !isCode(error, "ENOTSUP") && !isCode(error, "ENOSYS")) {
        throw error;
      }
      let target: Awaited<ReturnType<typeof open>> | undefined;
      let targetStats: BigIntStats | undefined;
      try {
        target = await open(targetPath, "wx", 0o666);
        targetStats = await target.stat({ bigint: true });
        await target.writeFile(bytes);
        await target.sync();
        await target.close();
        target = undefined;
        published = true;
      } catch (writeError) {
        await target?.close().catch(() => undefined);
        if (targetStats) {
          const currentTarget = await lstat(targetPath, { bigint: true }).catch(() => undefined);
          if (currentTarget && sameIdentity(targetStats, currentTarget)) {
            try {
              await unlink(targetPath);
            } catch (cleanupError) {
              throw new Error(
                `Create failed and partial file ${targetPath} could not be removed: ` +
                  `${errorMessage(cleanupError)}. Original error: ${errorMessage(writeError)}`,
              );
            }
          }
        }
        if (isCode(writeError, "EEXIST")) {
          throw new Error(`File appeared before create: ${targetPath}. No changes were written.`);
        }
        throw writeError;
      }
      warnings.push("Atomic hard-link publication was unavailable; used exclusive write publication.");
    }
    try {
      await unlink(temporary);
    } catch (error) {
      warnings.push(`The file was created, but its temporary link remains at ${temporary}: ${errorMessage(error)}`);
    }

    const directoryWarning = await syncDirectory(directory);
    if (directoryWarning) warnings.push(directoryWarning);
    return warnings;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) {
      const cleanupFailures: string[] = [];
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isCode(error, "ENOENT")) cleanupFailures.push(`${temporary}: ${errorMessage(error)}`);
      }
      try {
        await removeCreatedDirectories(directory, firstCreatedDirectory);
      } catch (error) {
        cleanupFailures.push(errorMessage(error));
      }
      if (cleanupFailures.length > 0) {
        throw new Error(
          `${failure ? `${errorMessage(failure)} ` : "Create failed. "}` +
            `Cleanup was incomplete: ${cleanupFailures.join("; ")}`,
        );
      }
    }
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted before file content was committed");
}

async function removeCreatedDirectories(directory: string, firstCreated?: string): Promise<void> {
  if (!firstCreated) return;
  let current = directory;
  while (true) {
    try {
      await rmdir(current);
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        // Continue toward the first directory created by this call.
      } else if (isCode(error, "ENOTEMPTY") || isCode(error, "EEXIST")) {
        return;
      } else {
        throw new Error(
          `Create failed and newly created directory ${current} could not be removed: ${errorMessage(error)}`,
        );
      }
    }
    if (current === firstCreated) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertSnapshotCurrent(snapshot: FileSnapshot): Promise<void> {
  let currentInput: BigIntStats;
  try {
    currentInput = await lstat(snapshot.inputPath, { bigint: true });
  } catch {
    throw new Error(`File changed before commit: ${snapshot.inputPath}. No changes were written.`);
  }
  if (!sameIdentity(snapshot.inputStats, currentInput)) {
    throw new Error(`File path changed before commit: ${snapshot.inputPath}. No changes were written.`);
  }
  if (snapshot.symbolicLink && (await realpath(snapshot.inputPath)) !== snapshot.actualPath) {
    throw new Error(`Symbolic-link target changed before commit: ${snapshot.inputPath}. No changes were written.`);
  }

  const handle = await open(snapshot.actualPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameSnapshotStats(snapshot.stats, before)) {
      throw new Error(`File changed before commit: ${snapshot.inputPath}. No changes were written.`);
    }
    const currentBytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshotStats(before, after) || !currentBytes.equals(snapshot.bytes)) {
      throw new Error(`File content changed before commit: ${snapshot.inputPath}. No changes were written.`);
    }
  } finally {
    await handle.close();
  }
}

async function assertLinkedTargetCurrent(snapshot: FileSnapshot): Promise<void> {
  const currentInput = await lstat(snapshot.inputPath, { bigint: true }).catch(() => undefined);
  if (!currentInput || !sameIdentity(snapshot.inputStats, currentInput)) {
    throw new Error(`File path changed before commit: ${snapshot.inputPath}. No changes were written.`);
  }
  if (snapshot.symbolicLink && (await realpath(snapshot.inputPath)) !== snapshot.actualPath) {
    throw new Error(`Symbolic-link target changed before commit: ${snapshot.inputPath}. No changes were written.`);
  }

  const handle = await open(snapshot.actualPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameLinkedSnapshot(snapshot.stats, before)) {
      throw new Error(`File changed before commit: ${snapshot.inputPath}. No changes were written.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshotStats(before, after) || !bytes.equals(snapshot.bytes)) {
      throw new Error(`File content changed before commit: ${snapshot.inputPath}. No changes were written.`);
    }
  } finally {
    await handle.close();
  }
}

async function readStableFile(path: string): Promise<{ stats: BigIntStats; bytes: Buffer }> {
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

async function syncDirectory(directory: string): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return undefined;
  } catch (error) {
    return `The edit was committed, but the parent directory could not be synced: ${errorMessage(error)}`;
  }
}

function temporaryPath(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.pi-apply-edits-${process.pid}-${randomUUID()}.tmp`);
}

async function cloneWithMetadata(source: string, target: string, signal?: AbortSignal): Promise<void> {
  // Platform/capability checks run in assertSafeToReplace before publish/plan commit.
  const args = process.platform === "darwin"
    ? ["-p", source, target]
    : ["--preserve=all", "--", source, target];
  await new Promise<void>((resolve, reject) => {
    execFile("/bin/cp", args, { signal }, (error) => (error ? reject(error) : resolve()));
  });
}

async function assertNoLinuxCapabilities(path: string, signal?: AbortSignal): Promise<void> {
  const candidates = ["/usr/sbin/getcap", "/sbin/getcap", "/usr/bin/getcap", "/bin/getcap"];
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      executable = candidate;
      break;
    } catch {
      // Try the next conventional location.
    }
  }
  if (!executable) {
    throw new Error("Cannot verify Linux file capabilities because getcap is unavailable");
  }
  const output = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["-n", path], { encoding: "utf8", signal }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  if (output.trim().length > 0) {
    throw new Error(`Refusing to replace capability-bearing Linux file ${path}`);
  }
}

function samePreservedMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

function samePublishedState(left: BigIntStats, right: BigIntStats): boolean {
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

function sameLinkedSnapshot(snapshot: BigIntStats, linked: BigIntStats): boolean {
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

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isSymbolicLink() === right.isSymbolicLink();
}

function sameSnapshotStats(left: BigIntStats, right: BigIntStats): boolean {
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

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
