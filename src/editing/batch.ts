import { dirname, sep } from "node:path";
import {
  discardPreparedNestedFiles,
  preparePlannedNestedFiles,
  publishPreparedNestedFiles,
  throwIfAborted,
  type PreparedNestedFiles,
  type PlannedNewFile,
} from "../file-system.ts";
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
import { planFile, commitPlannedMutation } from "./planning.ts";
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
  readonly destination?: QueueTarget;
}
interface ResolvedBatch {
  readonly resolved: readonly ResolvedMutation[];
  readonly targets: readonly QueueTarget[];
}
function rootKey(plan: PlannedMutation): string | undefined {
  if (
    plan.lockKey === undefined ||
    plan.createPlan === undefined ||
    plan.createPlan.missingDirectories.length === 0
  ) {
    return;
  }
  let key = plan.lockKey;
  for (let index = 0; index < plan.createPlan.missingDirectories.length; index++) {
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
function preparedEntry(plan: PlannedMutation): PlannedNewFile {
  const create = { plan: required(plan.createPlan), bytes: plan.nextBytes };
  if (plan.movePlan === undefined) {
    return create;
  }
  return { ...create, move: { entry: required(plan.entry), snapshot: plan.snapshot } };
}
/** One invocation owns reservations, planning, preparation and receipts until cleanup finishes. */
class EditingBatch {
  private readonly files: readonly MutationInput[];
  private readonly options: ExecutionOptions;
  private readonly receipts: BatchReceipts;
  private resolved: ResolvedBatch = { resolved: [], targets: [] };
  private readonly plans: PlannedMutation[] = [];
  private readonly groups = new Map<string, number[]>();
  private readonly prepared = new Map<string, PreparedNestedFiles>();
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
      const keys = await (entryOperation
        ? entryMutationQueueKeys(inputPath)
        : mutationQueueKeys(inputPath));
      let destination: QueueTarget | undefined;
      if (file.patch?.moveTo !== undefined) {
        const destinationPath = resolveInputPath(file.patch.moveTo, this.options.cwd);
        destination = {
          inputPath: destinationPath,
          ...(await mutationQueueKeys(destinationPath)),
          index,
        };
      }
      return { file, inputPath, ...keys, index, destination };
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
    assertDistinctTargets(targets);
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
  private async planFiles(): Promise<void> {
    for (const item of this.resolved.resolved) {
      try {
        // Preserve progress callback/cancellation order before planning the next file.
        // oxlint-disable-next-line no-await-in-loop
        const contents = await planFile(item.file, item.inputPath, this.options);
        const plan = { ...contents, lockKey: item.destination?.targetKey ?? item.targetKey };
        this.plans.push(plan);
        this.receipts.plan(item.index, plan);
        this.options.onProgress?.(
          `${this.options.preview ? "Previewed" : "Planned"} ${this.plans.length}/${this.files.length}: ${plan.displayPath}. ${this.options.preview ? "No files written." : "No targets published."}`,
        );
      } catch (error) {
        this.receipts.fail([item.index]);
        throw this.receipts.failure(`files[${item.index}]: ${errorMessage(error)}`);
      }
    }
  }
  private async assertLinksRetained(): Promise<void> {
    const removedLinks = new Map(
      this.plans.flatMap((plan, index) =>
        plan.entry?.symbolicLink === true
          ? [[normalizeLockKey(plan.entry.actualPath), index] as const]
          : [],
      ),
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
      // oxlint-disable-next-line no-await-in-loop
      const sourceIndex = await changedLinkInPath(
        entrySource ? dirname(target.inputPath) : target.inputPath,
        (key) => removedLinks.get(key),
      );
      if (sourceIndex === undefined) {
        continue;
      }
      this.receipts.fail([target.index]);
      throw this.receipts.failure(
        `files[${target.index}] (${target.inputPath}) traverses symbolic link ${required(this.plans[sourceIndex]).inputPath} that files[${sourceIndex}] removes. Split these operations into separate calls. No changes were written.`,
      );
    }
  }
  private assertTraversalDisjoint(): void {
    for (const [index, plan] of this.plans.entries()) {
      for (const path of plan.createPlan?.traversalDirectories ?? []) {
        const directory = normalizeLockKey(path);
        const ownRoot = rootKey(plan);
        const targetConflict = this.resolved.targets.some(
          (target) =>
            directory === target.targetKey || directory.startsWith(`${target.targetKey}${sep}`),
        );
        const rootConflict = this.plans.some((other) =>
          overlapsRoot(directory, rootKey(other), ownRoot),
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
  private groupCreates(): void {
    for (const [index, plan] of this.plans.entries()) {
      const key = rootKey(plan);
      if (key === undefined) {
        continue;
      }
      const group = this.groups.get(key) ?? [];
      group.push(index);
      this.groups.set(key, group);
    }
    for (const group of this.groups.values()) {
      const spellings = new Set(
        group.map(
          (index) => required(required(this.plans[index]).createPlan).missingDirectories[0],
        ),
      );
      if (spellings.size > 1) {
        throw this.receipts.failure(
          `files[${group.join(", ")}] use alias spellings for one missing directory. Use one consistent path spelling so the batch can publish it safely.`,
        );
      }
    }
  }
  private async prepareCreates(): Promise<void> {
    for (const [key, group] of this.groups) {
      try {
        const entries = group.map((index) => preparedEntry(required(this.plans[index])));
        // Prepare every subtree before publishing any target; failure cleanup owns prior groups.
        // oxlint-disable-next-line no-await-in-loop
        const prepared = await preparePlannedNestedFiles(entries, this.options.signal);
        this.prepared.set(key, prepared);
      } catch (error) {
        this.receipts.fail(group);
        throw this.receipts.failure(
          `files[${group.join(", ")}] could not be prepared. ${errorMessage(error)}`,
        );
      }
    }
  }
  private async publishGroup(index: number, plan: PlannedMutation): Promise<void> {
    const key = rootKey(plan);
    const group = key === undefined ? [index] : required(this.groups.get(key));
    const names = group.map((item) => required(this.plans[item]).displayPath).join(", ");
    try {
      this.options.onProgress?.(
        `Publishing ${names} (${this.receipts.completedCount()}/${this.plans.length} files complete).`,
      );
      const warnings =
        key === undefined
          ? await commitPlannedMutation(plan, this.options.signal)
          : await publishPreparedNestedFiles(required(this.prepared.get(key)), this.options.signal);
      this.receipts.warnings(required(group[0]), warnings);
      for (const item of group) {
        this.receipts.complete(item, required(this.plans[item]));
      }
      this.options.onProgress?.(
        `Completed ${this.receipts.completedCount()}/${this.plans.length}: ${names}.`,
      );
    } catch (error) {
      throw this.receipts.publicationFailure(error, index, group, this.plans);
    }
  }
  private async publishFiles(): Promise<void> {
    for (const [index, plan] of this.plans.entries()) {
      if (this.receipts.hasCompleted(index)) {
        continue;
      }
      // Publication order determines partial receipts and the next cancellation boundary.
      // oxlint-disable-next-line no-await-in-loop
      await this.publishGroup(index, plan);
    }
  }
  private async cleanup(): Promise<readonly string[]> {
    const failures: string[] = [];
    for (const prepared of this.prepared.values()) {
      try {
        // Discard each owned group completely before advancing to the next cleanup boundary.
        // oxlint-disable-next-line no-await-in-loop
        await discardPreparedNestedFiles(prepared);
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    return failures;
  }
  private async publish(): Promise<void> {
    let failure: BatchPublicationError | undefined;
    try {
      await this.prepareCreates();
      await this.publishFiles();
    } catch (error) {
      failure =
        error instanceof BatchPublicationError ? error : this.receipts.failure(errorMessage(error));
    }
    const cleanupFailures = await this.cleanup();
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
    await this.planFiles();
    await this.assertLinksRetained();
    this.assertTraversalDisjoint();
    if (!this.options.preview) {
      this.groupCreates();
      await this.publish();
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
