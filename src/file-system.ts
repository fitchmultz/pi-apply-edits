import { assertEntryMovePathBudget } from "./path-budget.ts";
import type {
  EntryMovePlan,
  EntryPublishHooks,
  MoveReplacement,
  NewFilePlan,
  NewFilePublishHooks,
  PlannedNewFile,
} from "./fs/contracts.ts";
import { throwIfAborted } from "./fs/errors.ts";
import { publishDirectEntryMove } from "./fs/entry-move.ts";
import { preparePlannedNestedFiles } from "./fs/nested-staging.ts";
import { publishPreparedNestedFiles } from "./fs/nested-publication.ts";
import { assertNewFilePlanCurrent, planNewFile } from "./fs/planning.ts";
import { assertMoveSnapshot } from "./fs/preparation.ts";
import { publishSingleNewFile } from "./fs/single-create.ts";

export type {
  FileSnapshot,
  ReplacementPublishHooks,
  NewFilePlan,
  NewFilePublishHooks,
  PlannedNewFile,
  PreparedNestedFiles,
  EntrySnapshot,
  EntryMovePlan,
  EntryPublishHooks,
} from "./fs/contracts.ts";
export { PublicationError, PartialCreatePublishError, throwIfAborted } from "./fs/errors.ts";
export {
  captureSnapshot,
  captureEntrySnapshot,
  assertSnapshotCurrent,
  assertSafeToReplace,
} from "./fs/snapshot.ts";
export { planNewFile } from "./fs/planning.ts";
export { planEntryMove } from "./fs/entry-move.ts";
export { publishEntryDelete } from "./fs/entry-delete.ts";
export { publishReplacement } from "./fs/replacement.ts";
export { preparePlannedNestedFiles, discardPreparedNestedFiles } from "./fs/nested-staging.ts";
export { publishPreparedNestedFiles } from "./fs/nested-publication.ts";
export { supportsExistingFileReplacement } from "./fs/platform.ts";

/** Keep the existing filesystem API; owners in fs/ implement each publication lifecycle. */
export async function publishEntryMove(
  plan: EntryMovePlan,
  replacement?: MoveReplacement,
  signal?: AbortSignal,
  hooks?: EntryPublishHooks,
): Promise<string[]> {
  assertMoveSnapshot(plan.entry, replacement?.snapshot);
  assertEntryMovePathBudget(plan.entry.actualPath, plan.destination, plan.entry.inputPath);
  if (plan.destination.missingDirectories.length > 0) {
    return publishPlannedNestedFiles(
      [
        {
          plan: plan.destination,
          bytes: replacement?.bytes ?? Buffer.alloc(0),
          move: { entry: plan.entry, snapshot: replacement?.snapshot, hooks },
        },
      ],
      signal,
    );
  }
  return publishDirectEntryMove(plan, replacement, signal, hooks);
}

export async function publishPlannedNestedFiles(
  entries: readonly PlannedNewFile[],
  signal?: AbortSignal,
  hooks?: NewFilePublishHooks,
): Promise<string[]> {
  const prepared = await preparePlannedNestedFiles(entries, signal, hooks);
  return publishPreparedNestedFiles(prepared, signal);
}

// Retain the established positional boundary, including optional plan and observer hooks.
export async function publishNewFile(
  inputTargetPath: string,
  bytes: Buffer,
  signal?: AbortSignal,
  plan?: NewFilePlan,
  hooks?: NewFilePublishHooks,
): Promise<string[]> {
  throwIfAborted(signal);
  const resolvedPlan = plan ?? (await planNewFile(inputTargetPath));
  await assertNewFilePlanCurrent(resolvedPlan);
  if (resolvedPlan.missingDirectories.length > 0) {
    return publishPlannedNestedFiles([{ plan: resolvedPlan, bytes }], signal, hooks);
  }
  return publishSingleNewFile(resolvedPlan, bytes, signal, hooks);
}
