import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertEntryMovePathBudget } from "../path-budget.ts";
import type {
  NewFilePlan,
  NewFilePublishHooks,
  PlannedNewFile,
  PreparedNestedFiles,
} from "./contracts.ts";
import {
  assertCreatedDirectoryOwner,
  currentOwnedPath,
  removeEmptyOwnedDirectory,
} from "./cleanup.ts";
import { errorMessage, isCode, throwIfAborted } from "./errors.ts";
import { sameIdentity, syncDirectory } from "./observation.ts";
import { assertNewFilePlanCurrent, stagedTraversalDirectories } from "./planning.ts";
import { transferMacosAcl } from "./platform.ts";
import { assertMoveSnapshot, prepareMoveReplacement } from "./preparation.ts";
import { assertEntryCurrent } from "./snapshot.ts";
import { inspectPreparedTree } from "./staged-tree.ts";

export function preparedOwner(prepared: PreparedNestedFiles): NestedStaging {
  if (!(prepared instanceof NestedStaging)) {
    throw new Error("Nested create publication requires its original prepared staging owner");
  }
  return prepared;
}

export async function preparePlannedNestedFiles(
  entries: readonly PlannedNewFile[],
  signal?: AbortSignal,
  hooks?: NewFilePublishHooks,
): Promise<PreparedNestedFiles> {
  const owner = new NestedStaging(entries, hooks);
  return owner.prepare(signal);
}

export async function discardPreparedNestedFiles(prepared: PreparedNestedFiles): Promise<void> {
  await preparedOwner(prepared).discard();
}

/** Owns private staging resources. Callers receive the readonly publication descriptor. */
class NestedStaging implements PreparedNestedFiles {
  readonly entries: readonly PlannedNewFile[];
  readonly firstPlan: NewFilePlan;
  readonly publishRoot: string;
  readonly container: string;
  readonly staging: string;
  readonly quarantine: string;
  readonly warnings: string[] = [];
  readonly hooks: NewFilePublishHooks | undefined;
  published = false;
  discardAttempted = false;
  containerStats: BigIntStats | undefined;
  stagingStats: BigIntStats | undefined;
  quarantineStats: BigIntStats | undefined;
  cleanupBlocked: string | undefined;
  stagedIdentities: Map<string, BigIntStats> | undefined;
  readonly #stagedDirectories = new Set<string>();
  #handle: Awaited<ReturnType<typeof open>> | undefined;

  constructor(entries: readonly PlannedNewFile[], hooks?: NewFilePublishHooks) {
    const first = entries.at(0)?.plan;
    const missing = first?.missingDirectories.at(0);
    if (!first || missing === undefined || missing.length === 0 || entries.length === 0) {
      throw new Error("Nested create publication requires at least one valid plan");
    }
    for (const { plan } of entries) {
      if (plan.ancestorPath !== first.ancestorPath || plan.missingDirectories[0] !== missing) {
        throw new Error("Nested create publication plans must share one missing root");
      }
    }
    this.entries = entries;
    this.firstPlan = first;
    this.publishRoot = join(first.ancestorPath, missing);
    this.container = join(first.ancestorPath, `.pi-apply-edits-${randomUUID()}.tmpdir`);
    this.staging = join(this.container, "publish");
    this.quarantine = join(this.container, "q");
    this.hooks = hooks;
  }

