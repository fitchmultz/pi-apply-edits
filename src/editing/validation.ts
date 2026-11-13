import { validateText } from "../patch/source.ts";
import {
  MAX_EDITS_PER_FILE,
  MAX_BATCH_FILES,
  errorMessage,
  type MutationInput,
} from "./contracts.ts";

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
}
function validatePath(path: unknown): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  validateText(path, "path");
}
function validateEdits(edits: unknown): void {
  if (!Array.isArray(edits)) {
    throw new Error("edits must be an array");
  }
  if (edits.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }
  if (edits.length > MAX_EDITS_PER_FILE) {
    throw new Error(`edits cannot contain more than ${MAX_EDITS_PER_FILE} entries`);
  }
}
function validateWrite(input: Extract<MutationInput, { readonly kind: "write" }>): void {
  const mode: unknown = input.mode;
  if (mode !== "create" && mode !== "replace") {
    throw new Error('mode must be "create" or "replace"');
  }
  validateText(input.content, "content");
  optionalBoolean(input.preserveFormatting, "preserveFormatting");
}
function validateMutation(input: MutationInput): void {
  validatePath(input.path);
  switch (input.kind) {
    case "edit":
      validateEdits(input.edits);
      return;
    case "write":
      validateWrite(input);
      return;
    case "patch":
    case "delete":
      return;
  }
}
export function validateBatch(files: readonly MutationInput[]): void {
  if (files.length === 0 || files.length > MAX_BATCH_FILES) {
    throw new Error(`files must contain 1–${MAX_BATCH_FILES} entries`);
  }
  for (const [index, file] of files.entries()) {
    try {
      validateMutation(file);
    } catch (cause) {
      throw new Error(`files[${index}]: ${errorMessage(cause)}`, { cause });
    }
  }
}
