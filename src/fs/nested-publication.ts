import type { BigIntStats } from "node:fs";
import { lstat, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PlannedNewFile, PreparedNestedFiles, ReplacementSupport } from "./contracts.ts";
import {
  assertCreatedDirectoryOwner,
  assertPublishedDirectoriesCurrent,
  chmodOwnedDirectory,
  currentOwnedPath,
  removeEmptyOwnedDirectory,
} from "./cleanup.ts";
import {
  errorMessage,
  isCode,
  PartialCreatePublishError,
  PublicationError,
  throwIfAborted,
} from "./errors.ts";
import { publishMoveDestination } from "./entry-move.ts";
import { publishNestedFile } from "./nested-file.ts";
import { preparedOwner } from "./nested-staging.ts";
import { assertPreparedFileCurrent, readStableFile, syncDirectory } from "./observation.ts";
import { assertNewFilePlanCurrent, TraversalDirectories } from "./planning.ts";
import { cloneWithMetadata, replacementSupportInfo } from "./platform.ts";
import { inspectPreparedTree } from "./staged-tree.ts";

export async function publishPreparedNestedFiles(
  prepared: PreparedNestedFiles,
  signal?: AbortSignal,
): Promise<string[]> {
  return new NestedPublication(prepared, signal).run();
}

/** Owns root reservation and ordered publication, while private staging retains its cleanup owner. */
class NestedPublication {
  private readonly prepared: PreparedNestedFiles;
  private readonly stagingOwner: ReturnType<typeof preparedOwner>;
  private readonly signal: AbortSignal | undefined;
  private readonly directories = new Map<string, BigIntStats>();
  private readonly traversal = new TraversalDirectories();
  private readonly stagedAfterPublish: Map<string, BigIntStats>;
  private readonly publishedFiles: string[] = [];
  private readonly verifiedFiles: string[] = [];
  private readonly uncertainFiles: string[] = [];

  constructor(prepared: PreparedNestedFiles, signal?: AbortSignal) {
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
        // A shared reserved root and truthful partial receipts require ordered target publication.
        // oxlint-disable-next-line no-await-in-loop
        await this.publishEntry(entry, support);
      }
      await this.finalizeDirectories();
      await this.cleanupCommittedStaging();
      return this.stagingOwner.warnings;
    } catch (error) {
      if (this.publishedFiles.length > 0) {
        throw await this.partialFailure(error);
      }
      await this.cleanupUncommitted(error);
      throw error;
    }
  }

  private async assertPlansCurrent(): Promise<void> {
    for (const { plan } of this.prepared.entries) {
      // Keep phase order visible and complete validation before invoking later hooks.
      // oxlint-disable-next-line no-await-in-loop
      await assertNewFilePlanCurrent(plan);
    }
  }

  private async validateBeforeReservation(): Promise<void> {
    const { firstPlan, staging, publishRoot } = this.prepared;
    const paths = { staging, target: publishRoot };
    await this.prepared.hooks?.beforeDirectoryPublish?.(paths);
    throwIfAborted(this.signal);
    await this.assertPlansCurrent();
    await this.prepared.hooks?.beforeDirectoryCommit?.(paths);
    throwIfAborted(this.signal);
    await this.assertPlansCurrent();
    await inspectPreparedTree(this.prepared, this.prepared.stagedIdentities);
    await assertNewFilePlanCurrent(firstPlan);
    await this.prepared.hooks?.beforeRootReserve?.(paths);
    throwIfAborted(this.signal);
    await assertNewFilePlanCurrent(firstPlan);
    throwIfAborted(this.signal);
  }

  private async reserveRoot(): Promise<void> {
    await this.validateBeforeReservation();
    const { firstPlan, staging, publishRoot } = this.prepared;
    const paths = { staging, target: publishRoot };
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
    await this.prepared.hooks?.afterRootReserve?.(paths);
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
      // Parents must be reserved before descendants, with identity revalidation after each claim.
      // oxlint-disable-next-line no-await-in-loop
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

  private async publishEntry(entry: PlannedNewFile, support: ReplacementSupport): Promise<void> {
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
        this.publishedFiles.push(target);
        this.verifiedFiles.push(target);
      }
    } catch (error) {
      if (error instanceof PublicationError) {
        this.verifiedFiles.push(...error.modifiedFiles);
        this.uncertainFiles.push(...error.uncertainFiles);
        if (error.modifiedFiles.includes(target) || error.uncertainFiles.includes(target)) {
          this.publishedFiles.push(target);
        }
      }
      throw error;
    }
  }

  private async publishMove(
    entry: PlannedNewFile,
    relative: string,
    source: string,
    identity: BigIntStats | undefined,
  ): Promise<void> {
    const move = entry.move;
    if (!move) {
      throw new Error("Staged move source was not recorded");
    }
    let candidate = move.snapshot ? source : move.entry.actualPath;
    let stats = move.snapshot ? identity : move.entry.stats;
    if (move.snapshot && process.platform === "android") {
      candidate = join(this.prepared.container, "move");
      await cloneWithMetadata(source, candidate, this.signal);
      stats = await lstat(candidate, { bigint: true });
    }
    if (!stats) {
      throw new Error("Staged move identity was not recorded");
    }
    this.stagingOwner.warnings.push(
      ...(await publishMoveDestination(
        { entry: move.entry, destination: entry.plan },
        {
          path: candidate,
          stats,
          replacement: move.snapshot ? { snapshot: move.snapshot, bytes: entry.bytes } : undefined,
          hooks: move.hooks,
        },
        this.signal,
      )),
    );
    this.publishedFiles.push(join(this.prepared.publishRoot, relative));
    this.verifiedFiles.push(join(this.prepared.publishRoot, relative), move.entry.actualPath);
    if (move.snapshot) {
      this.stagedAfterPublish.set(relative, (await readStableFile(source)).stats);
    }
  }

  private async finalizeDirectories(): Promise<void> {
    await assertPublishedDirectoriesCurrent(this.directories);
    await inspectPreparedTree(this.prepared, this.stagedAfterPublish);
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
      // oxlint-disable-next-line no-await-in-loop
      await chmodOwnedDirectory(path, stats, Number(mode));
      modes.set(path, mode);
    }
    for (const [path] of [...this.directories].sort(
      ([left], [right]) => right.length - left.length,
    )) {
      // Durability sync proceeds from descendants to their already-finalized parents.
      // oxlint-disable-next-line no-await-in-loop
      const warning = await syncDirectory(path);
      if (warning !== undefined) {
        this.stagingOwner.warnings.push(warning);
      }
    }
  }

  private async cleanupCommittedStaging(): Promise<void> {
    this.stagingOwner.published = true;
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
    this.stagingOwner.discardAttempted = true;
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
    return new PartialCreatePublishError(
      `${errorMessage(error)} Partial create publication retained ${this.publishedFiles.length} file${this.publishedFiles.length === 1 ? "" : "s"} at ${this.publishedFiles.join(", ")}; ${location}`,
      this.publishedFiles.length,
      [...new Set(this.verifiedFiles)],
      [
        ...new Set([
          ...this.uncertainFiles,
          ...this.publishedFiles.filter((path) => !this.verifiedFiles.includes(path)),
        ]),
      ],
    );
  }

  private async cleanupUncommitted(error: unknown): Promise<void> {
    const failures: string[] = [];
    for (const [path, stats] of [...this.directories].reverse()) {
      try {
        // Release reserved children before their parents; never remove unrelated substituted entries.
        // oxlint-disable-next-line no-await-in-loop
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
