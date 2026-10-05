import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { NewFilePlan } from "./contracts.ts";
import { unlinkOwnedPath } from "./cleanup.ts";
import { errorMessage, isCode, throwIfAborted } from "./errors.ts";
import { readStableRegularEntry, sameIdentity, samePublishedState } from "./observation.ts";
import { assertNewFilePlanCurrent } from "./planning.ts";

export interface ExclusiveCreateOutcome {
  readonly completed: boolean;
  readonly publicationStarted: boolean;
  readonly retainTemporary: boolean;
  readonly error?: unknown;
}

/** Owns the exclusive-create descriptor and incomplete-file recovery when hard linking is unavailable. */
export async function publishExclusiveCreate(
  plan: NewFilePlan,
  bytes: Buffer,
  temporary: string,
  signal?: AbortSignal,
): Promise<ExclusiveCreateOutcome> {
  return new ExclusiveCreation(plan, bytes, temporary, signal).run();
}

class ExclusiveCreation {
  private readonly plan: NewFilePlan;
  private readonly bytes: Buffer;
  private readonly temporary: string;
  private readonly signal: AbortSignal | undefined;
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private targetStats: BigIntStats | undefined;
  private targetActualPath: string | undefined;
  private writeCompleted = false;
  private publicationStarted = false;
  private retainTemporary = false;

  constructor(plan: NewFilePlan, bytes: Buffer, temporary: string, signal?: AbortSignal) {
    this.plan = plan;
    this.bytes = bytes;
    this.temporary = temporary;
    this.signal = signal;
  }

  async run(): Promise<ExclusiveCreateOutcome> {
    try {
      await this.create();
      return { completed: true, publicationStarted: true, retainTemporary: true };
    } catch (error) {
      await this.handle?.close().catch(() => {
        // Preserve the original write failure while identity-checked target recovery runs.
      });
      let failure: unknown;
      try {
        await this.recoverFailure(error);
        failure = error;
      } catch (recoveryError) {
        failure = recoveryError;
      }
      return {
        completed: false,
        publicationStarted: this.publicationStarted,
        retainTemporary: this.retainTemporary,
        error: failure,
      };
    }
  }

  private async create(): Promise<void> {
    const target = this.plan.targetPath;
    await assertNewFilePlanCurrent(this.plan);
    throwIfAborted(this.signal);
    this.handle = await open(target, "wx", 0o666);
    this.publicationStarted = true;
    this.targetStats = await this.handle.stat({ bigint: true });
    this.targetActualPath = target;
    const pathStats = await lstat(target, { bigint: true });
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      !sameIdentity(this.targetStats, pathStats)
    ) {
      throw new Error(`Created file path changed during publication: ${target}.`);
    }
    await assertNewFilePlanCurrent(this.plan);
    throwIfAborted(this.signal);
    await this.handle.writeFile(this.bytes, { signal: this.signal });
    await this.handle.sync();
    const copied = await this.handle.stat({ bigint: true });
    await this.handle.close();
    this.handle = undefined;
    const state = await readStableRegularEntry(target);
    if (!samePublishedState(copied, state.stats) || !state.bytes.equals(this.bytes)) {
      throw new Error(`Created file changed during publication: ${target}.`);
    }
    this.writeCompleted = true;
    this.retainTemporary = true;
    try {
      await assertNewFilePlanCurrent(this.plan);
    } catch (parentError) {
      throw new Error(
        `${errorMessage(parentError)} The created file and temporary source were retained at ${target} and ${this.temporary}.`,
        { cause: parentError },
      );
    }
  }

  private async recoverFailure(error: unknown): Promise<void> {
    if (this.targetStats && !this.writeCompleted && this.targetActualPath !== undefined) {
      await this.removeIncompleteTarget(error);
    }
    if (this.targetStats) {
      throw new Error(
        `Create failed after ${this.targetActualPath ?? this.plan.targetPath} became visible. It may be partial and was left untouched: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (isCode(error, "EEXIST")) {
      throw new Error(
        `File appeared before create: ${this.plan.targetPath}. No changes were written.`,
        { cause: error },
      );
    }
  }

  private async removeIncompleteTarget(error: unknown): Promise<void> {
    const stats = this.targetStats;
    const path = this.targetActualPath;
    if (!stats || path === undefined) {
      return;
    }
    let removed: boolean;
    try {
      removed = await unlinkOwnedPath(path, stats, "Incomplete fallback create file");
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    if (!removed) {
      this.retainTemporary = true;
      throw new Error(
        "Create publication location changed after exclusive open. Commit status is uncertain; inspect the moved parent.",
      );
    }
    this.targetStats = undefined;
    this.publicationStarted = false;
  }
}
