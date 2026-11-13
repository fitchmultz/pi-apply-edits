import type { BigIntStats } from "node:fs";
import { lstat, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ReadonlyEntryMovePlan,
  ReadonlyPlannedNewFile,
  ReadonlyPreparedNestedFiles,
  ReplacementSupport,
} from "./contracts.ts";
import {
  assertCreatedDirectoryOwner,
  assertPublishedDirectoriesCurrent,
  chmodOwnedDirectory,
  currentOwnedPath,
  removeEmptyOwnedDirectory,
  unlinkOwnedPath,
} from "./cleanup.ts";
import {
  errorMessage,
  isCode,
  PartialCreatePublishError,
  PrivateEntryChangedError,
  PublicationError,
  throwIfAborted,
} from "./errors.ts";
import { publishMoveDestination, type MoveCandidate } from "./entry-move.ts";
import { publishNestedFile } from "./nested-file.ts";
import { preparedOwner } from "./nested-staging.ts";
import {
  assertPreparedFileCurrent,
  readStableFile,
  sameIdentity,
  syncDirectory,
} from "./observation.ts";
import { assertNewFilePlanCurrent, TraversalDirectories } from "./planning.ts";
import { clonePrivateFile, replacementSupportInfo } from "./platform.ts";

async function discardOwnedCandidate(
  path: string,
  identity: BigIntStats,
  failure: unknown,
): Promise<void> {
  try {
    await unlinkOwnedPath(path, identity, "Atomic move candidate");
  } catch (cleanupError) {
    const outcome = failure instanceof PublicationError ? failure : undefined;
    throw new PublicationError(
      `${errorMessage(failure)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
      outcome?.modifiedFiles,
      outcome?.uncertainFiles,
      failure,
    );
  }
}

export async function publishPreparedNestedFiles(
  prepared: ReadonlyPreparedNestedFiles,
  signal?: AbortSignal,
): Promise<string[]> {
  return new NestedPublication(prepared, signal).run();
}

type TargetState = "verified" | "unverified";

/** Records one state per published or possibly modified path, plus ordered target visibility. */
class NestedPublicationEvidence {
  private readonly targets: string[] = [];
  private readonly states = new Map<string, TargetState>();

  get targetCount(): number {
    return this.targets.length;
  }

  /** True once a target path may exist publicly, which decides partial versus uncommitted cleanup. */
  get anyTargetVisible(): boolean {
    return this.targets.length > 0;
  }

  recordPublished(target: string, modifiedFiles: readonly string[] = [target]): void {
    this.targets.push(target);
    for (const path of modifiedFiles) {
      this.states.set(path, "verified");
    }
  }

  recordFailure(target: string, error: PublicationError): void {
    for (const path of error.modifiedFiles) {
      this.states.set(path, "verified");
    }
    for (const path of error.uncertainFiles) {
      // A path reported as both keeps its verified state so the receipt cannot list it twice.
      if (!this.states.has(path)) {
        this.states.set(path, "unverified");
      }
    }
    if (error.modifiedFiles.includes(target) || error.uncertainFiles.includes(target)) {
      this.targets.push(target);
    }
  }

  partialFailure(error: unknown, location: string): PartialCreatePublishError {
    const verified: string[] = [];
    const uncertain: string[] = [];
    for (const [path, state] of this.states) {
      (state === "verified" ? verified : uncertain).push(path);
    }
    for (const target of this.targets) {
      if (!this.states.has(target)) {
        uncertain.push(target);
      }
    }
    return new PartialCreatePublishError(
      `${errorMessage(error)} Partial create publication retained ${this.targetCount} file${this.targetCount === 1 ? "" : "s"} at ${this.targets.join(", ")}; ${location}`,
      this.targetCount,
      verified,
      uncertain,
    );
  }
}

/** Owns root reservation and ordered publication, while private staging retains its cleanup owner. */
class NestedPublication {
  private readonly prepared: ReadonlyPreparedNestedFiles;
  private readonly stagingOwner: ReturnType<typeof preparedOwner>;
  private readonly signal: AbortSignal | undefined;
  private readonly directories = new Map<string, BigIntStats>();
  private readonly traversal = new TraversalDirectories();
  private readonly stagedAfterPublish: Map<string, BigIntStats>;
  private readonly evidence = new NestedPublicationEvidence();

  constructor(prepared: ReadonlyPreparedNestedFiles, signal?: AbortSignal) {
    this.prepared = prepared;
    this.stagingOwner = preparedOwner(prepared);
    this.signal = signal;
    this.stagedAfterPublish = new Map(prepared.stagedIdentities);
  }

  async run(): Promise<string[]> {
    const support = await replacementSupportInfo();
    try {
      await this.reserveRoot();
      await this.reserveDirectories();
      for (const entry of this.prepared.entries) {
        await this.publishEntry(entry, support);
      }
      await this.finalizeDirectories();
      await this.cleanupCommittedStaging();
      return this.stagingOwner.warnings;
    } catch (error) {
      if (this.evidence.anyTargetVisible) {
        throw await this.partialFailure(error);
      }
      await this.cleanupUncommitted(error);
      throw error;
    }
  }

  private async assertPlansCurrent(): Promise<void> {
    for (const { plan } of this.prepared.entries) {
      await assertNewFilePlanCurrent(plan);
    }
  }

  private async validateBeforeReservation(): Promise<void> {
    const { firstPlan, staging, publishRoot } = this.prepared;
    // Observers receive their own payloads, so one observer's edits never reach the next.
    await this.prepared.hooks?.beforeDirectoryPublish?.({ staging, target: publishRoot });
    throwIfAborted(this.signal);
    await this.assertPlansCurrent();
    await this.prepared.hooks?.beforeDirectoryCommit?.({ staging, target: publishRoot });
    throwIfAborted(this.signal);
    await this.assertPlansCurrent();
    const identities = this.prepared.stagedIdentities;
    await this.stagingOwner.inspectTree(
      identities ? { kind: "revalidate", identities } : { kind: "initial" },
    );
    await assertNewFilePlanCurrent(firstPlan);
    await this.prepared.hooks?.beforeRootReserve?.({ staging, target: publishRoot });
    throwIfAborted(this.signal);
    await assertNewFilePlanCurrent(firstPlan);
    throwIfAborted(this.signal);
  }

  private async reserveRoot(): Promise<void> {
    await this.validateBeforeReservation();
    const { firstPlan, staging, publishRoot } = this.prepared;
    await this.traversal.publish(
      this.prepared.entries.map(({ plan }) => plan),
      this.signal,
      publishRoot,
    );
    throwIfAborted(this.signal);
    try {
      await mkdir(publishRoot, { mode: 0o700 });
    } catch (error) {
      if (isCode(error, "EEXIST") || isCode(error, "ENOTDIR") || isCode(error, "ENOENT")) {
        throw new Error(
          `Create parent changed after planning ${firstPlan.inputPath}. No changes were written.`,
          { cause: error },
        );
      }
      throw error;
    }
    const stats = await lstat(publishRoot, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Reserved create directory changed identity at ${publishRoot}.`);
    }
    assertCreatedDirectoryOwner(stats, publishRoot);
    this.directories.set(publishRoot, stats);
    await assertNewFilePlanCurrent(firstPlan);
    await this.prepared.hooks?.afterRootReserve?.({ staging, target: publishRoot });
    throwIfAborted(this.signal);
    await assertNewFilePlanCurrent(firstPlan);
  }

  private async reserveDirectories(): Promise<void> {
    const identities = this.prepared.stagedIdentities;
    if (!identities) {
      throw new Error("Staged create identities were not recorded.");
    }
    const relative = [...identities]
      .filter(([path, stats]) => path.length > 0 && stats.isDirectory())
      .sort(([left], [right]) => left.length - right.length);
    for (const [path] of relative) {
      await this.reserveDirectory(join(this.prepared.publishRoot, path));
    }
  }

  private async reserveDirectory(path: string): Promise<void> {
    throwIfAborted(this.signal);
    await assertPublishedDirectoriesCurrent(this.directories);
    try {
      throwIfAborted(this.signal);
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (isCode(error, "EEXIST") || isCode(error, "ENOTDIR")) {
        throw new Error(`Create path appeared before publication: ${path}.`, { cause: error });
      }
      throw error;
    }
    // Never resolve first: a substituted symlink must not redirect cleanup to another directory.
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Created directory changed identity at ${path}.`);
    }
    assertCreatedDirectoryOwner(stats, path);
    try {
      await assertPublishedDirectoriesCurrent(this.directories);
    } catch (error) {
      try {
        await removeEmptyOwnedDirectory(path, stats, "Escaped create directory");
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
    this.directories.set(path, stats);
  }

  private async publishEntry(
    entry: ReadonlyPlannedNewFile,
    support: ReplacementSupport,
  ): Promise<void> {
    throwIfAborted(this.signal);
    const relative = join(
      ...entry.plan.missingDirectories.slice(1),
      basename(entry.plan.targetPath),
    );
    const source = join(this.prepared.staging, relative);
    const target = join(this.prepared.publishRoot, relative);
    const identity = this.prepared.stagedIdentities?.get(relative);
    await assertPreparedFileCurrent(source, identity, entry.bytes, "Staged create file");
    await assertPublishedDirectoriesCurrent(this.directories);
    try {
      if (entry.move) {
        await this.publishMove(entry, relative, source, identity);
      } else {
        await publishNestedFile(
          entry,
          {
            stagedTarget: source,
            target,
            candidate: join(this.prepared.container, "move"),
            stagedIdentity: identity,
            directories: this.directories,
            hooks: this.prepared.hooks,
            rememberStaging: (stats) => {
              this.stagedAfterPublish.set(relative, stats);
              this.stagingOwner.stagedIdentities?.set(relative, stats);
            },
            warn: (message) => {
              this.stagingOwner.warnings.push(message);
            },
          },
          support,
          this.signal,
        );
        this.evidence.recordPublished(target);
      }
    } catch (error) {
      if (error instanceof PublicationError) {
        this.evidence.recordFailure(target, error);
      }
      throw error;
    }
  }

  private async publishMove(
    entry: ReadonlyPlannedNewFile,
    relative: string,
    source: string,
    identity: BigIntStats | undefined,
  ): Promise<void> {
    const move = entry.move;
    if (!move) {
      throw new Error("Staged move source was not recorded");
    }
    const replacement = move.snapshot ? { snapshot: move.snapshot, bytes: entry.bytes } : undefined;
    const stats = replacement ? identity : move.entry.stats;
    if (!stats) {
      throw new Error("Staged move identity was not recorded");
    }
    const plan = { entry: move.entry, destination: entry.plan };
    const candidate = {
      path: replacement ? source : move.entry.actualPath,
      stats,
      replacement,
      hooks: move.hooks,
    };
    this.stagingOwner.warnings.push(
      ...(replacement && process.platform === "android"
        ? await this.publishPrivateCopy(plan, candidate)
        : await publishMoveDestination(plan, candidate, this.signal)),
    );
    const target = join(this.prepared.publishRoot, relative);
    this.evidence.recordPublished(target, [target, move.entry.actualPath]);
    if (move.snapshot) {
      this.stagedAfterPublish.set(relative, (await readStableFile(source)).stats);
    }
  }

  // Android publishes by atomic no-clobber rename, so a private copy keeps the staged file in
  // place. After a failure, the copy is removed only while its path still names the created file;
  // a published copy was renamed away, so the identity-guarded unlink leaves it alone.
  private async publishPrivateCopy(
    plan: ReadonlyEntryMovePlan,
    staged: MoveCandidate,
  ): Promise<string[]> {
    const path = join(this.prepared.container, "move");
    const owned: { identity?: BigIntStats } = {};
    try {
      const created = await clonePrivateFile(
        staged.path,
        {
          path,
          own: (identity) => {
            owned.identity = identity;
          },
        },
        this.signal,
      );
      const stats = await lstat(path, { bigint: true });
      if (!sameIdentity(created, stats)) {
        throw new PrivateEntryChangedError(`Atomic move candidate changed identity: ${path}`);
      }
      return await publishMoveDestination(plan, { ...staged, path, stats }, this.signal);
    } catch (error) {
      if (owned.identity) {
        await discardOwnedCandidate(path, owned.identity, error);
      }
      throw error;
    }
  }

  private async finalizeDirectories(): Promise<void> {
    await assertPublishedDirectoriesCurrent(this.directories);
    await this.stagingOwner.inspectTree({
      kind: "revalidate",
      identities: this.stagedAfterPublish,
    });
    const ancestorMode = (await stat(this.prepared.firstPlan.ancestorPath, { bigint: true })).mode;
    const modes = new Map<string, bigint>();
    for (const [path, stats] of [...this.directories].sort(
      ([left], [right]) => left.length - right.length,
    )) {
      const relative =
        path === this.prepared.publishRoot ? "" : path.slice(this.prepared.publishRoot.length + 1);
      const staged = this.prepared.stagedIdentities?.get(relative);
      if (!staged) {
        throw new Error(`Missing staged directory metadata for ${path}.`);
      }
      const parentMode = modes.get(dirname(path)) ?? ancestorMode;
      const mode = (staged.mode & 0o777n) | (parentMode & 0o2000n);
      // Restore parent modes before descendants so setgid inheritance follows the intended tree.
      await chmodOwnedDirectory(path, stats, Number(mode));
      modes.set(path, mode);
    }
    for (const [path] of [...this.directories].sort(
      ([left], [right]) => right.length - left.length,
    )) {
      const warning = await syncDirectory(path);
      if (warning !== undefined) {
        this.stagingOwner.warnings.push(warning);
      }
    }
  }

  private async cleanupCommittedStaging(): Promise<void> {
    this.stagingOwner.markPublished();
    try {
      await this.stagingOwner.removeStaging(this.stagedAfterPublish);
    } catch (error) {
      this.stagingOwner.warnings.push(
        `The files were created, but private staging cleanup was incomplete: ${errorMessage(error)}`,
      );
    }
    if (this.stagingOwner.containerStats && !this.stagingOwner.stagingStats) {
      try {
        await this.stagingOwner.removeContainer();
      } catch (error) {
        this.stagingOwner.warnings.push(
          `The files were created, but staging container cleanup was incomplete: ${errorMessage(error)}`,
        );
      }
    }
    const warning = await syncDirectory(this.prepared.firstPlan.ancestorPath);
    if (warning !== undefined) {
      this.stagingOwner.warnings.push(warning);
    }
  }

  private async partialFailure(error: unknown): Promise<PartialCreatePublishError> {
    this.stagingOwner.retain(error);
    let location: string;
    try {
      location = (await currentOwnedPath(
        this.prepared.staging,
        this.prepared.stagingStats,
        "Staged create directory",
      ))
        ? `private staging remains at ${this.prepared.staging}.`
        : "private staging is no longer at its recorded path; its location is uncertain and the published files may remain linked to it.";
    } catch {
      location = `private staging could not be verified at ${this.prepared.staging}; the published files may remain linked to it.`;
    }
    return this.evidence.partialFailure(error, location);
  }

  private async cleanupUncommitted(error: unknown): Promise<void> {
    const failures: string[] = [];
    for (const [path, stats] of [...this.directories].reverse()) {
      try {
        // Release reserved children before their parents; never remove unrelated substituted entries.
        await removeEmptyOwnedDirectory(path, stats, "Reserved create directory");
      } catch (cleanupError) {
        failures.push(`${path}: ${errorMessage(cleanupError)}`);
      }
    }
    try {
      await this.traversal.remove();
    } catch (cleanupError) {
      failures.push(errorMessage(cleanupError));
    }
    try {
      await this.stagingOwner.discard();
    } catch (cleanupError) {
      failures.push(errorMessage(cleanupError));
    }
    if (failures.length > 0) {
      throw new Error(`${errorMessage(error)} Cleanup was incomplete: ${failures.join("; ")}`, {
        cause: error,
      });
    }
  }
}
