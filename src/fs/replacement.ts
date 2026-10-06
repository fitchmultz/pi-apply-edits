import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileSnapshot, FileState, ReplacementPublishHooks } from "./contracts.ts";
import {
  assertCreatedDirectoryOwner,
  rmdirOwnedPath,
  temporaryDirectoryPath,
  temporaryPath,
  unlinkOwnedPath,
} from "./cleanup.ts";
import {
  AtomicMoveUncertainError,
  errorMessage,
  PublicationError,
  throwIfAborted,
} from "./errors.ts";
import {
  assertPreparedFileCurrent,
  readStableFile,
  samePreservedMetadata,
  samePublishedState,
  sameSnapshotStats,
  syncDirectory,
} from "./observation.ts";
import {
  assertNoLinuxCapabilities,
  cloneWithMetadata,
  exchangePreparedFiles,
  movePreparedFileNoReplace,
  replacementSupportInfo,
} from "./platform.ts";
import {
  androidMetadataForSnapshot,
  assertLinkedTargetCurrent,
  assertSafeToReplace,
  assertSnapshotCurrent,
} from "./snapshot.ts";

export async function publishReplacement(
  snapshot: FileSnapshot,
  bytes: Buffer,
  signal?: AbortSignal,
  hooks?: ReplacementPublishHooks,
): Promise<string[]> {
  return new ReplacementPublication(snapshot, bytes, signal, hooks).run();
}

/** Owns the private replacement, recovery link, and truthful commit/cleanup receipt. */
class ReplacementPublication {
  private readonly snapshot: FileSnapshot;
  private readonly bytes: Buffer;
  private readonly signal: AbortSignal | undefined;
  private readonly hooks: ReplacementPublishHooks | undefined;
  private readonly directory: string;
  private readonly temporaryDirectory: string;
  private readonly temporary: string;
  private readonly recovery: string;
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private temporaryStats: BigIntStats | undefined;
  private temporaryIdentity: BigIntStats | undefined;
  private temporaryDirectoryStats: BigIntStats | undefined;
  private recoveryLinked = false;
  private replacementPublished = false;
  private replacementVerified = false;
  private published = false;
  private temporaryCleanupFailed = false;
  private readonly warnings: string[] = [];

  constructor(
    snapshot: FileSnapshot,
    bytes: Buffer,
    signal?: AbortSignal,
    hooks?: ReplacementPublishHooks,
  ) {
    this.snapshot = snapshot;
    this.bytes = bytes;
    this.signal = signal;
    this.hooks = hooks;
    this.directory = dirname(snapshot.actualPath);
    this.temporaryDirectory = temporaryDirectoryPath(snapshot.actualPath);
    this.temporary = join(this.temporaryDirectory, "replacement");
    this.recovery = temporaryPath(snapshot.actualPath);
  }

  async run(): Promise<string[]> {
    await assertSafeToReplace(this.snapshot, this.signal);
    const support = await replacementSupportInfo();
    if (!support.supported) {
      throw new Error(`${support.reason}. No changes were written.`);
    }
    let failure: unknown;
    let failed = false;
    try {
      await this.prepare();
      await this.validatePrepared();
      if (support.strategy === "exchange") {
        await this.commitExchange();
      } else {
        await this.commitRename();
      }
      const retained = await this.verifyCommit();
      this.published = true;
      await this.cleanupRecovery(retained);
      const warning = await syncDirectory(this.directory);
      if (warning !== undefined) {
        this.warnings.push(warning);
      }
    } catch (error) {
      failure = error;
      failed = true;
    }
    await this.cleanupPrivateFiles(failure);
    if (failed) {
      throw this.receipt(errorMessage(failure), failure);
    }
    return this.warnings;
  }

  private receipt(message: string, cause?: unknown): PublicationError {
    return new PublicationError(
      message,
      this.replacementVerified ? [this.snapshot.actualPath] : [],
      this.replacementPublished && !this.replacementVerified ? [this.snapshot.actualPath] : [],
      cause,
    );
  }

  private async prepare(): Promise<void> {
    try {
      await mkdir(this.temporaryDirectory, { mode: 0o700 });
      const created = await lstat(this.temporaryDirectory, { bigint: true });
      assertCreatedDirectoryOwner(created, this.temporaryDirectory);
      this.temporaryDirectoryStats = created;
      await cloneWithMetadata(
        this.snapshot.actualPath,
        this.temporary,
        this.signal,
        androidMetadataForSnapshot(this.snapshot),
      );
    } catch (error) {
      throwIfAborted(this.signal);
      throw new Error(
        `Could not prepare an atomic metadata-preserving replacement for ${this.snapshot.inputPath}: ${errorMessage(error)}. No changes were written.`,
        { cause: error },
      );
    }
    this.handle = await open(this.temporary, constants.O_RDWR | constants.O_NOFOLLOW);
    const cloned = await this.handle.stat({ bigint: true });
    this.temporaryIdentity = cloned;
    if (
      !cloned.isFile() ||
      cloned.nlink !== 1n ||
      !samePreservedMetadata(this.snapshot.stats, cloned)
    ) {
      throw new Error(
        `Could not preserve file metadata for ${this.snapshot.inputPath}. No changes were written.`,
      );
    }
    await this.handle.truncate(0);
    await this.handle.writeFile(this.bytes, { signal: this.signal });
    await this.handle.sync();
    this.temporaryStats = await this.handle.stat({ bigint: true });
    if (!samePreservedMetadata(this.snapshot.stats, this.temporaryStats)) {
      throw new Error(
        `File metadata changed while preparing ${this.snapshot.inputPath}. No changes were written.`,
      );
    }
    if (process.platform === "linux") {
      await assertNoLinuxCapabilities(this.temporary, this.signal);
    }
    await this.handle.close();
    this.handle = undefined;
  }

