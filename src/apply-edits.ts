import { parsePatch } from "./patch.ts";
import type { ReadonlyPatchOperation } from "./patch/source.ts";
import { executeFileBatch } from "./editing/batch.ts";
import { failedExecution } from "./editing/receipts.ts";
import type {
  ReadonlyWriteFilesRequest,
  ReadonlyReplaceTextRequest,
  EditingExecution,
  MutationInput,
} from "./editing/contracts.ts";

export { applyTargetedEdits } from "./editing/targeted.ts";
export { resolveInputPath } from "./editing/queue.ts";
export { MAX_EDITS_PER_FILE, MAX_BATCH_FILES } from "./editing/contracts.ts";
export type {
  InsertPosition,
  TargetedEdit,
  ApplyEditsInput,
  MatchStrategy,
  AppliedEditDetail,
  ApplyEditsDetails,
  FileStatus,
  FileReceipt,
  ApplyEditsBatchDetails,
  EditingExecution,
  ReplaceTextRequest,
  WriteFilesRequest,
} from "./editing/contracts.ts";

export async function replaceTextInFiles(
  input: ReadonlyReplaceTextRequest,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  return executeFileBatch(input.files, {
    cwd,
    preview: input.preview === true,
    signal,
    onProgress,
  });
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** One resolvable input from a request that never reached planning; malformed entries add none. */
function writeEvidence(file: unknown): MutationInput | undefined {
  if (!isRecord(file)) {
    return;
  }
  const path = file["path"];
  if (typeof path !== "string" || path.length === 0) {
    return;
  }
  const create = file["mode"] === "create";
  return {
    path,
    onMissing: create ? "create" : undefined,
    requireMissing: create ? true : undefined,
  };
}

/**
 * Evidence for a malformed request. Total on purpose: it must still resolve to a receipt,
 * so it cannot throw a second error from the catch that called it.
 */
function writeEvidenceList(files: unknown): MutationInput[] {
  if (!Array.isArray(files)) {
    return [];
  }
  const evidence: MutationInput[] = [];
  for (const file of files) {
    const item = writeEvidence(file);
    if (item !== undefined) {
      evidence.push(item);
    }
  }
  return evidence;
}
function writeMutation(file: ReadonlyWriteFilesRequest["files"][number]): MutationInput {
  const mode: unknown = file.mode;
  if (mode !== "create" && mode !== "replace") {
    throw new Error('mode must be "create" or "replace"');
  }
  if (typeof file.content !== "string") {
    throw new Error("content must be a string");
  }
  return {
    path: file.path,
    rewrite: file.content,
    onMissing: mode === "create" ? "create" : "error",
    requireMissing: mode === "create",
    preserveFormatting: file.preserveFormatting,
  };
}
export async function writeFiles(
  input: ReadonlyWriteFilesRequest,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  const preview = input.preview === true;
  let files: MutationInput[];
  try {
    files = input.files.map(writeMutation);
  } catch (error) {
    // The request is invalid, but its paths are still resolvable evidence for the caller.
    return failedExecution(error, preview, writeEvidenceList(input.files), cwd);
  }
  try {
    return await executeFileBatch(files, { cwd, preview, signal, onProgress });
  } catch (error) {
    return failedExecution(error, preview);
  }
}
function patchMutation(operation: ReadonlyPatchOperation): MutationInput {
  switch (operation.kind) {
    case "add":
      return {
        path: operation.path,
        rewrite: operation.content,
        onMissing: "create",
        requireMissing: true,
      };
    case "delete":
      return { path: operation.path, delete: true };
    case "update":
      return { path: operation.path, patch: operation };
  }
}
// oxlint-disable-next-line max-params -- QX-002: Preserve the public positional editing API.
export async function applyPatchToFiles(
  input: string,
  cwd: string,
  preview = false,
  signal?: AbortSignal,
  onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  try {
    return await executeFileBatch(parsePatch(input).operations.map(patchMutation), {
      cwd,
      preview,
      signal,
      onProgress,
      duplicateTargetHint:
        'A patch can name each file once. Use one Update File section, or write_files with mode: "replace" to rewrite a file.',
    });
  } catch (error) {
    return failedExecution(error, preview);
  }
}
