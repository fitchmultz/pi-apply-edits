import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertEntryMovePathBudget } from "../path-budget.ts";
import type {
  NewFilePublishHooks,
  PreparedNestedFiles,
  ReadonlyNewFilePlan,
  ReadonlyNewFilePublishHooks,
  ReadonlyPlannedNewFile,
  ReadonlyPreparedNestedFiles,
} from "./contracts.ts";
import {
  assertCreatedDirectoryOwner,
  currentOwnedPath,
  removeEmptyOwnedDirectory,
} from "./cleanup.ts";
import { errorMessage, isCode, PrivateEntryChangedError, throwIfAborted } from "./errors.ts";
import { sameIdentity, syncDirectory } from "./observation.ts";
import { assertNewFilePlanCurrent, stagedTraversalDirectories } from "./planning.ts";
import { transferMacosAcl } from "./platform.ts";
import { assertMoveSnapshot, prepareMoveReplacement } from "./preparation.ts";
import { assertEntryCurrent } from "./snapshot.ts";
import { inspectPreparedTree, type TreeInspection } from "./staged-tree.ts";

type DiscardState =
  | { readonly kind: "unattempted" }
  | { readonly kind: "discarding" }
  | { readonly kind: "discarded" }
  | { readonly kind: "retained"; readonly reason: unknown };

export function preparedOwner(prepared: ReadonlyPreparedNestedFiles): NestedStaging {
  if (!(prepared instanceof NestedStaging)) {
    throw new Error("Nested create publication requires its original prepared staging owner");
  }
  return prepared;
}

export async function preparePlannedNestedFiles<
  Entries extends readonly ReadonlyPlannedNewFile[],
  Hooks extends ReadonlyNewFilePublishHooks = NewFilePublishHooks,
>(
  entries: Entries,
  signal?: AbortSignal,
  hooks?: Hooks,
): Promise<PreparedNestedFiles<Entries, Hooks>> {
  return new PreparedStaging(entries, hooks).prepare(signal);
}

export async function discardPreparedNestedFiles(
  prepared: ReadonlyPreparedNestedFiles,
): Promise<void> {
  await preparedOwner(prepared).discard();
}

/** Non-generic runtime owner so `instanceof` narrows without introducing `any` type arguments. */
abstract class NestedStaging {
  abstract readonly entries: readonly ReadonlyPlannedNewFile[];
  abstract readonly firstPlan: ReadonlyNewFilePlan;
  readonly publishRoot: string;
  readonly container: string;
  readonly staging: string;
  readonly quarantine: string;
  readonly warnings: string[] = [];
  published = false;
  #discardState: DiscardState = { kind: "unattempted" };
  containerStats: BigIntStats | undefined;
  stagingStats: BigIntStats | undefined;
  quarantineStats: BigIntStats | undefined;
  cleanupBlocked: string | undefined;
  #cleanupBlockedReason = "is not owned by this user";
  stagedIdentities: Map<string, BigIntStats> | undefined;
  readonly #stagedDirectories = new Set<string>();
  #handle: Awaited<ReturnType<typeof open>> | undefined;

  /** The writable compatibility flag disables automatic discard; it does not prove removal. */
  get discardAttempted(): boolean {
    return this.#discardState.kind !== "unattempted";
  }

  set discardAttempted(attempted: boolean) {
    if (!attempted) {
      this.#discardState = { kind: "unattempted" };
    } else if (this.#discardState.kind === "unattempted") {
      this.retain("Automatic discard was disabled by the staging owner");
    }
  }

  /** Marks the tree as published so automatic discard cannot remove live links. */
  markPublished(): void {
    this.published = true;
  }

  /** Retain staging without granting later automatic discard another destructive attempt. */
  retain(reason: unknown): void {
    if (this.#discardState.kind === "discarded") {
      // Cleanup already finished; a later reason does not make the tree present again.
      return;
    }
    this.#discardState = { kind: "retained", reason };
  }

