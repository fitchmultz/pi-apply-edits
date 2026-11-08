import type { BigIntStats } from "node:fs";
import { link, lstat, open } from "node:fs/promises";
import type {
  ReadonlyNewFilePublishHooks,
  ReadonlyPlannedNewFile,
  ReplacementSupport,
} from "./contracts.ts";
import { assertPublishedDirectoriesCurrent, unlinkOwnedPath } from "./cleanup.ts";
import {
  AtomicMoveUncertainError,
  errorMessage,
  fallbackAllowed,
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
  readonly hooks?: ReadonlyNewFilePublishHooks | undefined;
  readonly rememberStaging: (stats: BigIntStats) => void;
  readonly warn: (message: string) => void;
}

export async function publishNestedFile(
  entry: ReadonlyPlannedNewFile,
  destination: NestedFileDestination,
  support: ReplacementSupport,
  signal?: AbortSignal,
): Promise<void> {
  await new NestedFilePublication(entry, destination, support, signal).run();
}

type NestedFileStrategy =
  | { readonly kind: "link" }
  | { readonly kind: "move"; readonly identity: BigIntStats }
  | {
      readonly kind: "copy";
      readonly descriptor:
        | { readonly kind: "open"; readonly handle: Awaited<ReturnType<typeof open>> }
        | { readonly kind: "closed" };
    };

/** Owns one staged file's link/move/copy transition and its identity-checked rollback. */
class NestedFilePublication {
  private readonly entry: ReadonlyPlannedNewFile;
  private readonly destination: NestedFileDestination;
  private readonly support: ReplacementSupport;
  private readonly signal: AbortSignal | undefined;
  private strategy: NestedFileStrategy = { kind: "link" };
  private evidence: "unpublished" | "unverified" | "verified" = "unpublished";

  constructor(
    entry: ReadonlyPlannedNewFile,
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
      if (this.strategy.kind === "copy" && this.strategy.descriptor.kind === "open") {
        await this.strategy.descriptor.handle.close().catch(() => {
          // Preserve publication failure and the target's verified/uncertain receipt.
        });
      }
      throw new PublicationError(
        errorMessage(error),
        this.evidence === "verified" ? [this.destination.target] : [],
        this.evidence === "unverified" ? [this.destination.target] : [],
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
    const identity = await preparePrivatePublicationFile(
      this.destination.candidate,
      this.entry.bytes,
      this.signal,
    );
    this.strategy = { kind: "move", identity };
    await assertPublishedDirectoriesCurrent(this.destination.directories);
    throwIfAborted(this.signal);
    let moved: boolean;
    try {
      moved = await movePreparedFileNoReplace(
        this.destination.candidate,
        this.destination.target,
        identity,
      );
    } catch (error) {
      if (error instanceof AtomicMoveUncertainError) {
        this.evidence = "unverified";
        throw error;
      }
      try {
        await unlinkOwnedPath(this.destination.candidate, identity, "Atomic create candidate");
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
    if (!moved) {
      await unlinkOwnedPath(this.destination.candidate, identity, "Atomic create candidate");
      throw new Error(`File appeared before create: ${this.destination.target}.`);
    }
    this.evidence = "unverified";
  }

  private async publishLinkOrCopy(): Promise<void> {
    try {
      throwIfAborted(this.signal);
      await link(this.destination.stagedTarget, this.destination.target);
      this.evidence = "unverified";
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
    await assertPublishedDirectoriesCurrent(this.destination.directories);
    throwIfAborted(this.signal);
    const handle = await open(this.destination.target, "wx", 0o666);
    this.strategy = { kind: "copy", descriptor: { kind: "open", handle } };
    this.evidence = "unverified";
    const opened = await handle.stat({ bigint: true });
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
        this.evidence = "unpublished";
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      } finally {
        await handle.close();
        this.strategy = { kind: "copy", descriptor: { kind: "closed" } };
      }
      throw error;
    }
    await handle.writeFile(this.entry.bytes, { signal: this.signal });
    await handle.sync();
    const copied = await handle.stat({ bigint: true });
    await handle.close();
    this.strategy = { kind: "copy", descriptor: { kind: "closed" } };
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
    if (this.strategy.kind !== "copy") {
      const staged = await readStableFile(this.destination.stagedTarget);
      const identity = this.strategy.kind === "link" ? staged.stats : this.strategy.identity;
      if (!sameIdentity(identity, state.stats) || !staged.bytes.equals(this.entry.bytes)) {
        throw new Error(
          `Staged create file changed during publication: ${this.destination.stagedTarget}.`,
        );
      }
      this.destination.rememberStaging(staged.stats);
    }
    try {
      await assertPublishedDirectoriesCurrent(this.destination.directories);
    } catch (error) {
      if (this.strategy.kind !== "copy") {
        await this.rollback(state.stats, error);
      }
      throw error;
    }
    this.evidence = "verified";
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
      this.evidence = "unpublished";
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(failure)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
        { cause: cleanupError },
      );
    }
  }
}
