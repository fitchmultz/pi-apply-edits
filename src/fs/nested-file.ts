import type { BigIntStats } from "node:fs";
import { link, lstat, open } from "node:fs/promises";
import type { NewFilePublishHooks, PlannedNewFile, ReplacementSupport } from "./contracts.ts";
import { assertPublishedDirectoriesCurrent, unlinkOwnedPath } from "./cleanup.ts";
import {
  AtomicMoveUncertainError,
  errorMessage,
  isCode,
  PublicationError,
  throwIfAborted,
} from "./errors.ts";
import {
  assertPreparedFileCurrent,
  readStableFile,
  readStableRegularEntry,
  sameIdentity,
  samePublishedState,
} from "./observation.ts";
import { movePreparedFileNoReplace } from "./platform.ts";
import { preparePrivatePublicationFile } from "./preparation.ts";

export interface NestedFileDestination {
  readonly stagedTarget: string;
  readonly target: string;
  readonly candidate: string;
  readonly stagedIdentity: BigIntStats | undefined;
  readonly directories: ReadonlyMap<string, BigIntStats>;
  readonly hooks?: NewFilePublishHooks;
  readonly rememberStaging: (stats: BigIntStats) => void;
  readonly warn: (message: string) => void;
}

export async function publishNestedFile(
  entry: PlannedNewFile,
  destination: NestedFileDestination,
  support: ReplacementSupport,
  signal?: AbortSignal,
): Promise<void> {
  await new NestedFilePublication(entry, destination, support, signal).run();
}

/** Owns one staged file's link/move/copy transition and its identity-checked rollback. */
class NestedFilePublication {
  private readonly entry: PlannedNewFile;
  private readonly destination: NestedFileDestination;
  private readonly support: ReplacementSupport;
  private readonly signal: AbortSignal | undefined;
  private publication: "link" | "move" | "copy" = "link";
  private movedIdentity: BigIntStats | undefined;
  private copyHandle: Awaited<ReturnType<typeof open>> | undefined;
  private published = false;
  private verified = false;

  constructor(
    entry: PlannedNewFile,
    destination: NestedFileDestination,
    support: ReplacementSupport,
    signal?: AbortSignal,
  ) {
    this.entry = entry;
    this.destination = destination;
    this.support = support;
    this.signal = signal;
  }

  async run(): Promise<void> {
    try {
      await this.destination.hooks?.beforeFilePublish?.({
        temporary: this.destination.stagedTarget,
        target: this.destination.target,
      });
      await assertPreparedFileCurrent(
        this.destination.stagedTarget,
        this.destination.stagedIdentity,
        this.entry.bytes,
        "Staged create file",
      );
      await assertPublishedDirectoriesCurrent(this.destination.directories);
      throwIfAborted(this.signal);
      await this.publishCandidate();
      await this.destination.hooks?.afterFilePublish?.({ target: this.destination.target });
      await this.verify();
    } catch (error) {
      await this.copyHandle?.close().catch(() => {
        // Preserve publication failure and the target's verified/uncertain receipt.
      });
      throw new PublicationError(
        errorMessage(error),
        this.verified ? [this.destination.target] : [],
        this.published && !this.verified ? [this.destination.target] : [],
        error,
      );
    }
  }

  private async publishCandidate(): Promise<void> {
    if (this.support.supported && this.support.strategy === "exchange") {
      await this.publishAtomicMove();
    } else {
      await this.publishLinkOrCopy();
    }
  }

