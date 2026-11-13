import type {
  ReadonlyEntryMovePlan,
  ReadonlyEntrySnapshot,
  ReadonlyFileSnapshot,
  ReadonlyNewFilePlan,
} from "../fs/contracts.ts";
import type { ReadonlyPatchUpdate } from "../patch/source.ts";

export { errorMessage } from "../fs/errors.ts";

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
  endText?: string | undefined;
  all?: boolean | undefined;
  /** Keep the matched anchor; insert with no implicit separator. */
  insert?: InsertPosition | undefined;
}
export interface ApplyEditsInput {
  path: string;
  edits?: TargetedEdit[] | undefined;
  rewrite?: string | undefined;
  onMissing?: "error" | "create" | undefined;
  requireMissing?: boolean | undefined;
  preserveFormatting?: boolean | undefined;
}
export interface AppliedEditDetail {
  index: number;
  strategy: MatchStrategy;
  replacements: number;
  lines: number[];
  linesTruncated?: boolean | undefined;
}
export interface ApplyEditsDetails {
  preview?: true | undefined;
  path: string;
  operation: "edit" | "rewrite" | "create" | "patch" | "delete" | "move" | "no_change";
  editsRequested: number;
  editsApplied: number;
  matches: AppliedEditDetail[];
  bytesBefore: number;
  bytesAfter: number;
  addedLines?: number | undefined;
  deletedLines?: number | undefined;
  diff: string;
  diffTruncated: boolean;
  warnings: string[];
}
export type FileStatus = "applied" | "unchanged" | "failed" | "unattempted" | "uncertain";
export interface FileReceipt extends ApplyEditsDetails {
  status: FileStatus;
  moveTo?: string | undefined;
}
export interface ApplyEditsBatchDetails {
  preview?: true | undefined;
  modifiedFiles: string[];
  files: FileReceipt[];
  error?: string | undefined;
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
  preview?: boolean | undefined;
}
export interface WriteFilesRequest {
  files: Array<{
    path: string;
    content: string;
    mode: "create" | "replace";
    preserveFormatting?: boolean | undefined;
  }>;
  preview?: boolean | undefined;
}
/** Read views of caller-owned inputs; the editing pipeline only reads them. */
export type ReadonlyTargetedEdit = Readonly<TargetedEdit>;
type ReadonlyReplaceTextFile = Readonly<Omit<ReplaceTextRequest["files"][number], "edits">> & {
  readonly edits: readonly ReadonlyTargetedEdit[];
};
export type ReadonlyReplaceTextRequest = Readonly<Omit<ReplaceTextRequest, "files">> & {
  readonly files: readonly ReadonlyReplaceTextFile[];
};
export type ReadonlyWriteFilesRequest = Readonly<Omit<WriteFilesRequest, "files">> & {
  readonly files: readonly Readonly<WriteFilesRequest["files"][number]>[];
};
export type MutationInput =
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly edits: readonly ReadonlyTargetedEdit[];
    }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly content: string;
      readonly mode: "create" | "replace";
      readonly preserveFormatting?: boolean | undefined;
    }
  | {
      readonly kind: "patch";
      readonly path: string;
      readonly patch: ReadonlyPatchUpdate;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
    };
export interface UnreachedFile {
  readonly path: string;
  readonly operation: ApplyEditsDetails["operation"];
  readonly moveTo?: string | undefined;
}
interface PlannedContent {
  readonly inputPath: string;
  readonly displayPath: string;
  readonly nextBytes: Buffer;
  readonly originalText: string;
  readonly nextText: string;
  readonly matches: readonly ReadonlyAppliedEditDetail[];
  readonly editsRequested: number;
}
export type PlannedMutation = PlannedContent &
  (
    | {
        readonly operation: "edit" | "rewrite" | "patch" | "no_change";
        readonly snapshot: ReadonlyFileSnapshot;
      }
    | { readonly operation: "create"; readonly createPlan: ReadonlyNewFilePlan }
    | { readonly operation: "delete"; readonly entry: ReadonlyEntrySnapshot }
    | {
        readonly operation: "move";
        readonly movePlan: ReadonlyEntryMovePlan;
        readonly snapshot: ReadonlyFileSnapshot | undefined;
      }
  );
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
  readonly insert?: InsertPosition | undefined;
  readonly applyAll: boolean;
  readonly maxResultLength: number;
  readonly field?: "oldText" | "endText" | undefined;
}
export interface ExecutionOptions {
  readonly cwd: string;
  readonly preview: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((summary: string) => void) | undefined;
  /** Recovery advice when two entries name one file; defaults to combining entries. */
  readonly duplicateTargetHint?: string | undefined;
}
export function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Internal editing invariant");
  }
  return value;
}
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
