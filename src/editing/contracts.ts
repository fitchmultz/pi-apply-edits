import { inspect } from "node:util";
import type { FileSnapshot, NewFilePlan, EntrySnapshot, EntryMovePlan } from "../file-system.ts";
import type { PatchOperation } from "../patch.ts";

export type InsertPosition = "before" | "after";
export type MatchStrategy =
  | "exact"
  | "normalized"
  | "indent-normalized"
  | "whitespace"
  | "typography";
export const MAX_EDITS_PER_FILE = 100;
export const MAX_BATCH_FILES = 64;
export const MAX_EDIT_EXPANSION_CHARS = 8 * 1024 * 1024;
export const MAX_REPLACEMENTS = 10_000;

export interface TargetedEdit {
  readonly oldText: string;
  readonly newText: string;
  /** Replace through the inclusive end anchor. */
  readonly endText?: string;
  readonly all?: boolean;
  /** Keep the matched anchor; insert with no implicit separator. */
  readonly insert?: InsertPosition;
}
export interface ApplyEditsInput {
  readonly path: string;
  readonly edits?: readonly TargetedEdit[];
  readonly rewrite?: string;
  readonly onMissing?: "error" | "create";
  readonly requireMissing?: boolean;
  readonly preserveFormatting?: boolean;
}
export interface AppliedEditDetail {
  readonly index: number;
  readonly strategy: MatchStrategy;
  readonly replacements: number;
  readonly lines: readonly number[];
  readonly linesTruncated?: boolean;
}
export interface ApplyEditsDetails {
  readonly preview?: true;
  readonly path: string;
  readonly operation: "edit" | "rewrite" | "create" | "patch" | "delete" | "move" | "no_change";
  readonly editsRequested: number;
  readonly editsApplied: number;
  readonly matches: readonly AppliedEditDetail[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly warnings: readonly string[];
}
export type FileStatus = "applied" | "unchanged" | "failed" | "unattempted" | "uncertain";
export interface FileReceipt extends ApplyEditsDetails {
  readonly status: FileStatus;
  readonly moveTo?: string;
}
export interface ApplyEditsBatchDetails {
  readonly preview?: true;
  readonly modifiedFiles: readonly string[];
  readonly files: readonly FileReceipt[];
  readonly error?: string;
}
export interface EditingExecution {
  readonly summary: string;
  readonly details: ApplyEditsBatchDetails;
}
export interface ReplaceTextRequest {
  readonly files: readonly { readonly path: string; readonly edits: readonly TargetedEdit[] }[];
  readonly preview?: boolean;
}
export interface WriteFilesRequest {
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
    readonly mode: "create" | "replace";
    readonly preserveFormatting?: boolean;
  }[];
  readonly preview?: boolean;
}
export interface MutationInput extends ApplyEditsInput {
  readonly patch?: Extract<PatchOperation, { kind: "update" }>;
  readonly delete?: true;
}
export interface PlannedMutation {
  readonly inputPath: string;
  readonly displayPath: string;
  readonly snapshot: FileSnapshot | undefined;
  readonly nextBytes: Buffer;
  readonly originalText: string;
  readonly nextText: string;
  readonly matches: readonly AppliedEditDetail[];
  readonly operation: ApplyEditsDetails["operation"];
  readonly editsRequested: number;
  readonly needsWrite: boolean;
  readonly createPlan?: NewFilePlan;
  readonly lockKey?: string;
  readonly entry?: EntrySnapshot;
  readonly movePlan?: EntryMovePlan;
}
export interface TextEditResult {
  readonly text: string;
  readonly matches: readonly AppliedEditDetail[];
}
export interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly text: string;
  readonly line: number;
}
export interface MatchResult {
  readonly strategy: MatchStrategy;
  readonly replacements: readonly Replacement[];
}
export interface EditSearch {
  readonly oldText: string;
  readonly newText: string;
  readonly insert?: InsertPosition;
  readonly applyAll: boolean;
  readonly maxResultLength: number;
  readonly field?: "oldText" | "endText";
}
export interface ExecutionOptions {
  readonly cwd: string;
  readonly preview: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (summary: string) => void;
}
export function required<T>(value: T | undefined, label = "Internal editing invariant"): T {
  if (value === undefined) {
    throw new Error(label);
  }
  return value;
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return inspect(error);
}
