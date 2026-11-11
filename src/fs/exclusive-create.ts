import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ReadonlyNewFilePlan } from "./contracts.ts";
import { unlinkOwnedPath, type CleanupOutcome } from "./cleanup.ts";
import { errorMessage, isCode, throwIfAborted } from "./errors.ts";
import { readStableRegularEntry, sameIdentity, samePublishedState } from "./observation.ts";
import { assertNewFilePlanCurrent } from "./planning.ts";

export type ExclusiveCreateOutcome =
  | { readonly kind: "verified" }
  | { readonly kind: "before-visible-failure"; readonly error: unknown }
  | {
      readonly kind: "visible-unverified-failure";
      readonly sourceCleanup: "eligible" | "retain";
      readonly error: unknown;
    };

type ExclusiveTarget =
  | { readonly kind: "not-visible" }
  | {
      readonly kind: "visible";
      /** The created inode once known; "unknown" when the post-open stat failed. */
      readonly removal: { readonly identity: BigIntStats } | "unknown";
    }
  | { readonly kind: "content-verified"; readonly path: string }
  | { readonly kind: "location-unknown" };

/** Owns the exclusive-create descriptor and incomplete-file recovery when hard linking is unavailable. */
export async function publishExclusiveCreate(
  plan: ReadonlyNewFilePlan,
  bytes: Buffer,
  temporary: string,
  signal?: AbortSignal,
): Promise<ExclusiveCreateOutcome> {
  return new ExclusiveCreation(plan, bytes, temporary, signal).run();
}

class ExclusiveCreation {
  private readonly plan: ReadonlyNewFilePlan;
  private readonly bytes: Buffer;
  private readonly temporary: string;
  private readonly signal: AbortSignal | undefined;
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private target: ExclusiveTarget = { kind: "not-visible" };

  constructor(plan: ReadonlyNewFilePlan, bytes: Buffer, temporary: string, signal?: AbortSignal) {
    this.plan = plan;
    this.bytes = bytes;
    this.temporary = temporary;
    this.signal = signal;
  }

  async run(): Promise<ExclusiveCreateOutcome> {
    try {
      await this.create();
      return { kind: "verified" };
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
      return this.failureOutcome(failure);
    }
  }

  private failureOutcome(error: unknown): ExclusiveCreateOutcome {
    switch (this.target.kind) {
      case "not-visible":
        return { kind: "before-visible-failure", error };
      case "visible":
        return { kind: "visible-unverified-failure", sourceCleanup: "eligible", error };
      case "content-verified":
      case "location-unknown":
        return { kind: "visible-unverified-failure", sourceCleanup: "retain", error };
    }
  }

  private async create(): Promise<void> {
    const target = this.plan.targetPath;
    await assertNewFilePlanCurrent(this.plan);
    throwIfAborted(this.signal);
    this.handle = await open(target, "wx", 0o666);
    this.target = { kind: "visible", removal: "unknown" };
    const targetStats = await this.handle.stat({ bigint: true });
    this.target = { kind: "visible", removal: { identity: targetStats } };
    const pathStats = await lstat(target, { bigint: true });
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      !sameIdentity(targetStats, pathStats)
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
    this.target = { kind: "content-verified", path: target };
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
    if (this.target.kind === "visible" && this.target.removal !== "unknown") {
      await this.removeIncompleteTarget(this.target.removal.identity, error);
    }
    if (this.target.kind === "content-verified") {
      throw new Error(
        `Create failed after ${this.target.path} was written and verified. The created file was left untouched: ${errorMessage(error)}`,
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

  private async removeIncompleteTarget(identity: BigIntStats, error: unknown): Promise<void> {
    let outcome: CleanupOutcome;
    try {
      outcome = await unlinkOwnedPath(
        this.plan.targetPath,
        identity,
        "Incomplete fallback create file",
      );
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    if (outcome.kind !== "unlinked") {
      this.target = { kind: "location-unknown" };
      throw new Error(
        "Create publication location changed after exclusive open. Commit status is uncertain; inspect the moved parent.",
      );
    }
    this.target = { kind: "not-visible" };
  }
}
