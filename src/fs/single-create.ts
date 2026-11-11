import type { BigIntStats } from "node:fs";
import { link, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ReadonlyNewFilePlan,
  ReadonlyNewFilePublishHooks,
  ReplacementSupport,
} from "./contracts.ts";
import {
  assertCreatedDirectoryOwner,
  discardAtomicCreateCandidate,
  rmdirOwnedPath,
  temporaryDirectoryPath,
  unlinkOwnedPath,
} from "./cleanup.ts";
import {
  errorMessage,
  fallbackAllowed,
  isCode,
  PublicationError,
  throwIfAborted,
} from "./errors.ts";
import { publishExclusiveCreate } from "./exclusive-create.ts";
import {
  assertPreparedFileCurrent,
  readStableFile,
  readStableRegularEntry,
  sameIdentity,
  sameSnapshotStats,
  syncDirectory,
} from "./observation.ts";
import { assertNewFilePlanCurrent, TraversalDirectories } from "./planning.ts";
import {
  movePreparedFileNoReplace,
  type PublicationEvidence,
  replacementSupportInfo,
  transferMacosAcl,
} from "./platform.ts";
import { preparePrivatePublicationFile } from "./preparation.ts";

type CreatePublication =
  | { readonly kind: "not-visible" }
  | { readonly kind: "visible-unverified" }
  | { readonly kind: "verified" };

export async function publishSingleNewFile(
  plan: ReadonlyNewFilePlan,
  bytes: Buffer,
  signal?: AbortSignal,
  hooks?: ReadonlyNewFilePublishHooks,
): Promise<string[]> {
  return new SingleCreation(plan, bytes, signal, hooks).run();
}

/** Owns a single create's private source and commit/verification/cleanup state. */
class SingleCreation {
  private readonly plan: ReadonlyNewFilePlan;
  private readonly bytes: Buffer;
  private readonly signal: AbortSignal | undefined;
  private readonly hooks: ReadonlyNewFilePublishHooks | undefined;
  private readonly directory: string;
  private readonly temporaryDirectory: string;
  private readonly temporary: string;
  private readonly traversal = new TraversalDirectories();
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private temporaryStats: BigIntStats | undefined;
  private temporaryIdentity: BigIntStats | undefined;
  private temporaryDirectoryStats: BigIntStats | undefined;
  private publication: CreatePublication = { kind: "not-visible" };
  private sourceCleanup: "eligible" | "retained" | "handled" = "eligible";
  private temporaryCleanupFailed = false;
  private readonly warnings: string[] = [];

  constructor(
    plan: ReadonlyNewFilePlan,
    bytes: Buffer,
    signal?: AbortSignal,
    hooks?: ReadonlyNewFilePublishHooks,
  ) {
    this.plan = plan;
    this.bytes = bytes;
    this.signal = signal;
    this.hooks = hooks;
    this.directory = dirname(plan.targetPath);
    this.temporaryDirectory = temporaryDirectoryPath(plan.targetPath);
    this.temporary = join(this.temporaryDirectory, "create");
  }

