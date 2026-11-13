import { parsePatch } from "./patch.ts";
import type { ReadonlyPatchOperation } from "./patch/source.ts";
import { executeFileBatch } from "./editing/batch.ts";
import { failedExecution } from "./editing/receipts.ts";
import type {
  ReadonlyWriteFilesRequest,
  ReadonlyReplaceTextRequest,
  EditingExecution,
  MutationInput,
  UnreachedFile,
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Extract resolvable file paths from a malformed request without risking a secondary throw. */
function unreachedInputs(files: unknown, fallback: "edit" | "rewrite"): UnreachedFile[] {
  if (!Array.isArray(files)) {
    return [];
  }
  const evidence: UnreachedFile[] = [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.length === 0) {
      continue;
    }
    evidence.push({
      path: file.path,
      operation: fallback === "rewrite" && file.mode === "create" ? "create" : fallback,
    });
  }
  return evidence;
}

function replaceMutation(
  file: ReadonlyReplaceTextRequest["files"][number],
  index: number,
): MutationInput {
  if (!isRecord(file)) {
    throw new Error(`files[${index}]: File mutation input must be an object`);
  }
  return { kind: "edit", path: file.path, edits: file.edits };
}

function parseBatchFiles<File>(
  input: { readonly files: readonly File[]; readonly preview?: boolean | undefined },
  fallback: "edit" | "rewrite",
  toMutation: (file: File, index: number) => MutationInput,
  cwd: string,
): { readonly preview: boolean; readonly files: MutationInput[] } | EditingExecution {
  const raw: unknown = input;
  const preview = isRecord(raw) && raw.preview === true;
  try {
    if (!isRecord(raw) || !Array.isArray(raw.files)) {
      throw new Error("files must be an array");
    }
    return { preview, files: input.files.map(toMutation) };
  } catch (error) {
    return failedExecution(
      error,
      preview,
      unreachedInputs(isRecord(raw) ? raw.files : [], fallback),
      cwd,
    );
  }
}

export async function replaceTextInFiles(
  input: ReadonlyReplaceTextRequest,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  const parsed = parseBatchFiles(input, "edit", replaceMutation, cwd);
  if ("details" in parsed) {
    return parsed;
  }
  return executeFileBatch(parsed.files, {
    cwd,
    preview: parsed.preview,
    signal,
    onProgress,
  });
}

function writeMutation(
  file: ReadonlyWriteFilesRequest["files"][number],
  index: number,
): MutationInput {
  if (!isRecord(file)) {
    throw new Error(`files[${index}]: File mutation input must be an object`);
  }
  const mode: unknown = file.mode;
  if (mode !== "create" && mode !== "replace") {
    throw new Error(`files[${index}]: mode must be "create" or "replace"`);
  }
  if (typeof file.content !== "string") {
    throw new Error(`files[${index}]: content must be a string`);
  }
  return {
    kind: "write",
    path: file.path,
    content: file.content,
    mode,
    preserveFormatting: file.preserveFormatting,
  };
}

export async function writeFiles(
  input: ReadonlyWriteFilesRequest,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  const parsed = parseBatchFiles(input, "rewrite", writeMutation, cwd);
  if ("details" in parsed) {
    return parsed;
  }
  return executeFileBatch(parsed.files, {
    cwd,
    preview: parsed.preview,
    signal,
    onProgress,
  });
}

function patchMutation(operation: ReadonlyPatchOperation): MutationInput {
  switch (operation.kind) {
    case "add":
      return {
        kind: "write",
        path: operation.path,
        content: operation.content,
        mode: "create",
      };
    case "delete":
      return { kind: "delete", path: operation.path };
    case "update":
      return { kind: "patch", path: operation.path, patch: operation };
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
