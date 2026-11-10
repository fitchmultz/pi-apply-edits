import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
} from "../file-system.ts";
import type { ReadonlyFileSnapshot, ReadonlyNewFilePlan } from "../fs/contracts.ts";
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
import { editTargetedText } from "./targeted.ts";
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
  const planned = {
    inputPath,
    displayPath,
    nextBytes: content.nextBytes,
    originalText: content.originalText,
    nextText: content.nextText,
    matches: content.matches,
    editsRequested: Math.max(1, chunkCount(input)),
  };
  return movePlan === undefined
    ? { ...planned, operation: "delete", entry }
    : { ...planned, operation: "move", movePlan, snapshot: content.snapshot };
}
function chunkCount(input: MutationInput): number {
  return input.patch?.chunks.length ?? 0;
}
async function entryContent(
  input: MutationInput,
  path: string,
  options: ExecutionOptions,
): Promise<{
  readonly snapshot: ReadonlyFileSnapshot | undefined;
  readonly originalText: string;
  readonly nextText: string;
  readonly nextBytes: Buffer;
  readonly matches: TextEditResult["matches"];
}> {
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
function missingFileHint(displayPath: string): string {
  if (!displayPath.startsWith("./~/")) {
    return 'Use write_files with mode: "create" to create it.';
  }
  return `Paths are literal, so ~ is not expanded. To edit a file in the home directory, use its absolute path: ${join(homedir(), displayPath.slice(3))}. To create this path under the working directory instead, use write_files with mode: "create".`;
}
function assertSourceMode(
  input: MutationInput,
  snapshot: ReadonlyFileSnapshot | undefined,
  displayPath: string,
): void {
  if (snapshot !== undefined && input.requireMissing === true) {
    throw new Error(
      `File now exists: ${displayPath}. Create mode refuses to overwrite an existing target. No changes were written.`,
    );
  }
  if (snapshot === undefined && (input.edits !== undefined || input.patch !== undefined)) {
    throw new Error(`Cannot edit missing file ${displayPath}. ${missingFileHint(displayPath)}`);
  }
  if (snapshot === undefined && input.onMissing !== "create") {
    throw new Error(
      `File does not exist: ${displayPath}. Use write_files with mode: "create" to create it. No changes were written.`,
    );
  }
}
interface ContentUpdate extends TextEditResult {
  readonly operation: Extract<ApplyEditsDetails["operation"], "edit" | "rewrite" | "patch">;
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
  const result = editTargetedText(original.body, required(input.edits), path);
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
  return { text: bom + body, matches: [], operation: "rewrite" };
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
  throwIfAborted(options.signal);
  const planned = {
    inputPath,
    displayPath,
    nextBytes,
    originalText: original.text,
    nextText: update.text,
    matches: update.matches,
    editsRequested: requestedEditCount(input),
  };
  return snapshot === undefined
    ? { ...planned, operation: "create", createPlan: required(createPlan) }
    : {
        ...planned,
        operation: nextBytes.equals(snapshot.bytes) ? "no_change" : update.operation,
        snapshot,
      };
}
async function assertPublicationSupported(
  plan: PlannedMutation,
  signal?: AbortSignal,
): Promise<void> {
  switch (plan.operation) {
    case "delete":
    case "no_change":
      return;
    case "move":
      if (plan.snapshot !== undefined) {
        await assertSafeToReplace(plan.snapshot, signal);
      }
      return;
    case "create":
      assertCreatePathBudget(plan.createPlan, plan.displayPath);
      return;
    case "edit":
    case "rewrite":
    case "patch":
      assertReplacementPathBudget(plan.snapshot.actualPath, plan.displayPath);
      await assertSafeToReplace(plan.snapshot, signal);
  }
}
export function plannedCreate(plan: PlannedMutation): ReadonlyNewFilePlan | undefined {
  if (plan.operation === "create") {
    return plan.createPlan;
  }
  return plan.operation === "move" ? plan.movePlan.destination : undefined;
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
  switch (plan.operation) {
    case "no_change":
      await assertSnapshotCurrent(plan.snapshot);
      return [];
    case "move":
      return publishEntryMove(
        plan.movePlan,
        plan.snapshot === undefined
          ? undefined
          : { snapshot: plan.snapshot, bytes: plan.nextBytes },
        signal,
      );
    case "delete":
      return publishEntryDelete(plan.entry, signal);
    case "create":
      return publishNewFile(plan.inputPath, plan.nextBytes, signal, plan.createPlan);
    case "edit":
    case "rewrite":
    case "patch":
      return publishReplacement(plan.snapshot, plan.nextBytes, signal);
  }
}