  private async publishAtomicMove(): Promise<void> {
    this.publication = "move";
    this.movedIdentity = await preparePrivatePublicationFile(
      this.destination.candidate,
      this.entry.bytes,
      this.signal,
    );
    await assertPublishedDirectoriesCurrent(this.destination.directories);
    throwIfAborted(this.signal);
    let moved: boolean;
    try {
      moved = await movePreparedFileNoReplace(
        this.destination.candidate,
        this.destination.target,
        this.movedIdentity,
      );
    } catch (error) {
      if (error instanceof AtomicMoveUncertainError) {
        this.published = true;
        throw error;
      }
      try {
        await unlinkOwnedPath(
          this.destination.candidate,
          this.movedIdentity,
          "Atomic create candidate",
        );
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
    if (!moved) {
      await unlinkOwnedPath(
        this.destination.candidate,
        this.movedIdentity,
        "Atomic create candidate",
      );
      throw new Error(`File appeared before create: ${this.destination.target}.`);
    }
    this.published = true;
  }

  private async publishLinkOrCopy(): Promise<void> {
    try {
      throwIfAborted(this.signal);
      await link(this.destination.stagedTarget, this.destination.target);
      this.published = true;
    } catch (error) {
      if (isCode(error, "EEXIST")) {
        throw new Error(`File appeared before create: ${this.destination.target}.`, {
          cause: error,
        });
      }
      if (!fallbackAllowed(error)) {
        throw error;
      }
      await this.publishCopy();
    }
  }

  private async publishCopy(): Promise<void> {
    this.publication = "copy";
    await assertPublishedDirectoriesCurrent(this.destination.directories);
    throwIfAborted(this.signal);
    this.copyHandle = await open(this.destination.target, "wx", 0o666);
    this.published = true;
    const opened = await this.copyHandle.stat({ bigint: true });
    const pathStats = await lstat(this.destination.target, { bigint: true });
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || !sameIdentity(opened, pathStats)) {
      throw new Error(`Created file path changed during publication: ${this.destination.target}.`);
    }
    try {
      await assertPublishedDirectoriesCurrent(this.destination.directories);
      throwIfAborted(this.signal);
    } catch (error) {
      try {
        const removed = await unlinkOwnedPath(
          this.destination.target,
          opened,
          "Escaped fallback create file",
        );
        if (!removed) {
          throw new Error(
            `Fallback create file location changed before cleanup: ${this.destination.target}.`,
            { cause: error },
          );
        }
        this.published = false;
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      } finally {
        await this.copyHandle.close();
        this.copyHandle = undefined;
      }
      throw error;
    }
    await this.copyHandle.writeFile(this.entry.bytes, { signal: this.signal });
    await this.copyHandle.sync();
    const copied = await this.copyHandle.stat({ bigint: true });
    await this.copyHandle.close();
    this.copyHandle = undefined;
    const state = await readStableRegularEntry(this.destination.target);
    if (!samePublishedState(copied, state.stats) || !state.bytes.equals(this.entry.bytes)) {
      throw new Error(`Created file changed during publication: ${this.destination.target}.`);
    }
    this.destination.warn(
      `Atomic hard-link publication was unavailable for ${this.destination.target}; exclusive create fallback was used.`,
    );
  }

  private async verify(): Promise<void> {
    const state = await readStableRegularEntry(this.destination.target);
    if (!state.bytes.equals(this.entry.bytes)) {
      throw new Error(`Created file changed during publication: ${this.destination.target}.`);
    }
    if (this.publication !== "copy") {
      const staged = await readStableFile(this.destination.stagedTarget);
      const identity = this.publication === "link" ? staged.stats : this.movedIdentity;
      if (
        !identity ||
        !sameIdentity(identity, state.stats) ||
        !staged.bytes.equals(this.entry.bytes)
      ) {
        throw new Error(
          `Staged create file changed during publication: ${this.destination.stagedTarget}.`,
        );
      }
      this.destination.rememberStaging(staged.stats);
    }
    try {
      await assertPublishedDirectoriesCurrent(this.destination.directories);
    } catch (error) {
      if (this.publication !== "copy") {
        await this.rollback(state.stats, error);
      }
      throw error;
    }
    this.verified = true;
  }

  private async rollback(stats: BigIntStats, failure: unknown): Promise<void> {
    try {
      const removed = await unlinkOwnedPath(this.destination.target, stats, "Escaped create file");
      if (!removed) {
        throw new Error(
          `Created file location changed before cleanup: ${this.destination.target}.`,
        );
      }
      const restored = await readStableFile(this.destination.stagedTarget);
      if (
        !this.destination.stagedIdentity ||
        !sameIdentity(this.destination.stagedIdentity, restored.stats) ||
        !restored.bytes.equals(this.entry.bytes)
      ) {
        throw new Error(
          `Staged create file changed during rollback: ${this.destination.stagedTarget}.`,
        );
      }
      this.destination.rememberStaging(restored.stats);
      this.published = false;
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(failure)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
        { cause: cleanupError },
      );
    }
  }
}

export function fallbackAllowed(error: unknown): boolean {
  return (
    isCode(error, "EACCES") ||
    isCode(error, "EPERM") ||
    isCode(error, "ENOTSUP") ||
    isCode(error, "ENOSYS")
  );
}
