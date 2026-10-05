import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertEntryMovePathBudget, assertPlannedPathBudget } from "../path-budget.ts";
import { operationPath } from "../native-path.ts";
import type {
  EntryMovePlan,
  EntryPublishHooks,
  EntrySnapshot,
  MoveReplacement,
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
import {
  assertEntryCurrent,
  assertEntryParentCurrent,
  assertSafeToReplace,
  assertSnapshotCurrent,
} from "./snapshot.ts";
import { publishEntryDelete } from "./entry-delete.ts";

export async function planEntryMove(
  entry: EntrySnapshot,
  destinationPath: string,
  signal?: AbortSignal,
  preview = false,
): Promise<EntryMovePlan> {
  throwIfAborted(signal);
  await assertEntryCurrent(entry);
  assertPlannedPathBudget(destinationPath, [operationPath(destinationPath)]);
  const destination = await planNewFile(destinationPath, !preview);
  if (await lstatIfExists(destination.targetPath)) {
    throw new Error(
      `Move destination already exists: ${destination.inputPath}. No changes were written.`,
    );
  }
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
    if (process.platform === "android") {
      const support = await replacementSupportInfo();
      if (!support.supported || support.strategy !== "exchange") {
        throw new Error(
          "No-clobber entry moves require supported Termux coreutils. No changes were written.",
        );
      }
    } else {
      await probeEntryLink(entry, destination.ancestorPath, destination.inputPath);
    }
  }
  throwIfAborted(signal);
  return { entry, destination };
}

async function probeEntryLink(
  entry: EntrySnapshot,
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
  readonly replacement?: MoveReplacement;
  readonly hooks?: EntryPublishHooks;
}

export async function publishMoveDestination(
  plan: EntryMovePlan,
  candidate: MoveCandidate,
  signal?: AbortSignal,
): Promise<string[]> {
  return new DestinationMove(plan, candidate, signal).run();
}

class DestinationMove {
  private readonly plan: EntryMovePlan;
  private readonly candidate: MoveCandidate;
  private readonly signal: AbortSignal | undefined;
  private readonly modified: string[] = [];
  private readonly traversal = new TraversalDirectories();
  private readonly atomicMove = process.platform === "android";
  private started = false;

  constructor(plan: EntryMovePlan, candidate: MoveCandidate, signal?: AbortSignal) {
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
      if (!this.started) {
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
        this.started = true;
      }
      throw error;
    }
    this.started = true;
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
  }

  private async finishSource(): Promise<string[]> {
    const { entry, destination } = this.plan;
    const warnings =
      this.atomicMove && !this.candidate.replacement
        ? await this.finishAtomicSource()
        : await this.removeLinkedSource();
    for (const directory of new Set([entry.parentPath, dirname(destination.targetPath)])) {
      // Source and destination cleanup durability follows completed source removal.
      // oxlint-disable-next-line no-await-in-loop
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
    const uncertain: string[] = [];
    if (this.started && !this.modified.includes(this.plan.destination.targetPath)) {
      uncertain.push(this.plan.destination.targetPath);
    }
    if (
      this.started &&
      this.atomicMove &&
      !this.candidate.replacement &&
      !this.modified.includes(this.plan.entry.actualPath)
    ) {
      uncertain.push(this.plan.entry.actualPath);
    }
    return uncertain;
  }
}

export async function publishDirectEntryMove(
  plan: EntryMovePlan,
  replacement?: MoveReplacement,
  signal?: AbortSignal,
  hooks?: EntryPublishHooks,
): Promise<string[]> {
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
  private readonly plan: EntryMovePlan;
  private readonly replacement: MoveReplacement;
  private readonly signal: AbortSignal | undefined;
  private readonly hooks: EntryPublishHooks | undefined;
  private readonly directory: string;
  private readonly candidate: string;
  private directoryStats: BigIntStats | undefined;
  private candidateStats: BigIntStats | undefined;
  private readonly warnings: string[] = [];

  constructor(
    plan: EntryMovePlan,
    replacement: MoveReplacement,
    signal?: AbortSignal,
    hooks?: EntryPublishHooks,
  ) {
    this.plan = plan;
    this.replacement = replacement;
    this.signal = signal;
    this.hooks = hooks;
    this.directory = temporaryDirectoryPath(plan.entry.actualPath);
    this.candidate = join(this.directory, "move");
  }

  async run(): Promise<string[]> {
    let failure: unknown;
    let failed = false;
    try {
      throwIfAborted(this.signal);
      await assertSafeToReplace(this.replacement.snapshot, this.signal);
      await mkdir(this.directory, { mode: 0o700 });
      const directoryStats = await lstat(this.directory, { bigint: true });
      assertCreatedDirectoryOwner(directoryStats, this.directory);
      this.directoryStats = directoryStats;
      this.candidateStats = await prepareMoveReplacement(
        this.candidate,
        this.replacement.snapshot,
        this.replacement.bytes,
        this.signal,
      );
      this.warnings.push(
        ...(await publishMoveDestination(
          this.plan,
          {
            path: this.candidate,
            stats: this.candidateStats,
            replacement: this.replacement,
            hooks: this.hooks,
          },
          this.signal,
        )),
      );
    } catch (error) {
      failure = error;
      failed = true;
    }
    await this.cleanup(failure);
    if (failed) {
      if (failure instanceof Error) {
        throw failure;
      }
      throw new Error(errorMessage(failure), { cause: failure });
    }
    return this.warnings;
  }

  private async cleanup(failure: unknown): Promise<void> {
    if (!this.directoryStats) {
      return;
    }
    try {
      if (this.candidateStats) {
        await unlinkOwnedPath(this.candidate, this.candidateStats, "Prepared move file");
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
        );
      }
      this.warnings.push(message);
    }
  }
}