  private async validatePrepared(): Promise<void> {
    throwIfAborted(this.signal);
    const current = await lstat(this.temporary, { bigint: true });
    if (!this.temporaryStats || !sameSnapshotStats(this.temporaryStats, current)) {
      throw new Error(
        `Temporary file changed before commit: ${this.temporary}. No changes were written.`,
      );
    }
    await assertSnapshotCurrent(this.snapshot);
    throwIfAborted(this.signal);
  }

  private async commitExchange(): Promise<void> {
    const prepared = this.temporaryStats;
    if (!prepared) {
      throw new Error("Temporary replacement identity was not recorded");
    }
    await this.hooks?.beforeRename?.({
      target: this.snapshot.actualPath,
      temporary: this.temporary,
    });
    throwIfAborted(this.signal);
    await assertPreparedFileCurrent(this.temporary, prepared, this.bytes, "Temporary replacement");
    await assertSnapshotCurrent(this.snapshot);
    throwIfAborted(this.signal);
    try {
      await exchangePreparedFiles(
        this.temporary,
        this.snapshot.actualPath,
        prepared,
        this.snapshot.stats,
      );
      this.replacementPublished = true;
      const retained = await movePreparedFileNoReplace(
        this.temporary,
        this.recovery,
        this.snapshot.stats,
      );
      if (!retained) {
        throw new Error(`Recovery path appeared during atomic replacement: ${this.recovery}`);
      }
      this.recoveryLinked = true;
    } catch (error) {
      if (this.replacementPublished || error instanceof AtomicMoveUncertainError) {
        this.recoveryLinked = true;
        this.replacementPublished = true;
        throw new AtomicMoveUncertainError(
          `Atomic replacement or recovery retention could not be verified. Commit status is uncertain; inspect ${this.snapshot.actualPath}, ${this.temporary}, and ${this.recovery}. Cause: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async commitRename(): Promise<void> {
    // ponytail: Node has no portable compare-and-swap rename. Recovery protects in-place
    // external writes; upgrade to platform exchange if atomic-replacement races are observed.
    await link(this.snapshot.actualPath, this.recovery);
    this.recoveryLinked = true;
    const baseline = await assertLinkedTargetCurrent(this.snapshot);
    await this.hooks?.beforeRename?.({
      target: this.snapshot.actualPath,
      temporary: this.temporary,
    });
    throwIfAborted(this.signal);
    await assertPreparedFileCurrent(
      this.temporary,
      this.temporaryStats,
      this.bytes,
      "Temporary replacement",
    );
    await assertLinkedTargetCurrent(this.snapshot, baseline);
    throwIfAborted(this.signal);
    await rename(this.temporary, this.snapshot.actualPath);
    this.replacementPublished = true;
  }

  private async readCommittedVersions(): Promise<{
    readonly baseline: BigIntStats;
    readonly recovery: FileState;
    readonly target: FileState;
  }> {
    try {
      // Linking/renaming change ctime; subsequent changes belong to external writers.
      const baseline = await lstat(this.recovery, { bigint: true });
      await this.hooks?.afterRename?.({
        target: this.snapshot.actualPath,
        recovery: this.recovery,
      });
      const recovery = await readStableFile(this.recovery);
      const target = await readStableFile(this.snapshot.actualPath);
      return { baseline, recovery, target };
    } catch (error) {
      throw new Error(
        `Atomic replacement reached ${this.snapshot.inputPath}, but verification failed. Commit status is uncertain; inspect the target and recovery path ${this.recovery}. Cause: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async verifyCommit(): Promise<FileState> {
    const versions = await this.readCommittedVersions();
    const targetMatches =
      this.temporaryStats !== undefined &&
      samePublishedState(this.temporaryStats, versions.target.stats) &&
      versions.target.bytes.equals(this.bytes);
    this.replacementVerified = targetMatches;
    if (
      !samePublishedState(this.snapshot.stats, versions.recovery.stats) ||
      !sameSnapshotStats(versions.baseline, versions.recovery.stats) ||
      !versions.recovery.bytes.equals(this.snapshot.bytes)
    ) {
      await this.reportConflict();
    }
    if (!targetMatches) {
      throw new Error(
        `File changed immediately after commit: ${this.snapshot.inputPath}. The external content was kept, and the pre-edit content remains at ${this.recovery}. Retry after inspecting both files.`,
      );
    }
    return versions.recovery;
  }

  private async reportConflict(): Promise<never> {
    try {
      await this.hooks?.beforeConflictReturn?.({
        target: this.snapshot.actualPath,
        recovery: this.recovery,
      });
    } catch (error) {
      throw new Error(
        `File conflict handling failed for ${this.snapshot.inputPath}. Commit status is uncertain; inspect the target and recovery path ${this.recovery}. Cause: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw new Error(
      `File versions changed during commit: ${this.snapshot.inputPath}. No automatic rollback was attempted; the current target was left untouched, and the earlier external content remains at ${this.recovery}.`,
    );
  }

  private async cleanupRecovery(retained: FileState): Promise<void> {
    try {
      await this.hooks?.beforeRecoveryCleanup?.({
        target: this.snapshot.actualPath,
        recovery: this.recovery,
      });
    } catch (error) {
      throw new Error(
        `The edit was verified committed to ${this.snapshot.inputPath}, but recovery cleanup did not run. The previous content remains at ${this.recovery}. Cause: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    try {
      const removed = await unlinkOwnedPath(
        this.recovery,
        retained.stats,
        "Recovery link",
        retained,
      );
      this.recoveryLinked = false;
      if (!removed) {
        this.warnings.push(
          `The edit was committed, but the pre-edit recovery link is no longer at ${this.recovery}; its location is uncertain and the previous content may remain elsewhere.`,
        );
      }
    } catch (error) {
      this.warnings.push(
        `The edit was committed, but recovery cleanup failed and its final state is unknown; the previous content may remain at ${this.recovery} or elsewhere, or only leftover temporary directories may remain: ${errorMessage(error)}`,
      );
    }
  }

  private async cleanupPrivateFiles(failure: unknown): Promise<void> {
    await this.handle?.close().catch(() => {
      // Descriptor-close failure must not replace the publication and identity-cleanup outcome.
    });
    const failures = await this.cleanupUnpublishedContent();
    const directoryFailure = await this.removeTemporaryDirectory();
    if (directoryFailure !== undefined) {
      if (this.published) {
        this.warnings.push(directoryFailure);
      } else {
        failures.push(directoryFailure);
      }
    }
    if (failures.length > 0) {
      throw this.receipt(
        `${failure === undefined ? "" : `${errorMessage(failure)} `}Cleanup was incomplete: ${failures.join("; ")}`,
        failure,
      );
    }
  }

  private async cleanupUnpublishedContent(): Promise<string[]> {
    const failures: string[] = [];
    if (!this.published && !this.replacementPublished) {
      const message = await this.removeTemporary();
      if (message !== undefined) {
        failures.push(message);
      }
    }
    if (this.recoveryLinked && !this.replacementPublished) {
      const message = await this.removeUncommittedRecovery();
      if (message !== undefined) {
        failures.push(message);
      }
    }
    return failures;
  }

  private async removeTemporary(): Promise<string | undefined> {
    try {
      const removed = await unlinkOwnedPath(
        this.temporary,
        this.temporaryIdentity,
        "Temporary replacement",
      );
      if (!removed && this.temporaryIdentity) {
        return `the temporary replacement is no longer at ${this.temporary}; its location is uncertain and its content may remain elsewhere`;
      }
    } catch (error) {
      this.temporaryCleanupFailed = true;
      return `the temporary replacement's cleanup failed and its final state is unknown; it may remain at ${this.temporary} or elsewhere, or only leftover temporary directories may remain: ${errorMessage(error)}`;
    }
    return;
  }

  private async removeUncommittedRecovery(): Promise<string | undefined> {
    try {
      const removed = await unlinkOwnedPath(this.recovery, this.snapshot.stats, "Recovery link");
      if (!removed) {
        return `the pre-edit recovery link is no longer at ${this.recovery}; its location is uncertain and the target may remain hard-linked to it`;
      }
    } catch (error) {
      return `the pre-edit recovery link's cleanup failed and its final state is unknown; it may remain at ${this.recovery} or elsewhere, possibly hard-linked to the target, or only leftover temporary directories may remain: ${errorMessage(error)}`;
    }
    return;
  }

  private async removeTemporaryDirectory(): Promise<string | undefined> {
    if (!this.temporaryDirectoryStats || this.temporaryCleanupFailed) {
      return;
    }
    try {
      await rmdirOwnedPath(
        this.temporaryDirectory,
        this.temporaryDirectoryStats,
        "Temporary directory",
      );
    } catch (error) {
      return `Temporary directory remains at ${this.temporaryDirectory}: ${errorMessage(error)}`;
    }
    return;
  }
}