  constructor(entries: readonly ReadonlyPlannedNewFile[]) {
    const first = entries[0]?.plan;
    const missing = first?.missingDirectories[0];
    if (!first || missing === undefined || missing.length === 0) {
      throw new Error("Nested create publication requires at least one valid plan");
    }
    for (const { plan } of entries) {
      if (plan.ancestorPath !== first.ancestorPath || plan.missingDirectories[0] !== missing) {
        throw new Error("Nested create publication plans must share one missing root");
      }
    }
    this.publishRoot = join(first.ancestorPath, missing);
    this.container = join(first.ancestorPath, `.pi-apply-edits-${randomUUID()}.tmpdir`);
    this.staging = join(this.container, "publish");
    this.quarantine = join(this.container, "q");
  }

  async prepare(signal?: AbortSignal): Promise<this> {
    try {
      throwIfAborted(signal);
      for (const entry of this.entries) {
        await this.validateEntry(entry);
      }
      await this.createContainer(signal);
      for (const entry of this.entries) {
        await this.stageEntry(entry, signal);
      }
      for (const directory of [...this.#stagedDirectories].sort(
        (left, right) => right.length - left.length,
      )) {
        throwIfAborted(signal);
        const warning = await syncDirectory(directory);
        if (warning !== undefined) {
          this.warnings.push(warning);
        }
      }
      this.stagedIdentities = await this.inspectTree({ kind: "initial" });
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

  private async validateEntry(entry: ReadonlyPlannedNewFile): Promise<void> {
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

  private async stageEntry(entry: ReadonlyPlannedNewFile, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const directory = join(this.staging, ...entry.plan.missingDirectories.slice(1));
    if (directory !== this.staging) {
      await mkdir(directory, { recursive: true });
    }
    this.rememberDirectory(directory);
    for (const relative of stagedTraversalDirectories(entry.plan)) {
      const traversed = join(this.staging, relative);
      await mkdir(traversed, { recursive: true });
      this.rememberDirectory(traversed);
    }
    const target = join(directory, basename(entry.plan.targetPath));
    if (entry.move?.snapshot) {
      try {
        await prepareMoveReplacement(
          { path: target, ownsPrivateTree: true },
          entry.move.snapshot,
          entry.bytes,
          signal,
        );
      } catch (error) {
        if (error instanceof PrivateEntryChangedError) {
          // Recursive discard does not verify entries; keep the whole tree when a check detects one.
          this.cleanupBlocked = target;
          this.#cleanupBlockedReason = "no longer names the private copy staged by this call";
        }
        throw error;
      }
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
    this.#discardState = { kind: "discarding" };
    try {
      await this.discardResources();
      this.#discardState = { kind: "discarded" };
    } catch (error) {
      this.retain(error);
      throw error;
    }
  }

  private async discardResources(): Promise<void> {
    if (this.cleanupBlocked !== undefined) {
      throw new Error(
        `Staging cleanup was skipped because ${this.cleanupBlocked} ${this.#cleanupBlockedReason}; the staging container was left untouched at ${this.container}`,
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
    await this.inspectTree({ kind: "revalidate", identities: expected });
    const quarantined = await this.quarantineStaging();
    if (!quarantined) {
      return;
    }
    const identities = new Map(expected);
    identities.set("", quarantined.stats);
    await this.inspectTree({ kind: "revalidate", identities }, quarantined.path);
    await rm(quarantined.path, { recursive: true });
    this.stagingStats = undefined;
    this.quarantineStats = undefined;
    this.stagedIdentities = undefined;
  }

  async inspectTree(
    inspection: TreeInspection,
    staging = this.staging,
  ): Promise<Map<string, BigIntStats>> {
    return inspectPreparedTree({ entries: this.entries, staging }, inspection);
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

class PreparedStaging<
  Entries extends readonly ReadonlyPlannedNewFile[],
  Hooks extends ReadonlyNewFilePublishHooks,
>
  extends NestedStaging
  implements PreparedNestedFiles<Entries, Hooks>
{
  readonly entries: Entries;
  readonly firstPlan: Entries[number]["plan"];
  readonly hooks: Hooks | undefined;

  constructor(entries: Entries, hooks?: Hooks) {
    super(entries);
    const [firstEntry] = entries;
    if (firstEntry === undefined) {
      throw new Error("Nested create publication requires at least one valid plan");
    }
    this.entries = entries;
    this.firstPlan = firstEntry.plan;
    this.hooks = hooks;
  }
}
