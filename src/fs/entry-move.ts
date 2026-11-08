import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertEntryMovePathBudget, assertPlannedPathBudget } from "../path-budget.ts";
import { operationPath } from "../native-path.ts";
import type {
  EntryMovePlan,
  MoveReplacement,
  ReadonlyEntryMovePlan,
  ReadonlyEntryPublishHooks,
  ReadonlyEntrySnapshot,
  ReadonlyNewFilePlan,
} from "./contracts.ts";
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
  lstatIfExists,
  readStableRegularEntry,
  sameIdentity,
  sameLinkedSnapshot,
  samePublishedState,
  sameSnapshotStats,
  syncDirectory,
} from "./observation.ts";
import {
  assertDirectoryWritableForPublish,
  assertNewFilePlanCurrent,
  planNewFile,
  TraversalDirectories,
} from "./planning.ts";
import { linkEntry, movePreparedFileNoReplace, replacementSupportInfo } from "./platform.ts";
import { assertMoveSnapshot, prepareMoveReplacement } from "./preparation.ts";
import { isRespelling, publishRespelling } from "./entry-respelling.ts";
import { assertPublicationFilesystem } from "./volume-support.ts";
import {
  assertEntryCurrent,
  assertEntryParentCurrent,
  assertSafeToReplace,
  assertSnapshotCurrent,
} from "./snapshot.ts";
import { publishEntryDelete } from "./entry-delete.ts";

export async function planEntryMove<Entry extends ReadonlyEntrySnapshot>(
  entry: Entry,
  destinationPath: string,
  signal?: AbortSignal,
  preview = false,
): Promise<EntryMovePlan<Entry>> {
  throwIfAborted(signal);
  await assertEntryCurrent(entry);
  assertPlannedPathBudget(destinationPath, [operationPath(destinationPath)]);
  const destination = await planNewFile(destinationPath, !preview);
  const respelling = await existingRespelling(entry, destination);
  if (entry.stats.dev !== destination.ancestorDev) {
    throw new Error(
      `Cross-device moves are not supported: ${entry.inputPath} -> ${destination.inputPath}. No changes were written.`,
    );
  }
  if (process.platform === "win32" && entry.symbolicLink) {
    throw new Error(
      "No-clobber symbolic-link moves are unavailable on Windows. No changes were written.",
    );
  }
  if (!preview) {
    assertEntryMovePathBudget(entry.actualPath, destination, entry.inputPath);
    await assertDirectoryWritableForPublish(entry.parentPath, entry.inputPath);
    // A respelling renames the entry in place, so it needs no hard links.
    if (respelling) {
      await assertPublicationFilesystem(entry.parentPath, destination.inputPath, false);
    } else {
      await assertNoClobberMoveSupport(entry, destination);
    }
  }
  throwIfAborted(signal);
  return respelling ? { entry, destination, respelling } : { entry, destination };
}

/** Returns whether an existing destination is the source respelled; any other entry fails. */
async function existingRespelling(
  entry: ReadonlyEntrySnapshot,
  destination: ReadonlyNewFilePlan,
): Promise<boolean> {
  const existing = await lstatIfExists(destination.targetPath);
  if (existing === undefined) {
    return false;
  }
  if (await isRespelling(entry, destination.targetPath, existing)) {
    return true;
  }
  throw new Error(
    `Move destination already exists: ${destination.inputPath}. No changes were written.`,
  );
}

async function assertNoClobberMoveSupport(
  entry: ReadonlyEntrySnapshot,
  destination: ReadonlyNewFilePlan,
): Promise<void> {
  if (process.platform !== "android") {
    await assertPublicationFilesystem(destination.ancestorPath, destination.inputPath, true);
    await probeEntryLink(entry, destination.ancestorPath, destination.inputPath);
    return;
  }
  const support = await replacementSupportInfo();
  if (!support.supported || support.strategy !== "exchange") {
    throw new Error(
      "No-clobber entry moves require supported Termux coreutils. No changes were written.",
    );
  }
}

