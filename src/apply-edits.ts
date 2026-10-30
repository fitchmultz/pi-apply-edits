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
  try {
    return await executeFileBatch(input.files.map(writeMutation), {
      cwd,
      preview: input.preview === true,
      signal,
      onProgress,
    });
  } catch (error) {
    return failedExecution(error, input.preview === true);
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
    });
  } catch (error) {
    return failedExecution(error, preview);
  }
}
