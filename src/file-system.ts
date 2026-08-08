import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
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
  beforeRename?: (paths: { target: string; temporary: string }) => void | Promise<void>;
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
  beforeDirectoryCommit?: (paths: { staging: string; target: string }) => void | Promise<void>;
  beforeFilePublish?: (paths: { temporary: string; target: string }) => void | Promise<void>;
}

export interface PlannedNewFile {
  plan: NewFilePlan;
  bytes: Buffer;
}

export interface PreparedNestedFiles {
  entries: PlannedNewFile[];
  firstPlan: NewFilePlan;
  publishRoot: string;
  container: string;
  staging: string;
  warnings: string[];
  hooks?: NewFilePublishHooks;
  published: boolean;
  discardAttempted: boolean;
  containerStats?: BigIntStats;
  stagingStats?: BigIntStats;
  stagedIdentities?: Map<string, BigIntStats>;
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
  let actualPath: string;
  try {
    // Bind publication to the canonical parent too, not only a final-component symlink.
    actualPath = await realpath(inputPath);
  } catch (error) {
    if (symbolicLink && isCode(error, "ENOENT")) {
      throw new Error(`Refusing to edit dangling symbolic link: ${inputPath}`);
    }
    throw error;
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
  const support = await replacementSupportInfo();
  if (!support.supported) throw new Error(`${support.reason}. No changes were written.`);
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
  const temporaryDirectory = temporaryDirectoryPath(snapshot.actualPath);
  const temporary = join(temporaryDirectory, "replacement");
  const recovery = temporaryPath(snapshot.actualPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryStats: BigIntStats | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let recoveryLinked = false;
  let temporaryDirectoryStats: BigIntStats | undefined;
  let replacementPublished = false;
  let published = false;
  let temporaryCleanupFailed = false;
  let failure: unknown;
  const warnings: string[] = [];
  try {
    try {
      await mkdir(temporaryDirectory, { mode: 0o700 });
      temporaryDirectoryStats = await lstat(temporaryDirectory, { bigint: true });
      await cloneWithMetadata(snapshot.actualPath, temporary, signal);
    } catch (error) {
      throwIfAborted(signal);
      throw new Error(
        `Could not prepare an atomic metadata-preserving replacement for ${snapshot.inputPath}: ` +
          `${errorMessage(error)}. No changes were written.`,
      );
    }
    handle = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
    const clonedStats = await handle.stat({ bigint: true });
    temporaryIdentity = clonedStats;
    if (!clonedStats.isFile() || clonedStats.nlink !== 1n || !samePreservedMetadata(snapshot.stats, clonedStats)) {
      throw new Error(`Could not preserve file metadata for ${snapshot.inputPath}. No changes were written.`);
    }
    await handle.truncate(0);
    await handle.writeFile(bytes, { signal });
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
    throwIfAborted(signal);
    await link(snapshot.actualPath, recovery);
    recoveryLinked = true;
    await assertLinkedTargetCurrent(snapshot);
    await hooks?.beforeRename?.({ target: snapshot.actualPath, temporary });
    throwIfAborted(signal);
    await assertPreparedFileCurrent(temporary, temporaryStats, bytes, "Temporary replacement");
    await assertLinkedActualCurrent(snapshot);
    throwIfAborted(signal);
    await rename(temporary, snapshot.actualPath);
    replacementPublished = true;

    let recoveryState: { stats: BigIntStats; bytes: Buffer };
    let publishedStats: BigIntStats;
    let publishedBytes: Buffer;
    try {
      await hooks?.afterRename?.({ target: snapshot.actualPath, recovery });
      recoveryState = await readStableFile(recovery);
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
    if (!recoveryState.bytes.equals(snapshot.bytes)) {
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
      await unlinkOwnedPath(recovery, recoveryState.stats, "Recovery link", recoveryState);
      recoveryLinked = false;
    } catch (error) {
      warnings.push(`The edit was committed, but recovery cleanup was incomplete: ${errorMessage(error)}`);
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
        await unlinkOwnedPath(temporary, temporaryIdentity, "Temporary replacement");
      } catch (error) {
        temporaryCleanupFailed = true;
        cleanupFailures.push(`${temporary}: ${errorMessage(error)}`);
      }
    }
    if (recoveryLinked && !replacementPublished) {
      try {
        await unlinkOwnedPath(recovery, snapshot.stats, "Recovery link");
      } catch (error) {
        cleanupFailures.push(`${recovery}: ${errorMessage(error)}`);
      }
    }
    if (temporaryDirectoryStats && !temporaryCleanupFailed) {
      try {
        await rmdirOwnedPath(temporaryDirectory, temporaryDirectoryStats, "Temporary directory");
      } catch (error) {
        const message = `Temporary directory remains at ${temporaryDirectory}: ${errorMessage(error)}`;
        if (published) warnings.push(message);
        else cleanupFailures.push(message);
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

  const container = join(firstPlan.ancestorPath, `.pi-apply-edits-${randomUUID()}.tmpdir`);
  const prepared: PreparedNestedFiles = {
    entries,
    firstPlan,
    publishRoot: join(firstPlan.ancestorPath, firstMissing),
    container,
    staging: join(container, "publish"),
    warnings: [],
    hooks,
    published: false,
    discardAttempted: false,
  };
  const stagedDirectories = new Set<string>();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    throwIfAborted(signal);
    for (const { plan } of entries) await assertNewFilePlanCurrent(plan);
    await mkdir(prepared.container, { mode: 0o700 });
    prepared.containerStats = await lstat(prepared.container, { bigint: true });
    await mkdir(prepared.staging, { mode: 0o777 });
    prepared.stagingStats = await lstat(prepared.staging, { bigint: true });
    stagedDirectories.add(prepared.container);
    stagedDirectories.add(prepared.staging);

    for (const { plan, bytes } of entries) {
      throwIfAborted(signal);
      const stagedDirectory = join(prepared.staging, ...plan.missingDirectories.slice(1));
      if (stagedDirectory !== prepared.staging) await mkdir(stagedDirectory, { recursive: true });
      addDirectoryAndParents(stagedDirectories, stagedDirectory, prepared.staging);
      const stagedTarget = join(stagedDirectory, basename(plan.targetPath));
      handle = await open(stagedTarget, "wx", 0o666);
      await handle.writeFile(bytes, { signal });
      await handle.sync();
      await handle.close();
      handle = undefined;
    }

    for (const directory of [...stagedDirectories].sort((left, right) => right.length - left.length)) {
      throwIfAborted(signal);
      const warning = await syncDirectory(directory);
      if (warning) prepared.warnings.push(warning);
    }
    prepared.stagedIdentities = await inspectPreparedTree(prepared);
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
    await prepared.hooks?.beforeDirectoryCommit?.({ staging, target: publishRoot });
    throwIfAborted(signal);
    for (const { plan } of entries) await assertNewFilePlanCurrent(plan);
    await inspectPreparedTree(prepared, prepared.stagedIdentities);
    // Keep the final parent/path checks adjacent to rename; Node has no portable renameat-style API.
    await assertNewFilePlanCurrent(firstPlan);
    try {
      await lstat(publishRoot);
      throw new Error(
        `Create parent changed after planning ${firstPlan.inputPath}. No changes were written.`,
      );
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    try {
      throwIfAborted(signal);
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

    if (prepared.containerStats) {
      try {
        await rmdirOwnedPath(prepared.container, prepared.containerStats, "Staged create container");
      } catch (error) {
        prepared.warnings.push(
          `The files were created, but their staging container remains at ${prepared.container}: ${errorMessage(error)}`,
        );
      }
    }
    const ancestorWarning = await syncDirectory(firstPlan.ancestorPath);
    if (ancestorWarning) prepared.warnings.push(ancestorWarning);
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
  if (prepared.published || prepared.discardAttempted) return;
  prepared.discardAttempted = true;
  if (prepared.stagingStats) {
    if (prepared.stagedIdentities) {
      await inspectPreparedTree(prepared, prepared.stagedIdentities);
    }
    const quarantined = await quarantineOwnedPath(
      prepared.staging,
      prepared.stagingStats,
      "Staged create directory",
    );
    if (quarantined) {
      if (prepared.stagedIdentities) {
        const identities = new Map(prepared.stagedIdentities);
        identities.set("", quarantined.stats);
        await inspectPreparedTree(
          { ...prepared, staging: quarantined.path },
          identities,
        );
      }
      await rm(quarantined.path, { recursive: true });
      await removeEmptyOwnedDirectory(
        quarantined.directory,
        quarantined.directoryStats,
        "Cleanup quarantine",
      );
    }
  }
  if (prepared.containerStats) {
    await rmdirOwnedPath(prepared.container, prepared.containerStats, "Staged create container");
  }
}

function addDirectoryAndParents(paths: Set<string>, directory: string, root: string): void {
  let current = directory;
  while (true) {
    paths.add(current);
    if (current === root) return;
    current = dirname(current);
  }
}

async function inspectPreparedTree(
  prepared: PreparedNestedFiles,
  expectedIdentities?: Map<string, BigIntStats>,
): Promise<Map<string, BigIntStats>> {
  const expected = new Map<string, Buffer>();
  const expectedDirectories = new Set([""]);
  for (const { plan, bytes } of prepared.entries) {
    const relativePath = join(...plan.missingDirectories.slice(1), basename(plan.targetPath));
    if (expected.has(relativePath)) {
      throw new Error(`Duplicate staged create target ${plan.inputPath}. No changes were written.`);
    }
    expected.set(relativePath, bytes);
    let relativeDirectory = dirname(relativePath);
    while (relativeDirectory !== ".") {
      expectedDirectories.add(relativeDirectory);
      relativeDirectory = dirname(relativeDirectory);
    }
  }

  const seen = new Set<string>();
  const identities = new Map<string, BigIntStats>();
  const rememberIdentity = (relativePath: string, stats: BigIntStats): void => {
    const expectedIdentity = expectedIdentities?.get(relativePath);
    if (expectedIdentities && (!expectedIdentity || !sameSnapshotStats(expectedIdentity, stats))) {
      throw new Error(`Staged create entry changed before publish: ${join(prepared.staging, relativePath)}. No changes were written.`);
    }
    identities.set(relativePath, stats);
  };
  const walk = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const directoryStats = await lstat(directory, { bigint: true });
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error(`Staged create tree changed before publish: ${directory}. No changes were written.`);
    }
    rememberIdentity(relativeDirectory, directoryStats);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const path = join(directory, entry.name);
      const stats = await lstat(path, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw new Error(`Staged create tree contains a symbolic link: ${path}. No changes were written.`);
      }
      if (stats.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) {
          throw new Error(`Staged create tree contains an unexpected directory: ${path}. No changes were written.`);
        }
        await walk(path, relativePath);
        continue;
      }
      const bytes = expected.get(relativePath);
      if (!stats.isFile() || stats.nlink !== 1n || !bytes) {
        throw new Error(`Staged create tree contains an unexpected entry: ${path}. No changes were written.`);
      }
      const current = await readStableFile(path);
      if (!current.bytes.equals(bytes)) {
        throw new Error(`Staged create file changed before publish: ${path}. No changes were written.`);
      }
      rememberIdentity(relativePath, current.stats);
      seen.add(relativePath);
    }
  };

  await walk(prepared.staging);
  if (seen.size !== expected.size || (expectedIdentities && identities.size !== expectedIdentities.size)) {
    throw new Error(`Staged create tree is incomplete. No changes were written.`);
  }
  return identities;
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
  let createdDirectoryIdentities = new Map<string, BigIntStats>();
  try {
    firstCreatedDirectory = await mkdir(directory, { recursive: true });
    createdDirectoryIdentities = await captureCreatedDirectoryIdentities(directory, firstCreatedDirectory);
  } catch (error) {
    const reason = isCode(error, "EEXIST") || isCode(error, "ENOTDIR")
      ? "a parent path is not a directory"
      : errorMessage(error);
    throw new Error(`Cannot create ${targetPath}: ${reason}. No changes were written.`);
  }
  const temporaryDirectory = temporaryDirectoryPath(targetPath);
  const temporary = join(temporaryDirectory, "create");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryStats: BigIntStats | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let temporaryDirectoryStats: BigIntStats | undefined;
  let published = false;
  let temporaryCleanupFailed = false;
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

    if (plan) await assertNewFilePlanCurrent(plan);
    await mkdir(temporaryDirectory, { mode: 0o700 });
    temporaryDirectoryStats = await lstat(temporaryDirectory, { bigint: true });
    handle = await open(temporary, "wx", 0o666);
    temporaryIdentity = await handle.stat({ bigint: true });
    await handle.writeFile(bytes, { signal });
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
      await hooks?.beforeFilePublish?.({ temporary, target: targetPath });
      await assertPreparedFileCurrent(temporary, temporaryStats, bytes, "Temporary create file");
      if (plan) await assertNewFilePlanCurrent(plan);
      throwIfAborted(signal);
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
        if (plan) await assertNewFilePlanCurrent(plan);
        throwIfAborted(signal);
        target = await open(targetPath, "wx", 0o666);
        targetStats = await target.stat({ bigint: true });
        await target.writeFile(bytes, { signal });
        await target.sync();
        await target.close();
        target = undefined;
        published = true;
      } catch (writeError) {
        await target?.close().catch(() => undefined);
        if (targetStats) {
          throw new Error(
            `Create failed after ${targetPath} became visible. It may be partial and was left untouched: ` +
              errorMessage(writeError),
          );
        }
        if (isCode(writeError, "EEXIST")) {
          throw new Error(`File appeared before create: ${targetPath}. No changes were written.`);
        }
        throw writeError;
      }
      warnings.push("Atomic hard-link publication was unavailable; used exclusive write publication.");
    }
    try {
      await unlinkOwnedPath(temporary, temporaryIdentity, "Temporary create file");
    } catch (error) {
      temporaryCleanupFailed = true;
      warnings.push(`The file was created, but its temporary link remains at ${temporary}: ${errorMessage(error)}`);
    }
    if (temporaryDirectoryStats && !temporaryCleanupFailed) {
      try {
        await rmdirOwnedPath(temporaryDirectory, temporaryDirectoryStats, "Temporary create directory");
      } catch (error) {
        warnings.push(`The file was created, but its temporary directory remains at ${temporaryDirectory}: ${errorMessage(error)}`);
      }
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
        await unlinkOwnedPath(temporary, temporaryIdentity, "Temporary create file");
      } catch (error) {
        temporaryCleanupFailed = true;
        cleanupFailures.push(`${temporary}: ${errorMessage(error)}`);
      }
      if (temporaryDirectoryStats && !temporaryCleanupFailed) {
        try {
          await rmdirOwnedPath(temporaryDirectory, temporaryDirectoryStats, "Temporary create directory");
        } catch (error) {
          cleanupFailures.push(`${temporaryDirectory}: ${errorMessage(error)}`);
        }
      }
      try {
        await removeCreatedDirectories(directory, firstCreatedDirectory, createdDirectoryIdentities);
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

async function assertPreparedFileCurrent(
  path: string,
  expected: BigIntStats | undefined,
  bytes: Buffer,
  label: string,
): Promise<void> {
  if (!expected) throw new Error(`${label} identity was not recorded. No changes were written.`);
  const current = await readStableFile(path);
  if (!sameSnapshotStats(expected, current.stats) || !current.bytes.equals(bytes)) {
    throw new Error(`${label} changed before commit: ${path}. No changes were written.`);
  }
}

async function currentOwnedPath(
  path: string,
  expected: BigIntStats | undefined,
  label: string,
): Promise<BigIntStats | undefined> {
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (!expected || !sameIdentity(expected, current)) {
    throw new Error(`${label} changed identity and was left untouched at ${path}`);
  }
  return current;
}

interface QuarantinedPath {
  path: string;
  directory: string;
  directoryStats: BigIntStats;
  stats: BigIntStats;
}

async function quarantineOwnedPath(
  path: string,
  expected: BigIntStats | undefined,
  label: string,
): Promise<QuarantinedPath | undefined> {
  if (!(await currentOwnedPath(path, expected, label))) return undefined;
  const directory = temporaryDirectoryPath(path);
  await mkdir(directory, { mode: 0o700 });
  const directoryStats = await lstat(directory, { bigint: true });
  const quarantined = join(directory, "entry");
  try {
    await rename(path, quarantined);
  } catch (error) {
    await removeEmptyOwnedDirectory(directory, directoryStats, "Cleanup quarantine");
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const stats = await lstat(quarantined, { bigint: true });
  if (!expected || !sameIdentity(expected, stats)) {
    throw new Error(`${label} changed after validation and was preserved at ${quarantined}`);
  }
  return { path: quarantined, directory, directoryStats, stats };
}

async function removeEmptyOwnedDirectory(
  path: string,
  expected: BigIntStats,
  label: string,
): Promise<void> {
  if (await currentOwnedPath(path, expected, label)) await rmdir(path);
}

async function unlinkOwnedPath(
  path: string,
  expected: BigIntStats | undefined,
  label: string,
  expectedFile?: { stats: BigIntStats; bytes: Buffer },
): Promise<void> {
  const quarantined = await quarantineOwnedPath(path, expected, label);
  if (!quarantined) return;
  if (expectedFile) {
    const current = await readStableFile(quarantined.path);
    if (!samePublishedState(expectedFile.stats, current.stats) || !expectedFile.bytes.equals(current.bytes)) {
      throw new Error(`${label} changed after verification and was preserved at ${quarantined.path}`);
    }
  }
  await unlink(quarantined.path);
  await removeEmptyOwnedDirectory(
    quarantined.directory,
    quarantined.directoryStats,
    "Cleanup quarantine",
  );
}

async function rmdirOwnedPath(path: string, expected: BigIntStats, label: string): Promise<void> {
  const quarantined = await quarantineOwnedPath(path, expected, label);
  if (!quarantined) return;
  await rmdir(quarantined.path);
  await removeEmptyOwnedDirectory(
    quarantined.directory,
    quarantined.directoryStats,
    "Cleanup quarantine",
  );
}

async function captureCreatedDirectoryIdentities(
  directory: string,
  firstCreated?: string,
): Promise<Map<string, BigIntStats>> {
  const identities = new Map<string, BigIntStats>();
  if (!firstCreated) return identities;
  let current = directory;
  while (true) {
    identities.set(current, await lstat(current, { bigint: true }));
    if (current === firstCreated) return identities;
    const parent = dirname(current);
    if (parent === current) return identities;
    current = parent;
  }
}

async function removeCreatedDirectories(
  directory: string,
  firstCreated: string | undefined,
  identities: Map<string, BigIntStats>,
): Promise<void> {
  if (!firstCreated) return;
  let current = directory;
  while (true) {
    try {
      const expected = identities.get(current);
      if (!expected) throw new Error(`Created directory identity was not recorded: ${current}`);
      await rmdirOwnedPath(current, expected, "Created directory");
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        // Continue toward the first directory created by this call.
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

export async function assertSnapshotCurrent(snapshot: FileSnapshot): Promise<void> {
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
  await assertLinkedActualCurrent(snapshot);
}

async function assertLinkedActualCurrent(snapshot: FileSnapshot): Promise<void> {
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
  return join(dirname(targetPath), `.pi-apply-edits-${process.pid}-${randomUUID()}.tmp`);
}

function temporaryDirectoryPath(targetPath: string): string {
  return `${temporaryPath(targetPath)}dir`;
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

type ReplacementSupport =
  | { supported: true; getcap?: string }
  | { supported: false; reason: string };

let cachedReplacementSupport: Promise<ReplacementSupport> | undefined;

export async function supportsExistingFileReplacement(): Promise<boolean> {
  return (await replacementSupportInfo()).supported;
}

function replacementSupportInfo(): Promise<ReplacementSupport> {
  cachedReplacementSupport ??= detectReplacementSupport();
  return cachedReplacementSupport;
}

async function detectReplacementSupport(): Promise<ReplacementSupport> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      supported: false,
      reason: `Atomic metadata-preserving replacement is not supported on ${process.platform}`,
    };
  }
  try {
    await access("/bin/cp", constants.X_OK);
  } catch {
    return { supported: false, reason: "Atomic replacement requires executable /bin/cp" };
  }
  if (process.platform === "darwin") return { supported: true };

  const getcap = await firstExecutable([
    "/usr/sbin/getcap",
    "/sbin/getcap",
    "/usr/bin/getcap",
    "/bin/getcap",
  ]);
  if (!getcap) {
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
  return { supported: true, getcap };
}

async function firstExecutable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next conventional location.
    }
  }
  return undefined;
}

function execText(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8", signal }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function assertNoLinuxCapabilities(path: string, signal?: AbortSignal): Promise<void> {
  const support = await replacementSupportInfo();
  if (!support.supported || !support.getcap) {
    throw new Error("Cannot verify Linux file capabilities because getcap is unavailable");
  }
  const output = await execText(support.getcap, ["-n", path], signal);
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