async function probeEntryLink(
  entry: ReadonlyEntrySnapshot,
  ancestorPath: string,
  label: string,
): Promise<void> {
  // Probe private empty files only, never the requested source or destination.
  const probe = temporaryPath(entry.actualPath);
  const target = temporaryPath(join(ancestorPath, "probe"));
  if (entry.symbolicLink) {
    await symlink("missing-probe-target", probe);
  } else {
    await writeFile(probe, "", { flag: "wx", mode: 0o600 });
  }
  const probeStats = await lstat(probe, { bigint: true });
  try {
    await linkEntry(probe, target, entry.symbolicLink);
    const [before, after] = await Promise.all([
      lstat(probe, { bigint: true }),
      lstat(target, { bigint: true }),
    ]);
    if (!sameIdentity(before, after)) {
      throw new Error("The filesystem did not preserve the source entry");
    }
  } catch (error) {
    throw new Error(
      `No-clobber moves are unavailable for ${label}: ${errorMessage(error)}. No changes were written.`,
      { cause: error },
    );
  } finally {
    try {
      await unlinkOwnedPath(target, probeStats, "Move probe link");
    } finally {
      await unlinkOwnedPath(probe, probeStats, "Move probe source");
    }
  }
}

export interface MoveCandidate {
  readonly path: string;
  readonly stats: BigIntStats;
  readonly replacement?: MoveReplacement | undefined;
  readonly hooks?: ReadonlyEntryPublishHooks | undefined;
}

export async function publishMoveDestination(
  plan: ReadonlyEntryMovePlan,
  candidate: MoveCandidate,
  signal?: AbortSignal,
): Promise<string[]> {
  return new DestinationMove(plan, candidate, signal).run();
}

type MoveStage =
  | { readonly kind: "not-started" }
  | { readonly kind: "destination-unverified" }
  | { readonly kind: "destination-verified" }
  | { readonly kind: "source-removal-verified" };

class DestinationMove {
  private readonly plan: ReadonlyEntryMovePlan;
  private readonly candidate: MoveCandidate;
  private readonly signal: AbortSignal | undefined;
  private readonly modified: string[] = [];
  private readonly traversal = new TraversalDirectories();
  private readonly atomicMove = process.platform === "android";
  private stage: MoveStage = { kind: "not-started" };

  constructor(plan: ReadonlyEntryMovePlan, candidate: MoveCandidate, signal?: AbortSignal) {
    this.plan = plan;
    this.candidate = candidate;
    this.signal = signal;
  }

