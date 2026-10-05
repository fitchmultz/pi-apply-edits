import { lstat } from "node:fs/promises";
import {
  assertSafeToReplace,
  assertSnapshotCurrent,
  captureSnapshot,
  captureEntrySnapshot,
  planEntryMove,
  planNewFile,
  publishEntryDelete,
  publishEntryMove,
  publishReplacement,
  publishNewFile,
  throwIfAborted,
  type FileSnapshot,
} from "../file-system.ts";
import {
  assertPlannedPathBudget,
  assertReplacementPathBudget,
  assertCreatePathBudget,
} from "../path-budget.ts";
import { applyPatchUpdate } from "../patch.ts";
import { resolveInputPath } from "./queue.ts";
import { displayPathFor } from "./receipts.ts";
import {
  decodeText,
  countLeadingBomCharacters,
  detectLineEnding,
  convertLineEndings,
} from "./text.ts";
import { applyTargetedEdits } from "./targeted.ts";
import {
  required,
  type MutationInput,
  type PlannedMutation,
  type ExecutionOptions,
  type TextEditResult,
  type ApplyEditsDetails,
} from "./contracts.ts";

function patchResult(original: string, input: MutationInput): TextEditResult {
  const result = applyPatchUpdate(original, required(input.patch));
  return {
    text: result.text,
    matches: result.matches.map((match, index) => ({
      index,
      strategy: match.strategy,
      replacements: 1,
      lines: [match.line],
    })),
  };
}
async function planEntry(
  input: MutationInput,
  inputPath: string,
  options: ExecutionOptions,
): Promise<PlannedMutation> {
  const displayPath = displayPathFor(inputPath, options.cwd);
  const entry = await captureEntrySnapshot(inputPath, !options.preview);
  if (entry === undefined) {
    throw new Error(`File does not exist: ${displayPath}. No changes were written.`);
  }
  const hasChunks = chunkCount(input) > 0;
  if (hasChunks && entry.symbolicLink) {
    throw new Error(
      `Cannot edit link-target content while moving the link entry ${displayPath}. Use separate calls.`,
    );
  }
  const movePlan =
    input.patch?.moveTo === undefined
      ? undefined
      : await planEntryMove(
          entry,
          resolveInputPath(input.patch.moveTo, options.cwd),
          options.signal,
          options.preview,
        );
  const content = await entryContent(input, inputPath, options);
  return {
    inputPath,
    displayPath,
    ...content,
    entry,
    movePlan,
    createPlan: movePlan?.destination,
    operation: movePlan === undefined ? "delete" : "move",
    editsRequested: Math.max(1, chunkCount(input)),
    needsWrite: true,
  };
}
function chunkCount(input: MutationInput): number {
  return input.patch?.chunks.length ?? 0;
}
async function entryContent(
  input: MutationInput,
  path: string,
  options: ExecutionOptions,
): Promise<
  Pick<PlannedMutation, "snapshot" | "originalText" | "nextText" | "nextBytes" | "matches">
