import { inspect } from "node:util";
import type { FileSnapshot, NewFilePlan, EntrySnapshot, EntryMovePlan } from "../file-system.ts";
import type { ReadonlyPatchUpdate } from "../patch/source.ts";

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
  oldText: string;
  newText: string;
  /** Replace through the inclusive end anchor. */
  endText?: string;
  all?: boolean;
  /** Keep the matched anchor; insert with no implicit separator. */
  insert?: InsertPosition;
}
export interface ApplyEditsInput {
  path: string;
  edits?: TargetedEdit[];
  rewrite?: string;
  onMissing?: "error" | "create";
  requireMissing?: boolean;
  preserveFormatting?: boolean;
}
export interface AppliedEditDetail {
  index: number;
  strategy: MatchStrategy;
  replacements: number;
  lines: number[];
  linesTruncated?: boolean;
}
export interface ApplyEditsDetails {
  preview?: true;
  path: string;
  operation: "edit" | "rewrite" | "create" | "patch" | "delete" | "move" | "no_change";
  editsRequested: number;
  editsApplied: number;
  matches: AppliedEditDetail[];
  bytesBefore: number;
  bytesAfter: number;
  addedLines?: number;
  deletedLines?: number;
  diff: string;
  diffTruncated: boolean;
  warnings: string[];
}
export type FileStatus = "applied" | "unchanged" | "failed" | "unattempted" | "uncertain";
export interface FileReceipt extends ApplyEditsDetails {
  status: FileStatus;
  moveTo?: string;
}
export interface ApplyEditsBatchDetails {
  preview?: true;
  modifiedFiles: string[];
  files: FileReceipt[];
  error?: string;
}
export interface EditingExecution {
  summary: string;
  details: ApplyEditsBatchDetails;
}

/** Read contracts used inside the editing pipeline and SDK rendering boundaries. */
export type ReadonlyAppliedEditDetail = Readonly<Omit<AppliedEditDetail, "lines">> & {
  readonly lines: readonly number[];
};
export type ReadonlyApplyEditsDetails = Readonly<
  Omit<ApplyEditsDetails, "matches" | "warnings">
> & {
  readonly matches: readonly ReadonlyAppliedEditDetail[];
  readonly warnings: readonly string[];
};
export type ReadonlyFileReceipt = ReadonlyApplyEditsDetails &
  Readonly<Pick<FileReceipt, "status" | "moveTo">>;
export type ReadonlyApplyEditsBatchDetails = Readonly<
  Omit<ApplyEditsBatchDetails, "modifiedFiles" | "files">
> & {
  readonly modifiedFiles: readonly string[];
  readonly files: readonly ReadonlyFileReceipt[];
};
export type ReadonlyEditingExecution = Readonly<Omit<EditingExecution, "details">> & {
  readonly details: ReadonlyApplyEditsBatchDetails;
};
export interface ReplaceTextRequest {
  files: Array<{ path: string; edits: TargetedEdit[] }>;
  preview?: boolean;
}
export interface WriteFilesRequest {
  files: Array<{
    path: string;
    content: string;
    mode: "create" | "replace";
    preserveFormatting?: boolean;
  }>;
  preview?: boolean;
}
/** Read views of caller-owned inputs; the editing pipeline only reads them. */
export type ReadonlyTargetedEdit = Readonly<TargetedEdit>;
export type ReadonlyApplyEditsInput = Readonly<Omit<ApplyEditsInput, "edits">> & {
  readonly edits?: readonly ReadonlyTargetedEdit[];
};
type ReadonlyReplaceTextFile = Readonly<Omit<ReplaceTextRequest["files"][number], "edits">> & {
  readonly edits: readonly ReadonlyTargetedEdit[];
};
export type ReadonlyReplaceTextRequest = Readonly<Omit<ReplaceTextRequest, "files">> & {
  readonly files: readonly ReadonlyReplaceTextFile[];
};
export type ReadonlyWriteFilesRequest = Readonly<Omit<WriteFilesRequest, "files">> & {
  readonly files: readonly Readonly<WriteFilesRequest["files"][number]>[];
};
export interface MutationInput extends ReadonlyApplyEditsInput {
  readonly patch?: ReadonlyPatchUpdate;
  readonly delete?: true;
}
export interface PlannedMutation {
  readonly inputPath: string;
  readonly displayPath: string;
  readonly snapshot: FileSnapshot | undefined;
  readonly nextBytes: Buffer;
  readonly originalText: string;
  readonly nextText: string;
  readonly matches: readonly ReadonlyAppliedEditDetail[];
  readonly operation: ApplyEditsDetails["operation"];
  readonly editsRequested: number;
  readonly needsWrite: boolean;
  readonly createPlan?: NewFilePlan;
  readonly lockKey?: string;
  readonly entry?: EntrySnapshot;
  readonly movePlan?: EntryMovePlan;
}
export interface TextEditResult {
  text: string;
  matches: AppliedEditDetail[];
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
export function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Internal editing invariant");
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
