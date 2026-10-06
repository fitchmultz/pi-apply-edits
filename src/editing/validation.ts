import {
  MAX_EDITS_PER_FILE,
  MAX_BATCH_FILES,
  errorMessage,
  type ApplyEditsInput,
  type MutationInput,
} from "./contracts.ts";

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
}
function validateRewriteMode(input: ApplyEditsInput): void {
  optionalBoolean(input.preserveFormatting, "preserveFormatting");
  optionalBoolean(input.requireMissing, "requireMissing");
  const mode: unknown = input.onMissing;
  if (mode !== undefined && mode !== "error" && mode !== "create") {
    throw new Error('onMissing must be either "error" or "create"');
  }
  if (input.requireMissing === true && mode !== "create") {
    throw new Error('requireMissing requires onMissing: "create"');
  }
}
function validateEditsMode(input: ApplyEditsInput): void {
  if (input.edits?.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }
  if (input.edits !== undefined && input.edits.length > MAX_EDITS_PER_FILE) {
    throw new Error(`edits cannot contain more than ${MAX_EDITS_PER_FILE} entries`);
  }
  for (const key of ["onMissing", "requireMissing", "preserveFormatting"] as const) {
    if (input[key] !== undefined) {
      throw new Error(`${key} is valid only with rewrite`);
    }
  }
}
function assertInputObject(input: unknown): void {
  if (typeof input !== "object" || input === null) {
    throw new Error("File mutation input must be an object");
  }
}
function validatePath(path: unknown): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new Error("path cannot contain NUL bytes");
  }
  if (!path.isWellFormed()) {
    throw new Error("path must contain valid Unicode text");
  }
}
function validateRewrite(rewrite: unknown): void {
  if (typeof rewrite !== "string") {
    return;
  }
  if (rewrite.includes("\0")) {
    throw new Error("rewrite cannot contain NUL bytes");
  }
  if (!rewrite.isWellFormed()) {
    throw new Error("rewrite must contain valid Unicode text");
  }
}
function validateInput(input: ApplyEditsInput): void {
  assertInputObject(input);
  validatePath(input.path);
  const hasEdits = Array.isArray(input.edits);
  const hasRewrite = typeof input.rewrite === "string";
  if (hasEdits === hasRewrite) {
    throw new Error("Provide exactly one of edits or rewrite");
  }
  if (hasEdits) {
    validateEditsMode(input);
  }
  validateRewrite(input.rewrite);
  validateRewriteMode(input);
}
export function validateBatch(files: readonly MutationInput[]): void {
  if (files.length === 0 || files.length > MAX_BATCH_FILES) {
    throw new Error(`files must contain 1–${MAX_BATCH_FILES} entries`);
  }
  for (const [index, file] of files.entries()) {
    try {
      if (file.patch === undefined && file.delete !== true) {
        validateInput(file);
      }
    } catch (cause) {
      throw new Error(`files[${index}]: ${errorMessage(cause)}`, { cause });
    }
  }
}