> {
  const snapshot =
    chunkCount(input) > 0 ? await captureSnapshot(path, !options.preview) : undefined;
  const originalText =
    snapshot === undefined
      ? ""
      : decodeText(snapshot.bytes, displayPathFor(path, options.cwd)).text;
  const result =
    snapshot === undefined ? { text: "", matches: [] } : patchResult(originalText, input);
  return {
    snapshot,
    originalText,
    nextText: result.text,
    nextBytes: Buffer.from(result.text, "utf8"),
    matches: result.matches,
  };
}
function assertSourceMode(
  input: MutationInput,
  snapshot: FileSnapshot | undefined,
  displayPath: string,
): void {
  if (snapshot !== undefined && input.requireMissing === true) {
    throw new Error(
      `File now exists: ${displayPath}. Create mode refuses to overwrite an existing target. No changes were written.`,
    );
  }
  if (snapshot === undefined && (input.edits !== undefined || input.patch !== undefined)) {
    throw new Error(
      `Cannot edit missing file ${displayPath}. Use write_files with mode: "create" to create it.`,
    );
  }
  if (snapshot === undefined && input.onMissing !== "create") {
    throw new Error(
      `File does not exist: ${displayPath}. Use write_files with mode: "create" to create it. No changes were written.`,
    );
  }
}
interface ContentUpdate extends TextEditResult {
  readonly operation: ApplyEditsDetails["operation"];
}
function updatedText(
  input: MutationInput,
  original: ReturnType<typeof decodeText>,
  exists: boolean,
  path: string,
): ContentUpdate {
  if (input.patch !== undefined) {
    return { ...patchResult(original.text, input), operation: "patch" };
  }
  if (input.edits !== undefined) {
    return targetedContent(input, original, path);
  }
  return rewriteContent(input, original, exists);
}
function targetedContent(
  input: MutationInput,
  original: ReturnType<typeof decodeText>,
  path: string,
): ContentUpdate {
  const result = applyTargetedEdits(original.body, required(input.edits), path);
  if (countLeadingBomCharacters(result.text) > countLeadingBomCharacters(original.body)) {
    throw new Error(
      `Targeted edits would move or add U+FEFF to the start of ${path}. Use write_files with preserveFormatting: false for an exact encoding change. No changes were written.`,
    );
  }
  return {
    text: `${original.hadBom ? "\uFEFF" : ""}${result.text}`,
    matches: result.matches,
    operation: "edit",
  };
}
function rewriteContent(
  input: MutationInput,
  original: ReturnType<typeof decodeText>,
  exists: boolean,
): ContentUpdate {
  const rewrite = input.rewrite ?? "";
  const preserve = exists && input.preserveFormatting !== false;
  const body = preserve ? convertLineEndings(rewrite, detectLineEnding(original.body)) : rewrite;
  const bom = preserve && original.hadBom && !body.startsWith("\uFEFF") ? "\uFEFF" : "";
  return { text: bom + body, matches: [], operation: exists ? "rewrite" : "create" };
}
async function targetExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
function requestedEditCount(input: MutationInput): number {
  return input.patch?.chunks.length ?? input.edits?.length ?? 1;
}
async function planContent(
  input: MutationInput,
  inputPath: string,
  options: ExecutionOptions,
): Promise<PlannedMutation> {
  const displayPath = displayPathFor(inputPath, options.cwd);
  const snapshot = await captureSnapshot(inputPath, !options.preview);
  assertSourceMode(input, snapshot, displayPath);
  const original =
    snapshot === undefined
      ? { text: "", body: "", hadBom: false }
      : decodeText(snapshot.bytes, displayPath);
  const update = updatedText(input, original, snapshot !== undefined, displayPath);
  const createPlan =
    snapshot === undefined ? await planNewFile(inputPath, !options.preview) : undefined;
  if (createPlan !== undefined && (await targetExists(createPlan.targetPath))) {
    throw new Error(
      `Create mode refuses to overwrite an existing target: ${displayPath}. No changes were written.`,
    );
  }
  const nextBytes = Buffer.from(update.text, "utf8");
  const needsWrite = !(snapshot !== undefined && nextBytes.equals(snapshot.bytes));
  throwIfAborted(options.signal);
  return {
    inputPath,
    displayPath,
    snapshot,
    createPlan,
    nextBytes,
    originalText: original.text,
    nextText: update.text,
    matches: update.matches,
    operation: needsWrite ? update.operation : "no_change",
    editsRequested: requestedEditCount(input),
    needsWrite,
  };
}
async function assertPublicationSupported(
  plan: PlannedMutation,
  signal?: AbortSignal,
): Promise<void> {
  if (plan.entry !== undefined) {
    if (plan.snapshot !== undefined) {
      await assertSafeToReplace(plan.snapshot, signal);
    }
    return;
  }
  if (!plan.needsWrite) {
    return;
  }
  if (plan.snapshot !== undefined) {
    assertReplacementPathBudget(plan.snapshot.actualPath, plan.displayPath);
    await assertSafeToReplace(plan.snapshot, signal);
  } else {
    assertCreatePathBudget(required(plan.createPlan), plan.displayPath);
  }
}
export async function planFile(
  input: MutationInput,
  inputPath: string,
  options: ExecutionOptions,
): Promise<PlannedMutation> {
  throwIfAborted(options.signal);
  assertPlannedPathBudget(displayPathFor(inputPath, options.cwd), [inputPath]);
  const plan =
    input.delete === true || input.patch?.moveTo !== undefined
      ? await planEntry(input, inputPath, options)
      : await planContent(input, inputPath, options);
  // Previews avoid platform-support probes, which may create private files.
  if (!options.preview) {
    await assertPublicationSupported(plan, options.signal);
  }
  return plan;
}
export async function commitPlannedMutation(
  plan: PlannedMutation,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  if (!plan.needsWrite) {
    if (plan.snapshot !== undefined) {
      await assertSnapshotCurrent(plan.snapshot);
    }
    return [];
  }
  if (plan.movePlan !== undefined) {
    const replacement =
      plan.snapshot === undefined ? undefined : { snapshot: plan.snapshot, bytes: plan.nextBytes };
    return publishEntryMove(plan.movePlan, replacement, signal);
  }
  if (plan.entry !== undefined) {
    return publishEntryDelete(plan.entry, signal);
  }
  if (plan.snapshot !== undefined) {
    return publishReplacement(plan.snapshot, plan.nextBytes, signal);
  }
  return publishNewFile(plan.inputPath, plan.nextBytes, signal, plan.createPlan);
}