  async run(): Promise<string[]> {
    try {
      await this.validate();
      await this.candidate.hooks?.beforeCommit?.();
      await this.validateCandidate();
      await this.traversal.publish([this.plan.destination], this.signal);
      throwIfAborted(this.signal);
      await this.publish();
      await this.verifyDestination();
      return await this.finishSource();
    } catch (error) {
      if (this.stage.kind === "not-started") {
        try {
          await this.traversal.remove();
        } catch (cleanupError) {
          throw new Error(
            `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
            { cause: cleanupError },
          );
        }
      }
      throw this.publicationFailure(error);
    }
  }

  private async validateCandidate(): Promise<void> {
    await assertEntryCurrent(this.plan.entry);
    if (this.candidate.replacement) {
      await assertSnapshotCurrent(this.candidate.replacement.snapshot);
      await assertPreparedFileCurrent(
        this.candidate.path,
        this.candidate.stats,
        this.candidate.replacement.bytes,
        "Prepared move file",
      );
    }
  }

  private async validate(): Promise<void> {
    assertMoveSnapshot(this.plan.entry, this.candidate.replacement?.snapshot);
    await this.validateCandidate();
    await assertNewFilePlanCurrent(this.plan.destination);
  }

  private async publish(): Promise<void> {
    try {
      if (this.atomicMove) {
        if (
          !(await movePreparedFileNoReplace(
            this.candidate.path,
            this.plan.destination.targetPath,
            this.candidate.stats,
          ))
        ) {
          throw new Error(
            `Move destination appeared before commit: ${this.plan.destination.inputPath}`,
          );
        }
      } else {
        await linkEntry(
          this.candidate.path,
          this.plan.destination.targetPath,
          this.plan.entry.symbolicLink,
        );
      }
    } catch (error) {
      if (error instanceof AtomicMoveUncertainError) {
        this.stage = { kind: "destination-unverified" };
      }
      throw error;
    }
    this.stage = { kind: "destination-unverified" };
  }

  private async verifyDestination(): Promise<void> {
    const { entry, destination } = this.plan;
    const published = await lstat(destination.targetPath, { bigint: true });
    const matches = this.atomicMove
      ? samePublishedState(this.candidate.stats, published)
      : sameLinkedSnapshot(this.candidate.stats, published);
    if (!matches) {
      throw new Error(`Move destination could not be verified: ${destination.inputPath}`);
    }
    if (this.candidate.replacement) {
      const state = await readStableRegularEntry(destination.targetPath);
      if (
        !sameSnapshotStats(published, state.stats) ||
        !state.bytes.equals(this.candidate.replacement.bytes)
      ) {
        throw new Error(`Moved content could not be verified: ${destination.inputPath}`);
      }
    } else if (
      entry.linkTarget &&
      !(await readlink(destination.targetPath, { encoding: "buffer" })).equals(entry.linkTarget)
    ) {
      throw new Error(`Moved symbolic link could not be verified: ${destination.inputPath}`);
    }
    await assertNewFilePlanCurrent(destination);
    this.modified.push(destination.targetPath);
    this.stage = { kind: "destination-verified" };
  }

  private async finishSource(): Promise<string[]> {
    const { entry, destination } = this.plan;
    const warnings =
      this.atomicMove && !this.candidate.replacement
        ? await this.finishAtomicSource()
        : await this.removeLinkedSource();
    for (const directory of new Set([entry.parentPath, dirname(destination.targetPath)])) {
      // Source and destination cleanup durability follows completed source removal.
      const warning = await syncDirectory(directory);
      if (warning !== undefined) {
        warnings.push(warning);
      }
    }
    return warnings;
  }

  private async finishAtomicSource(): Promise<string[]> {
    const { entry } = this.plan;
    await assertEntryParentCurrent(entry);
    if (await lstatIfExists(entry.actualPath)) {
      throw new Error(`Move source removal could not be verified: ${entry.inputPath}`);
    }
    this.modified.push(entry.actualPath);
    this.stage = { kind: "source-removal-verified" };
    await this.candidate.hooks?.afterCommit?.();
    return [];
  }

  private async removeLinkedSource(): Promise<string[]> {
    const { entry } = this.plan;
    await this.candidate.hooks?.afterCommit?.();
    await this.candidate.hooks?.beforeSourceDelete?.();
    const sourceStats = await lstat(entry.actualPath, { bigint: true });
    if (!this.candidate.replacement && !sameLinkedSnapshot(entry.stats, sourceStats)) {
      throw new Error(`Move source changed before removal: ${entry.inputPath}`);
    }
    if (this.candidate.replacement) {
      await assertSnapshotCurrent(this.candidate.replacement.snapshot);
    }
    // Once the destination is verified, finish removal even if cancellation arrives.
    const warnings = await publishEntryDelete(
      this.candidate.replacement ? entry : { ...entry, stats: sourceStats },
    );
    this.modified.push(entry.actualPath);
    this.stage = { kind: "source-removal-verified" };
    return warnings;
  }

  private publicationFailure(error: unknown): PublicationError {
    const child = error instanceof PublicationError ? error : undefined;
    const verified = [...new Set([...this.modified, ...(child?.modifiedFiles ?? [])])];
    const uncertain = [...(child?.uncertainFiles ?? []), ...this.unverifiedPublicationPaths()];
    return new PublicationError(
      errorMessage(error),
      verified,
      [...new Set(uncertain)].filter((path) => !verified.includes(path)),
      error,
    );
  }

  private unverifiedPublicationPaths(): string[] {
    const atomicSource = this.atomicMove && !this.candidate.replacement;
    switch (this.stage.kind) {
      case "not-started":
      case "source-removal-verified":
        return [];
      case "destination-unverified":
        return atomicSource
          ? [this.plan.destination.targetPath, this.plan.entry.actualPath]
          : [this.plan.destination.targetPath];
      case "destination-verified":
        return atomicSource ? [this.plan.entry.actualPath] : [];
      default: {
        const _exhaustive: never = this.stage;
        return _exhaustive;
      }
    }
  }
}

export async function publishDirectEntryMove(
  plan: ReadonlyEntryMovePlan,
  replacement?: MoveReplacement,
  signal?: AbortSignal,
  hooks?: ReadonlyEntryPublishHooks,
): Promise<string[]> {
  if (plan.respelling === true) {
    return publishRespelling(plan, replacement, signal, hooks);
  }
  if (!replacement) {
    return publishMoveDestination(
      plan,
      { path: plan.entry.actualPath, stats: plan.entry.stats, hooks },
      signal,
    );
  }
  return new ReplacementMove(plan, replacement, signal, hooks).run();
}

class ReplacementMove {
  private readonly plan: ReadonlyEntryMovePlan;
  private readonly replacement: MoveReplacement;
  private readonly signal: AbortSignal | undefined;
  private readonly hooks: ReadonlyEntryPublishHooks | undefined;
  private readonly directory: string;
  private readonly candidate: string;
  private directoryStats: BigIntStats | undefined;
  private candidateIdentity: BigIntStats | undefined;
  private readonly warnings: string[] = [];

  constructor(
    plan: ReadonlyEntryMovePlan,
    replacement: MoveReplacement,
    signal?: AbortSignal,
    hooks?: ReadonlyEntryPublishHooks,
  ) {
    this.plan = plan;
    this.replacement = replacement;
    this.signal = signal;
    this.hooks = hooks;
    this.directory = temporaryDirectoryPath(plan.entry.actualPath);
    this.candidate = join(this.directory, "move");
  }

  async run(): Promise<string[]> {
    try {
      throwIfAborted(this.signal);
      await assertSafeToReplace(this.replacement.snapshot, this.signal);
      await mkdir(this.directory, { mode: 0o700 });
      const directoryStats = await lstat(this.directory, { bigint: true });
      assertCreatedDirectoryOwner(directoryStats, this.directory);
      this.directoryStats = directoryStats;
      const candidateStats = await prepareMoveReplacement(
        {
          path: this.candidate,
          own: (identity) => {
            this.candidateIdentity = identity;
          },
        },
        this.replacement.snapshot,
        this.replacement.bytes,
        this.signal,
      );
      this.warnings.push(
        ...(await publishMoveDestination(
          this.plan,
          {
            path: this.candidate,
            stats: candidateStats,
            replacement: this.replacement,
            hooks: this.hooks,
          },
          this.signal,
        )),
      );
    } catch (error) {
      await this.cleanup(error);
      throw error;
    }
    await this.cleanup();
    return this.warnings;
  }

  private async cleanup(failure?: unknown): Promise<void> {
    if (!this.directoryStats) {
      return;
    }
    try {
      if (this.candidateIdentity) {
        await unlinkOwnedPath(this.candidate, this.candidateIdentity, "Prepared move file");
      }
      await rmdirOwnedPath(this.directory, this.directoryStats, "Move staging directory");
    } catch (error) {
      const message = `Move staging cleanup was incomplete at ${this.directory}: ${errorMessage(error)}`;
      if (failure !== undefined) {
        const outcome = failure instanceof PublicationError ? failure : undefined;
        throw new PublicationError(
          `${errorMessage(failure)} ${message}`,
          outcome?.modifiedFiles,
          outcome?.uncertainFiles,
          failure,
        );
      }
      this.warnings.push(message);
    }
  }
}
