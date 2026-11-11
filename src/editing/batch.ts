import { dirname, sep } from "node:path";
import {
  discardPreparedNestedFiles,
  preparePlannedNestedFiles,
  publishPreparedNestedFiles,
  throwIfAborted,
} from "../file-system.ts";
import type { ReadonlyPlannedNewFile, ReadonlyPreparedNestedFiles } from "../fs/contracts.ts";
import { MacosAclSession } from "../fs/macos-acl.ts";
import {
  registerMutation,
  withMutationLocks,
  resolveInputPath,
  mutationQueueKeys,
  entryMutationQueueKeys,
  assertDistinctTargets,
  changedLinkInPath,
  normalizeLockKey,
  isMissingPathError,
  type QueueTarget,
} from "./queue.ts";
import {
  BatchReceipts,
  BatchPublicationError,
  describeBatch,
  failedExecution,
  displayPathFor,
} from "./receipts.ts";
import { planFile, commitPlannedMutation, plannedCreate } from "./planning.ts";
import { IDENTICAL_PAIR } from "./targeted.ts";
import { validateBatch } from "./validation.ts";
import {
  required,
  errorMessage,
  type MutationInput,
  type ExecutionOptions,
  type PlannedMutation,
  type EditingExecution,
} from "./contracts.ts";