  async run(): Promise<string[]> {
    const support = await replacementSupportInfo();
    let failed = false;
    let failure: unknown;
    try {
      await this.prepare();
      await this.hooks?.beforeFilePublish?.({
        temporary: this.temporary,
        target: this.plan.targetPath,
      });
      await assertPreparedFileCurrent(
        this.temporary,
        this.temporaryStats,
        this.bytes,
        "Temporary create file",
      );
      await this.traversal.publish([this.plan], this.signal);
      throwIfAborted(this.signal);
      await this.publish(support);
      await this.cleanupCommittedSource();
      const warning = await syncDirectory(this.directory);
      if (warning !== undefined) {
        this.warnings.push(warning);
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    await this.cleanupUncommitted(failure);
    if (failed) {
      throw this.receipt(errorMessage(failure), failure);
    }
    return this.warnings;
  }

  private receipt(message: string, cause?: unknown): PublicationError {
    return new PublicationError(
      message,
      this.publication.kind === "verified" ? [this.plan.targetPath] : [],
      this.publication.kind === "visible-unverified" ? [this.plan.targetPath] : [],
      cause,
    );
  }

  private async prepare(): Promise<void> {
    throwIfAborted(this.signal);
    try {
      await lstat(this.plan.targetPath);
      throw new Error(
        `File appeared before create: ${this.plan.targetPath}. No changes were written.`,
      );
    } catch (error) {
      if (!isCode(error, "ENOENT")) {
        throw error;
      }
    }
    await assertNewFilePlanCurrent(this.plan);
    await mkdir(this.temporaryDirectory, { mode: 0o700 });
    const directory = await lstat(this.temporaryDirectory, { bigint: true });
    assertCreatedDirectoryOwner(directory, this.temporaryDirectory);
    this.temporaryDirectoryStats = directory;
    await transferMacosAcl(this.directory, this.temporaryDirectory, "inherit", this.signal);
    this.handle = await open(this.temporary, "wx", 0o666);
    this.temporaryIdentity = await this.handle.stat({ bigint: true });
    await this.handle.writeFile(this.bytes, { signal: this.signal });
    await this.handle.sync();
    this.temporaryStats = await this.handle.stat({ bigint: true });
    await this.handle.close();
    this.handle = undefined;
    throwIfAborted(this.signal);
    const current = await lstat(this.temporary, { bigint: true });
    if (!sameSnapshotStats(this.temporaryStats, current)) {
      throw new Error(
        `Temporary file changed before create: ${this.temporary}. No changes were written.`,
      );
    }
  }

  private async publish(support: ReplacementSupport): Promise<void> {
    try {
      if (support.supported && support.strategy === "exchange") {
        await this.publishMove();
      } else {
        await this.publishLink();
      }
    } catch (error) {
      if (this.publication.kind !== "not-visible") {
        throw error;
      }
      if (isCode(error, "EEXIST")) {
        throw new Error(
          `File appeared before create: ${this.plan.targetPath}. No changes were written.`,
          { cause: error },
        );
      }
      if (!fallbackAllowed(error)) {
        throw error;
      }
      const outcome = await publishExclusiveCreate(
        this.plan,
        this.bytes,
        this.temporary,
        this.signal,
      );
      switch (outcome.kind) {
        case "verified":
          this.publication = { kind: "verified" };
          this.warnings.push(
            "Atomic hard-link publication was unavailable; used exclusive write publication.",
          );
          return;
        case "before-visible-failure":
          this.publication = { kind: "not-visible" };
          break;
        case "visible-unverified-failure":
          this.publication = { kind: "visible-unverified" };
          if (outcome.sourceCleanup === "retain") {
            this.sourceCleanup = "retained";
          }
          break;
      }
      if (outcome.error instanceof Error) {
        throw outcome.error;
      }
      throw new Error(errorMessage(outcome.error), { cause: error });
    }
  }

  private async publishMove(): Promise<void> {
    const candidate = join(this.temporaryDirectory, "publish");
    const stats = await preparePrivatePublicationFile(candidate, this.bytes, this.signal);
    let evidence: PublicationEvidence;
    try {
      evidence = await movePreparedFileNoReplace(candidate, this.plan.targetPath, stats);
    } catch (error) {
      return discardAtomicCreateCandidate(candidate, stats, error);
    }
    if (evidence.kind === "uncertain") {
      this.publication = { kind: "visible-unverified" };
      this.sourceCleanup = "retained";
      throw evidence.error;
    }
    if (evidence.kind === "not-published") {
      return discardAtomicCreateCandidate(
        candidate,
        stats,
        evidence.cause ??
          new Error(
            `File appeared before create: ${this.plan.targetPath}. No changes were written.`,
          ),
      );
    }
    this.publication = { kind: "visible-unverified" };
    await this.hooks?.afterFilePublish?.({ target: this.plan.targetPath });
    await this.verifyPublication(stats);
  }

  private async publishLink(): Promise<void> {
    await link(this.temporary, this.plan.targetPath);
    this.publication = { kind: "visible-unverified" };
    await this.hooks?.afterFilePublish?.({ target: this.plan.targetPath });
    const state = await this.readPublishedTarget();
    const temporary = await readStableFile(this.temporary);
    if (!sameIdentity(temporary.stats, state.stats) || !state.bytes.equals(this.bytes)) {
      throw new Error(`Created file changed during publication: ${this.plan.targetPath}.`);
    }
    await this.verifyParent(state.stats);
    this.publication = { kind: "verified" };
  }

  private async verifyPublication(identity: BigIntStats): Promise<void> {
    const state = await this.readPublishedTarget();
    if (!sameIdentity(identity, state.stats) || !state.bytes.equals(this.bytes)) {
      throw new Error(`Created file changed during publication: ${this.plan.targetPath}.`);
    }
    await this.verifyParent(state.stats);
    this.publication = { kind: "verified" };
  }

  private async readPublishedTarget(): Promise<{
    readonly stats: BigIntStats;
    readonly bytes: Buffer;
  }> {
    try {
      return await readStableRegularEntry(this.plan.targetPath);
    } catch (error) {
      this.sourceCleanup = "retained";
      throw new Error(
        `Create publication could not be verified at ${this.plan.targetPath}. Commit status is uncertain; nothing was rolled back. Inspect ${this.plan.targetPath} and the temporary source ${this.temporary}, and their new locations if a parent directory moved. Cause: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async verifyParent(stats: BigIntStats): Promise<void> {
    try {
      await assertNewFilePlanCurrent(this.plan);
    } catch (parentError) {
      try {
        const outcome = await unlinkOwnedPath(this.plan.targetPath, stats, "Escaped create file");
        if (outcome.kind !== "unlinked") {
          throw new Error(
            `Created file location changed before cleanup: ${this.plan.targetPath}.`,
            { cause: parentError },
          );
        }
        this.publication = { kind: "not-visible" };
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(parentError)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw parentError;
    }
  }

  private async cleanupCommittedSource(): Promise<void> {
    this.sourceCleanup = "handled";
    try {
      const outcome = await unlinkOwnedPath(
        this.temporary,
        this.temporaryIdentity,
        "Temporary create file",
      );
      if (outcome.kind !== "unlinked") {
        this.warnings.push(
          `The file was created, but its temporary link is no longer at ${this.temporary}; its location is uncertain and the created file may remain hard-linked to it.`,
        );
      }
    } catch (error) {
      this.temporaryCleanupFailed = true;
      this.warnings.push(
        `The file was created, but its temporary link's cleanup failed and its final state is unknown; it may remain at ${this.temporary} or elsewhere, possibly hard-linked to the created file, or only leftover temporary directories may remain: ${errorMessage(error)}`,
      );
    }
    if (this.temporaryDirectoryStats && !this.temporaryCleanupFailed) {
      try {
        await rmdirOwnedPath(
          this.temporaryDirectory,
          this.temporaryDirectoryStats,
          "Temporary create directory",
        );
      } catch (error) {
        this.warnings.push(
          `The file was created, but its temporary directory remains at ${this.temporaryDirectory}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private async cleanupUncommitted(failure: unknown): Promise<void> {
    await this.handle?.close().catch(() => {
      // Descriptor-close failure must not replace the publication and identity-cleanup outcome.
    });
    if (this.sourceCleanup !== "eligible") {
      return;
    }
    const failures: string[] = [];
    const temporaryFailure = await this.removeTemporary();
    if (temporaryFailure !== undefined) {
      failures.push(temporaryFailure);
    }
    if (this.temporaryDirectoryStats && !this.temporaryCleanupFailed) {
      try {
        await rmdirOwnedPath(
          this.temporaryDirectory,
          this.temporaryDirectoryStats,
          "Temporary create directory",
        );
      } catch (error) {
        failures.push(`${this.temporaryDirectory}: ${errorMessage(error)}`);
      }
    }
    try {
      await this.traversal.remove();
    } catch (error) {
      failures.push(errorMessage(error));
    }
    if (failures.length > 0) {
      throw this.receipt(
        `${failure === undefined ? "Create failed. " : `${errorMessage(failure)} `}Cleanup was incomplete: ${failures.join("; ")}`,
        failure,
      );
    }
  }

  private async removeTemporary(): Promise<string | undefined> {
    try {
      const outcome = await unlinkOwnedPath(
        this.temporary,
        this.temporaryIdentity,
        "Temporary create file",
      );
      if (outcome.kind !== "unlinked" && this.temporaryIdentity) {
        return `the temporary create file is no longer at ${this.temporary}; its location is uncertain and its content may remain elsewhere`;
      }
    } catch (error) {
      this.temporaryCleanupFailed = true;
      return `the temporary create file's cleanup failed and its final state is unknown; it may remain at ${this.temporary} or elsewhere, or only leftover temporary directories may remain: ${errorMessage(error)}`;
    }
    return;
  }
}