  async prepare(signal?: AbortSignal): Promise<PreparedNestedFiles> {
    try {
      throwIfAborted(signal);
      for (const entry of this.entries) {
        // Validate every source and plan before exposing any private staging tree.
        // oxlint-disable-next-line no-await-in-loop
        await this.validateEntry(entry);
      }
      await this.createContainer(signal);
      for (const entry of this.entries) {
        // Shared private paths and descriptor ownership require completing one staged entry at a time.
        // oxlint-disable-next-line no-await-in-loop
        await this.stageEntry(entry, signal);
      }
      for (const directory of [...this.#stagedDirectories].sort(
        (left, right) => right.length - left.length,
      )) {
        throwIfAborted(signal);
        // Sync children before the containing directory so staged durability follows creation order.
        // oxlint-disable-next-line no-await-in-loop
        const warning = await syncDirectory(directory);
        if (warning !== undefined) {
          this.warnings.push(warning);
        }
      }
      this.stagedIdentities = await inspectPreparedTree(this);
      return this;
    } catch (error) {
      await this.#handle?.close().catch(() => {
        // Preserve preparation failure while private staging cleanup runs.
      });
      try {
        await this.discard();
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  private async validateEntry(entry: PlannedNewFile): Promise<void> {
    await assertNewFilePlanCurrent(entry.plan);
    if (entry.move) {
      assertEntryMovePathBudget(
        entry.move.entry.actualPath,
        entry.plan,
        entry.move.entry.inputPath,
      );
      await assertEntryCurrent(entry.move.entry);
      assertMoveSnapshot(entry.move.entry, entry.move.snapshot);
    }
  }

  private async createContainer(signal?: AbortSignal): Promise<void> {
    await mkdir(this.container, { mode: 0o700 });
    const container = await lstat(this.container, { bigint: true });
    assertCreatedDirectoryOwner(container, this.container);
    this.containerStats = container;
    await transferMacosAcl(this.firstPlan.ancestorPath, this.container, "inherit", signal);
    // An unowned child blocks moving the container: relocation would disturb foreign work.
    await mkdir(this.quarantine, { mode: 0o700 });
    const quarantine = await lstat(this.quarantine, { bigint: true });
    this.assertOwnedOrBlockCleanup(quarantine, this.quarantine);
    this.quarantineStats = quarantine;
    await mkdir(this.staging, { mode: 0o777 });
    const staging = await lstat(this.staging, { bigint: true });
    this.assertOwnedOrBlockCleanup(staging, this.staging);
    this.stagingStats = staging;
    this.#stagedDirectories.add(this.container);
    this.#stagedDirectories.add(this.staging);
  }

  private assertOwnedOrBlockCleanup(stats: BigIntStats, path: string): void {
    try {
      assertCreatedDirectoryOwner(stats, path);
    } catch (error) {
      this.cleanupBlocked = path;
      throw error;
    }
  }

  private rememberDirectory(directory: string): void {
    let current = directory;
    while (true) {
      this.#stagedDirectories.add(current);
      if (current === this.staging) {
        return;
      }
      current = dirname(current);
    }
  }

  private async stageEntry(entry: PlannedNewFile, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const directory = join(this.staging, ...entry.plan.missingDirectories.slice(1));
    if (directory !== this.staging) {
      await mkdir(directory, { recursive: true });
    }
    this.rememberDirectory(directory);
    for (const relative of stagedTraversalDirectories(entry.plan)) {
      const traversed = join(this.staging, relative);
      // Native traversal directories must be created and tracked in prerequisite order.
      // oxlint-disable-next-line no-await-in-loop
      await mkdir(traversed, { recursive: true });
      this.rememberDirectory(traversed);
    }
    const target = join(directory, basename(entry.plan.targetPath));
    if (entry.move?.snapshot) {
      await prepareMoveReplacement(target, entry.move.snapshot, entry.bytes, signal);
      return;
    }
    this.#handle = await open(target, "wx", 0o666);
    await this.#handle.writeFile(entry.bytes, { signal });
    await this.#handle.sync();
    await this.#handle.close();
    this.#handle = undefined;
  }

  async discard(): Promise<void> {
    if (this.published || this.discardAttempted) {
      return;
    }
    this.discardAttempted = true;
    if (this.cleanupBlocked !== undefined) {
      throw new Error(
        `Staging cleanup was skipped because ${this.cleanupBlocked} is not owned by this user; the staging container was left untouched at ${this.container}`,
      );
    }
    if (this.stagingStats) {
      await this.discardStaging();
    }
    if (!this.stagingStats && this.quarantineStats) {
      await removeEmptyOwnedDirectory(
        this.quarantine,
        this.quarantineStats,
        "Cleanup quarantine slot",
      );
      this.quarantineStats = undefined;
    }
    if (this.containerStats) {
      await this.removeContainer();
    }
  }

  private async discardStaging(): Promise<void> {
    if (this.stagedIdentities) {
      await this.removeStaging(this.stagedIdentities);
      return;
    }
    const quarantined = await this.quarantineStaging();
    if (quarantined) {
      await rm(quarantined.path, { recursive: true });
      this.stagingStats = undefined;
      this.quarantineStats = undefined;
    }
  }

  async removeStaging(expected: ReadonlyMap<string, BigIntStats>): Promise<void> {
    if (!this.stagingStats) {
      return;
    }
    await inspectPreparedTree(this, expected);
    const quarantined = await this.quarantineStaging();
    if (!quarantined) {
      return;
    }
    const identities = new Map(expected);
    identities.set("", quarantined.stats);
    await inspectPreparedTree({ entries: this.entries, staging: quarantined.path }, identities);
    await rm(quarantined.path, { recursive: true });
    this.stagingStats = undefined;
    this.quarantineStats = undefined;
    this.stagedIdentities = undefined;
  }

  private async quarantineStaging(): Promise<
    { readonly path: string; readonly stats: BigIntStats } | undefined
  > {
    await currentOwnedPath(this.container, this.containerStats, "Staged create container");
    const staging = await currentOwnedPath(
      this.staging,
      this.stagingStats,
      "Staged create directory",
    );
    const quarantine = await currentOwnedPath(
      this.quarantine,
      this.quarantineStats,
      "Cleanup quarantine slot",
    );
    if (!staging) {
      throw new Error(
        "Staged create directory disappeared before cleanup quarantine; its location is uncertain and the published target may remain linked to private staging",
      );
    }
    if (quarantine?.isDirectory() !== true) {
      throw new Error(`Cleanup quarantine slot changed identity at ${this.quarantine}`);
    }
    // Short quarantine paths avoid increasing deep path lengths. POSIX replaces an empty
    // verified slot atomically; on Windows the private 0700 container bounds the remove gap.
    if (process.platform === "win32") {
      await removeEmptyOwnedDirectory(this.quarantine, quarantine, "Cleanup quarantine slot");
      this.quarantineStats = undefined;
    }
    try {
      await rename(this.staging, this.quarantine);
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        throw this.quarantineFailure(error);
      }
      throw error;
    }
    let moved: BigIntStats;
    try {
      moved = await lstat(this.quarantine, { bigint: true });
    } catch (error) {
      this.quarantineStats = undefined;
      if (isCode(error, "ENOENT")) {
        throw this.quarantineFailure(error);
      }
      throw error;
    }
    this.quarantineStats = undefined;
    if (!sameIdentity(staging, moved)) {
      throw new Error(
        `Staged create directory changed after validation and was preserved at ${this.quarantine}`,
      );
    }
    return { path: this.quarantine, stats: moved };
  }

  private quarantineFailure(cause: unknown): Error {
    return new Error(
      "Staged create cleanup changed during quarantine; its location is uncertain and the published target may remain linked to private staging",
      { cause },
    );
  }

  async removeContainer(): Promise<void> {
    const stats = await currentOwnedPath(
      this.container,
      this.containerStats,
      "Staged create container",
    );
    if (!stats) {
      throw new Error(
        `Staged create container disappeared before cleanup; its location is uncertain, the container may remain outside ${dirname(this.container)}, and it may not be empty`,
      );
    }
    try {
      await rmdir(this.container);
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        throw new Error(
          `Staged create container disappeared during cleanup; its location is uncertain, the container may remain outside ${dirname(this.container)}, and it may not be empty`,
          { cause: error },
        );
      }
      throw new Error(
        `Staged create container remains at ${this.container}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    this.containerStats = undefined;
  }
}