interface ResolvedMutation extends QueueTarget {
  readonly file: MutationInput;
  readonly destination?: QueueTarget | undefined;
}
interface ResolvedBatch {
  readonly resolved: readonly ResolvedMutation[];
  readonly targets: readonly QueueTarget[];
}
interface PreparedGroup {
  readonly indices: readonly number[];
  readonly files: ReadonlyPreparedNestedFiles;
}
/** One planned file plus the staged-create root it belongs to, if any. */
interface PlannedEntry {
  readonly plan: PlannedMutation;
  readonly stagedRoot: string | undefined;
}
interface CreateGroup {
  readonly root: string;
  readonly indices: readonly number[];
}
function rootKey(plan: PlannedMutation, lockKey: string): string | undefined {
  const create = plannedCreate(plan);
  if (create === undefined || create.missingDirectories.length === 0) {
    return;
  }
  let key = lockKey;
  for (let index = 0; index < create.missingDirectories.length; index++) {
    key = dirname(key);
  }
  return key;
}
function overlapsRoot(
  directory: string,
  root: string | undefined,
  ownRoot: string | undefined,
): boolean {
  return (
    root !== undefined &&
    root !== ownRoot &&
    (root === directory ||
      root.startsWith(`${directory}${sep}`) ||
      directory.startsWith(`${root}${sep}`))
  );
}
function preparedEntry(plan: PlannedMutation): ReadonlyPlannedNewFile {
  const create = { plan: required(plannedCreate(plan)), bytes: plan.nextBytes };
  if (plan.operation !== "move") {
    return create;
  }
  return { ...create, move: { entry: plan.movePlan.entry, snapshot: plan.snapshot } };
}
async function resolveMoveDestination(
  moveTo: string,
  cwd: string,
  index: number,
): Promise<QueueTarget> {
  const inputPath = resolveInputPath(moveTo, cwd);
  return { inputPath, ...(await mutationQueueKeys(inputPath)), index };
}
/** One invocation owns reservations, planning, preparation and receipts until cleanup finishes. */
class EditingBatch {
  private readonly files: readonly MutationInput[];
  private readonly options: ExecutionOptions;
  private readonly receipts: BatchReceipts;
  private resolved: ResolvedBatch = { resolved: [], targets: [] };
  // Preparation and publication share one ACL helper; progress callbacks stay outside its scope.
  private readonly acl = new MacosAclSession();
  constructor(files: readonly MutationInput[], options: ExecutionOptions) {
    this.files = files;
    this.options = options;
    this.receipts = new BatchReceipts(files, options.cwd, options.preview);
  }
  private resolutionFailure(
    error: unknown,
    inputPath: string,
    index: number,
  ): BatchPublicationError {
    this.receipts.fail([index]);
    let reason = errorMessage(error);
    if (isMissingPathError(error)) {
      const path = displayPathFor(inputPath, this.options.cwd);
      reason =
        error.code === "ENOENT"
          ? `File does not exist: ${path}.`
          : `A parent path is not a directory: ${path}.`;
    }
    return this.receipts.failure(`files[${index}]: ${reason} No changes were written.`);
  }
  private async resolveFile(file: MutationInput, index: number): Promise<ResolvedMutation> {
    const inputPath = resolveInputPath(file.path, this.options.cwd);
    try {
      const entryOperation = file.delete === true || file.patch?.moveTo !== undefined;
      const sourceKeys = entryOperation
        ? entryMutationQueueKeys(inputPath)
        : mutationQueueKeys(inputPath);
      const destination =
        file.patch?.moveTo === undefined
          ? undefined
          : resolveMoveDestination(file.patch.moveTo, this.options.cwd, index);
      const [keys] = await Promise.all([sourceKeys, destination?.catch(Boolean)]);
      return { file, inputPath, ...keys, index, destination: await destination };
    } catch (error) {
      throw this.resolutionFailure(error, inputPath, index);
    }
  }
  private async resolveFiles(): Promise<ResolvedBatch> {
    const resolved = await Promise.all(
      this.files.map((file, index) => this.resolveFile(file, index)),
    );
    const targets = resolved.flatMap((item) =>
      item.destination === undefined ? [item] : [item, item.destination],
    );
    assertDistinctTargets(targets, this.options.duplicateTargetHint);
    return { resolved, targets };
  }
  async register(): Promise<{ readonly operation: Promise<EditingExecution> }> {
    this.resolved = await this.resolveFiles();
    return {
      operation: withMutationLocks(
        this.resolved.targets,
        () => this.execute(),
        async () => {
          // An earlier move may have introduced aliases; refresh while reservations remain held.
          this.resolved = await this.resolveFiles();
          return this.resolved.targets.flatMap((item) => item.queueKeys);
        },
      ),
    };
  }
  private async planFiles(): Promise<readonly PlannedEntry[]> {
    const entries: PlannedEntry[] = [];
    for (const item of this.resolved.resolved) {
      try {
        // Preserve progress callback/cancellation order before planning the next file.
        const plan = await planFile(item.file, item.inputPath, this.options);
        entries.push({
          plan,
          stagedRoot: rootKey(plan, item.destination?.targetKey ?? item.targetKey),
        });
        this.receipts.plan(item.index, plan);
        this.options.onProgress?.(
          `${this.options.preview ? "Previewed" : "Planned"} ${entries.length}/${this.files.length}: ${plan.displayPath}. ${this.options.preview ? "No files written." : "No targets published."}`,
        );
      } catch (error) {
        this.receipts.fail([item.index]);
        throw this.receipts.failure(`files[${item.index}]: ${errorMessage(error)}`);
      }
    }
    return entries;
  }
  /** Identical pairs are skipped beside an edit that changes a file, never on their own. */
  private assertSomeEditChanges(plans: readonly PlannedEntry[]): void {
    if (!plans.every(({ plan }) => plan.operation === "no_change")) {
      return;
    }
    for (const [fileIndex, { plan }] of plans.entries()) {
      const editIndex = plan.matches.findIndex((match) => match.replacements === 0);
      if (editIndex !== -1) {
        this.receipts.fail([fileIndex]);
        throw this.receipts.failure(
          `files[${fileIndex}]: edits[${editIndex}] ${IDENTICAL_PAIR}, and no other edit in this call changes a file. No changes were written.`,
        );
      }
    }
  }
  private async assertLinksRetained(plans: readonly PlannedEntry[]): Promise<void> {
    const removedLinks = new Map(
      plans.flatMap(({ plan }, index) => {
        if (plan.operation !== "delete" && plan.operation !== "move") {
          return [];
        }
        const entry = plan.operation === "delete" ? plan.entry : plan.movePlan.entry;
        return entry.symbolicLink ? [[normalizeLockKey(entry.actualPath), index] as const] : [];
      }),
    );
    if (removedLinks.size === 0) {
      return;
    }
    for (const target of this.resolved.targets) {
      const input = required(this.resolved.resolved[target.index]);
      const entrySource =
        target.inputPath === input.inputPath &&
        (input.file.delete === true || input.file.patch?.moveTo !== undefined);
      // Native traversal is checked in request order so failures identify the first target.
      const sourceIndex = await changedLinkInPath(
        entrySource ? dirname(target.inputPath) : target.inputPath,
        (key) => removedLinks.get(key),
      );
      if (sourceIndex === undefined) {
        continue;
      }
      this.receipts.fail([target.index]);
      throw this.receipts.failure(
        `files[${target.index}] (${target.inputPath}) traverses symbolic link ${required(plans[sourceIndex]).plan.inputPath} that files[${sourceIndex}] removes. Split these operations into separate calls. No changes were written.`,
      );
    }
  }
  private assertTraversalDisjoint(plans: readonly PlannedEntry[]): void {
    for (const [index, { plan, stagedRoot }] of plans.entries()) {
      for (const path of plannedCreate(plan)?.traversalDirectories ?? []) {
        const directory = normalizeLockKey(path);
        const ownRoot = stagedRoot;
        const targetConflict = this.resolved.targets.some(
          (target) =>
            directory === target.targetKey || directory.startsWith(`${target.targetKey}${sep}`),
        );
        const rootConflict = plans.some((other) =>
          overlapsRoot(directory, other.stagedRoot, ownRoot),
        );
        if (targetConflict || rootConflict) {
          this.receipts.fail([index]);
          throw this.receipts.failure(
            `files[${index}] requires a traversal directory (${path}) that overlaps another file or staged create root. Split these operations into separate calls. No changes were written.`,
          );
        }
      }
    }
  }
  private groupCreates(plans: readonly PlannedEntry[]): readonly CreateGroup[] {
    const groups = new Map<string, number[]>();
    for (const [index, entry] of plans.entries()) {
      if (entry.stagedRoot === undefined) {
        continue;
      }
      const group = groups.get(entry.stagedRoot) ?? [];
      group.push(index);
      groups.set(entry.stagedRoot, group);
    }
    for (const group of groups.values()) {
      const spellings = new Set(
        group.map(
          (index) => required(plannedCreate(required(plans[index]).plan)).missingDirectories[0],
        ),
      );
      if (spellings.size > 1) {
        throw this.receipts.failure(
          `files[${group.join(", ")}] use alias spellings for one missing directory. Use one consistent path spelling so the batch can publish it safely.`,
        );
      }
    }
    return [...groups].map(([root, indices]) => ({ root, indices }));
  }
  private async prepareGroup(
    plans: readonly PlannedEntry[],
    indices: readonly number[],
  ): Promise<PreparedGroup> {
    try {
      const entries = indices.map((index) => preparedEntry(required(plans[index]).plan));
      const files = await this.acl.run(() =>
        preparePlannedNestedFiles(entries, this.options.signal),
      );
      return { indices, files };
    } catch (error) {
      this.receipts.fail(indices);
      throw this.receipts.failure(
        `files[${indices.join(", ")}] could not be prepared. ${errorMessage(error)}`,
      );
    }
  }
  private async publishGroup(
    plans: readonly PlannedEntry[],
    index: number,
    prepared: PreparedGroup | undefined,
  ): Promise<void> {
    const group = prepared?.indices ?? [index];
    const names = group.map((item) => required(plans[item]).plan.displayPath).join(", ");
    try {
      this.options.onProgress?.(
        `Publishing ${names} (${this.receipts.completedCount()}/${plans.length} files complete).`,
      );
      const warnings = await this.acl.run(() =>
        prepared === undefined
          ? commitPlannedMutation(required(plans[index]).plan, this.options.signal)
          : publishPreparedNestedFiles(prepared.files, this.options.signal),
      );
      this.receipts.warnings(required(group[0]), warnings);
      for (const item of group) {
        this.receipts.complete(item, required(plans[item]).plan);
      }
      this.options.onProgress?.(
        `Completed ${this.receipts.completedCount()}/${plans.length}: ${names}.`,
      );
    } catch (error) {
      throw this.receipts.publicationFailure(
        error,
        index,
        group,
        plans.map((entry) => entry.plan),
      );
    }
  }
  private async publishFiles(
    plans: readonly PlannedEntry[],
    prepared: ReadonlyMap<string, PreparedGroup>,
  ): Promise<void> {
    for (const [index, entry] of plans.entries()) {
      if (this.receipts.hasCompleted(index)) {
        continue;
      }
      const staged =
        entry.stagedRoot === undefined ? undefined : required(prepared.get(entry.stagedRoot));
      // Publication order determines partial receipts and the next cancellation boundary.
      await this.publishGroup(plans, index, staged);
    }
  }
  private async cleanup(prepared: ReadonlyMap<string, PreparedGroup>): Promise<readonly string[]> {
    const failures: string[] = [];
    for (const group of prepared.values()) {
      try {
        // Discard each owned group completely before advancing to the next cleanup boundary.
        await discardPreparedNestedFiles(group.files);
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    return failures;
  }
  private async publish(plans: readonly PlannedEntry[]): Promise<void> {
    const prepared = new Map<string, PreparedGroup>();
    let failure: BatchPublicationError | undefined;
    try {
      for (const group of this.groupCreates(plans)) {
        // Own each prepared subtree across throws; publish nothing until every group is ready.
        prepared.set(group.root, await this.prepareGroup(plans, group.indices));
      }
      await this.publishFiles(plans, prepared);
    } catch (error) {
      failure =
        error instanceof BatchPublicationError ? error : this.receipts.failure(errorMessage(error));
    }
    // An interrupted in-flight transfer already awaited its helper's exit; this ends an idle one.
    await this.acl.close();
    const cleanupFailures = await this.cleanup(prepared);
    if (cleanupFailures.length > 0) {
      failure = this.receipts.failure(
        `${failure === undefined ? "" : `${failure.message} `}Staged create cleanup was incomplete: ${cleanupFailures.join("; ")}`,
      );
    }
    if (failure !== undefined) {
      throw failure;
    }
  }
  private async execute(): Promise<EditingExecution> {
    const plans = await this.planFiles();
    this.assertSomeEditChanges(plans);
    await this.assertLinksRetained(plans);
    this.assertTraversalDisjoint(plans);
    if (!this.options.preview) {
      await this.publish(plans);
    }
    return describeBatch(this.receipts.snapshot(), this.options.cwd);
  }
}
export async function executeFileBatch(
  files: readonly MutationInput[],
  options: ExecutionOptions,
): Promise<EditingExecution> {
  try {
    throwIfAborted(options.signal);
    return await registerMutation(async () => {
      validateBatch(files);
      const batch = new EditingBatch(files, options);
      return batch.register();
    });
  } catch (error) {
    return failedExecution(error, options.preview, files, options.cwd);
  }
}
