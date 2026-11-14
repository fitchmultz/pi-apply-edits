import { sep } from "node:path";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import { PublicationError } from "../file-system.ts";
import { countTextLines } from "./text.ts";
import { resolveInputPath } from "./queue.ts";
import {
  errorMessage,
  required,
  type ReadonlyApplyEditsDetails as ApplyEditsDetails,
  type ReadonlyApplyEditsBatchDetails as ApplyEditsBatchDetails,
  type ApplyEditsBatchDetails as MutableBatchDetails,
  type ReadonlyFileReceipt as FileReceipt,
  type FileStatus,
  type EditingExecution,
  type MutationInput,
  type PlannedMutation,
  type UnreachedFile,
} from "./contracts.ts";

export class BatchPublicationError extends Error {
  readonly details: ApplyEditsBatchDetails;
  constructor(message: string, details: ApplyEditsBatchDetails) {
    super(message);
    this.details = details;
  }
}
type ReceiptEvidence = Omit<FileReceipt, "status" | "editsApplied">;
type FileProgress = { readonly evidence: ReceiptEvidence } & (
  | { readonly stage: "unreached" | "planned" }
  | {
      readonly stage: "completed";
      readonly outcome: "applied" | "unchanged";
      /** Completion order preserves warning order when groups finish later input indices first. */
      readonly completionOrder: number;
    }
  | { readonly stage: "failed"; readonly outcome: "failed" | "uncertain" }
);
/**
 * A planned no-change is only "unchanged" in a preview, which never commits. In an apply run the
 * commit-time freshness check decides, so serializing a planned record as unchanged would claim a
 * check that never ran.
 */
function serializeReceipt(file: FileProgress, preview: boolean): FileReceipt {
  let status: FileStatus;
  switch (file.stage) {
    case "unreached":
      status = "unattempted";
      break;
    case "planned":
      status = preview && file.evidence.operation === "no_change" ? "unchanged" : "unattempted";
      break;
    case "completed":
    case "failed":
      status = file.outcome;
      break;
    default: {
      const exhaustive: never = file;
      return exhaustive;
    }
  }
  return {
    ...file.evidence,
    status,
    editsApplied:
      status === "applied"
        ? file.evidence.editsRequested - unchangedEdits(file.evidence.matches).length
        : 0,
  };
}
/** An edit whose oldText and newText are identical is matched and replaces nothing. */
function unchangedEdits(matches: ApplyEditsDetails["matches"]): ApplyEditsDetails["matches"] {
  return matches.filter((match) => match.replacements === 0);
}
/** Names edits that changed nothing, so one written by mistake is not missed. */
function unchangedEditWarnings(plan: PlannedMutation): string[] {
  const unchanged = unchangedEdits(plan.matches);
  if (unchanged.length === 0) {
    return [];
  }
  const names = unchanged.map((match) => `edits[${match.index}]`).join(", ");
  return [`${names} in ${plan.displayPath} made no change: oldText and newText are identical.`];
}
/** Pi's read tool expands `~` and `~/`, so a literal cwd-relative `~` must not read as home. */
function literalTilde(display: string): string {
  return display === "~" || display.startsWith("~/") ? `./${display}` : display;
}
export function displayPathFor(path: string, cwd: string): string {
  const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
  if (!path.startsWith(prefix)) {
    return path;
  }
  const display = path.slice(prefix.length);
  return display.length > 0 ? literalTilde(display) : ".";
}
interface BoundedPatch {
  readonly text: string;
  readonly addedLines: number;
  readonly deletedLines: number;
}
function boundedPatch(path: string, oldText: string, newText: string): BoundedPatch | undefined {
  if (oldText === newText) {
    return { text: "", addedLines: 0, deletedLines: 0 };
  }
  if (
    Buffer.byteLength(oldText) + Buffer.byteLength(newText) > 1024 * 1024 ||
    countTextLines(oldText) + countTextLines(newText) > 20_000
  ) {
    return;
  }
  const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, {
    context: 3,
    timeout: 100,
    maxEditLength: 4_000,
  });
  if (patch === undefined) {
    return;
  }
  const lines = patch.hunks.flatMap((hunk) => hunk.lines);
  return {
    text: formatPatch(patch, FILE_HEADERS_ONLY),
    addedLines: lines.filter((line) => line.startsWith("+")).length,
    deletedLines: lines.filter((line) => line.startsWith("-")).length,
  };
}
function receiptContent(
  plan: PlannedMutation,
  counts: { readonly addedLines: number | undefined; readonly deletedLines: number | undefined },
): Pick<ApplyEditsDetails, "bytesBefore" | "bytesAfter" | "addedLines" | "deletedLines"> {
  if (plan.operation === "delete" || (plan.operation === "move" && plan.snapshot === undefined)) {
    const entry = plan.operation === "delete" ? plan.entry : plan.movePlan.entry;
    const bytesBefore = Number(entry.stats.size);
    return {
      bytesBefore,
      bytesAfter: plan.operation === "delete" ? 0 : bytesBefore,
      addedLines: undefined,
      deletedLines: undefined,
    };
  }
  return {
    bytesBefore: Buffer.byteLength(plan.originalText),
    bytesAfter: Buffer.byteLength(plan.nextText),
    ...counts,
  };
}
function receiptForPlan(plan: PlannedMutation, preview: boolean): ReceiptEvidence {
  const patch = boundedPatch(plan.displayPath, plan.originalText, plan.nextText);
  return {
    path: plan.inputPath,
    operation: plan.operation,
    editsRequested: plan.editsRequested,
    matches: plan.matches,
    ...receiptContent(plan, {
      addedLines: patch?.addedLines,
      deletedLines: patch?.deletedLines,
    }),
    diff: patch?.text ?? "[Diff omitted: input size or diff work exceeded the bounded budget.]",
    diffTruncated: patch === undefined,
    warnings: unchangedEditWarnings(plan),
    ...(preview ? { preview: true } : {}),
    ...(plan.operation === "move" ? { moveTo: plan.movePlan.destination.inputPath } : {}),
  };
}
export function unreachedMutation(input: MutationInput): UnreachedFile {
  switch (input.kind) {
    case "delete":
      return { path: input.path, operation: "delete" };
    case "edit":
      return { path: input.path, operation: "edit" };
    case "patch":
      return input.patch.moveTo === undefined
        ? { path: input.path, operation: "patch" }
        : { path: input.path, operation: "move", moveTo: input.patch.moveTo };
    case "write":
      return {
        path: input.path,
        operation: input.mode === "replace" ? "rewrite" : "create",
      };
  }
}
export function unreachedMutations(inputs: readonly MutationInput[]): UnreachedFile[] {
  return inputs
    .filter((input) => typeof input.path === "string" && input.path.length > 0)
    .map(unreachedMutation);
}
function emptyReceipt(input: UnreachedFile, cwd: string): ReceiptEvidence {
  return {
    path: resolveInputPath(input.path, cwd),
    operation: input.operation,
    editsRequested: 0,
    matches: [],
    bytesBefore: 0,
    bytesAfter: 0,
    addedLines: 0,
    deletedLines: 0,
    diff: "",
    diffTruncated: false,
    warnings: [],
    ...(input.moveTo === undefined ? {} : { moveTo: resolveInputPath(input.moveTo, cwd) }),
  };
}
export function mutableDetails(details: ApplyEditsBatchDetails): MutableBatchDetails {
  return {
    ...details,
    modifiedFiles: [...details.modifiedFiles],
    files: details.files.map((file) => ({
      ...file,
      warnings: [...file.warnings],
      matches: file.matches.map((match) => ({ ...match, lines: [...match.lines] })),
    })),
  };
}
export function failedExecution(
  error: unknown,
  preview: boolean,
  files: readonly UnreachedFile[] = [],
  cwd?: string,
): EditingExecution {
  const message = errorMessage(error);
  const details: ApplyEditsBatchDetails =
    error instanceof BatchPublicationError
      ? error.details
      : {
          files:
            cwd !== undefined
              ? files.map((file) =>
                  serializeReceipt(
                    { stage: "unreached", evidence: emptyReceipt(file, cwd) },
                    preview,
                  ),
                )
              : [],
          modifiedFiles: [],
          ...(preview ? { preview: true } : {}),
          error: message,
        };
  return { summary: message, details: mutableDetails(details) };
}
function committedPaths(plan: PlannedMutation): string[] {
  switch (plan.operation) {
    case "move":
      return [plan.movePlan.entry.actualPath, plan.movePlan.destination.targetPath];
    case "delete":
      return [plan.entry.actualPath];
    case "create":
      return [plan.createPlan.targetPath];
    case "edit":
    case "rewrite":
    case "patch":
    case "no_change":
      return [plan.snapshot.actualPath];
  }
}
function correctionSummary(files: readonly ApplyEditsDetails[]): string {
  const notes = files.flatMap((file) =>
    file.matches
      .filter((match) => match.strategy !== "exact" && match.replacements > 0)
      .map((match) => {
        const prefix = files.length > 1 ? `${file.path}: ` : "";
        const noun = file.operation === "patch" || file.operation === "move" ? "matches" : "edits";
        const more = match.lines.length > 8 || match.linesTruncated === true ? ", …" : "";
        return `${prefix}${noun}[${match.index}] used ${match.strategy} matching (start line${match.lines.length === 1 ? "" : "s"} ${match.lines.slice(0, 8).join(", ")}${more})`;
      }),
  );
  if (notes.length === 0) {
    return "";
  }
  return `; ${notes.slice(0, 4).join("; ")}${notes.length > 4 ? `; ${notes.length - 4} more corrected edits in details` : ""}`;
}
const verbs = {
  create: "create",
  delete: "delete",
  move: "move",
  rewrite: "rewrite",
  edit: "update",
  patch: "update",
  no_change: "update",
} as const;
const appliedVerbs = {
  create: "Created",
  delete: "Deleted",
  move: "Moved",
  rewrite: "Rewrote",
  update: "Updated",
};
function changedDescription(files: readonly FileReceipt[], preview: boolean): string {
  const first = required(files[0]);
  const operation = files.every((file) => file.operation === first.operation)
    ? first.operation
    : undefined;
  const verb = operation === undefined ? "update" : verbs[operation];
  const countsKnown = files.every(
    (item) => item.addedLines !== undefined && item.deletedLines !== undefined,
  );
  const added = files.reduce((sum, item) => sum + (item.addedLines ?? 0), 0);
  const deleted = files.reduce((sum, item) => sum + (item.deletedLines ?? 0), 0);
  const counts = countsKnown && added + deleted > 0 ? ` (+${added}/-${deleted})` : "";
  const names = files
    .slice(0, 8)
    .map((item) => {
      const prefix = operation === undefined ? `${verbs[item.operation]} ` : "";
      return `${prefix}${item.moveTo === undefined ? item.path : `${item.path} → ${item.moveTo}`}`;
    })
    .join(", ");
  const more = files.length > 8 ? `, … ${files.length - 8} more` : "";
  return `${preview ? `Would ${verb}` : appliedVerbs[verb]} ${files.length} file${files.length === 1 ? "" : "s"}${counts}: ${names}${more}`;
}
function warningSummary(files: readonly FileReceipt[]): string {
  const warnings = [...new Set(files.flatMap((item) => item.warnings))];
  const warningText =
    warnings.length > 0
      ? ` Warning: ${warnings.slice(0, 4).join(" ")}${warnings.length > 4 ? ` … ${warnings.length - 4} more` : ""}`
      : "";
  const omitted = files.filter((item) => item.diffTruncated).length;
  const diffNote =
    omitted > 0 ? ` ${omitted} diff${omitted === 1 ? "" : "s"} omitted (diff budget).` : "";
  return diffNote + warningText;
}
export function describeBatch(details: ApplyEditsBatchDetails, cwd: string): EditingExecution {
  const displayFiles = details.files.map((file) => ({
    ...file,
    path: displayPathFor(file.path, cwd),
    moveTo: file.moveTo === undefined ? undefined : displayPathFor(file.moveTo, cwd),
  }));
  const changed = displayFiles.filter((item) => item.operation !== "no_change");
  const preview = details.preview === true;
  if (changed.length === 0) {
    return {
      summary: `No change: ${details.files.length} file${details.files.length === 1 ? "" : "s"} already match.${preview ? " No files written (preview)." : ""}`,
      details: mutableDetails(details),
    };
  }
  return {
    summary: `${changedDescription(changed, preview)}${correctionSummary(displayFiles)}.${preview ? " No files written." : ""}${warningSummary(details.files)}`,
    details: mutableDetails(details),
  };
}

/** Owns mutable progress; published receipts are replaced, never mutated through input aliases. */
export class BatchReceipts {
  private readonly files: FileProgress[];
  /** One evidence owner per committed path; an uncertain report overrides an earlier verified one. */
  private readonly paths = new Map<string, "verified" | "uncertain">();
  private readonly preview: boolean;
  constructor(inputs: readonly MutationInput[], cwd: string, preview: boolean) {
    this.files = inputs.map((input) => ({
      stage: "unreached",
      evidence: emptyReceipt(unreachedMutation(input), cwd),
    }));
    this.preview = preview;
  }
  snapshot(): ApplyEditsBatchDetails {
    return {
      files: this.files.map((file) => serializeReceipt(file, this.preview)),
      modifiedFiles: this.verifiedPaths(),
      ...(this.preview ? { preview: true } : {}),
    };
  }
  failure(message: string): BatchPublicationError {
    return new BatchPublicationError(message, { ...this.snapshot(), error: message });
  }
  fail(indices: readonly number[]): void {
    for (const index of indices) {
      const file = this.files[index];
      // Failure triage may name a group that already completed a verified commit; never relabel it.
      if (file === undefined || file.stage === "completed") {
        continue;
      }
      this.files[index] = {
        stage: "failed",
        outcome: "failed",
        evidence: file.evidence,
      };
    }
  }
  plan(index: number, plan: PlannedMutation): void {
    this.files[index] = { stage: "planned", evidence: receiptForPlan(plan, this.preview) };
  }
  hasCompleted(index: number): boolean {
    return this.files[index]?.stage === "completed";
  }
  completedCount(): number {
    return this.files.filter((file) => file.stage === "completed").length;
  }
  private completedIndices(): number[] {
    return this.files
      .flatMap((file, index) =>
        file.stage === "completed" ? [{ index, order: file.completionOrder }] : [],
      )
      .sort((a, b) => a.order - b.order)
      .map((file) => file.index);
  }
  warnings(index: number, warnings: readonly string[]): void {
    const file = required(this.files[index]);
    this.files[index] = {
      ...file,
      evidence: { ...file.evidence, warnings: [...file.evidence.warnings, ...warnings] },
    };
  }
  complete(index: number, plan: PlannedMutation): void {
    this.recordCompleted(index, plan.operation === "no_change" ? "unchanged" : "applied");
    if (plan.operation !== "no_change") {
      this.recordEvidence(committedPaths(plan), []);
    }
  }
  private recordCompleted(index: number, outcome: "applied" | "unchanged"): void {
    const file = required(this.files[index]);
    this.files[index] = {
      stage: "completed",
      outcome,
      evidence: file.evidence,
      completionOrder: file.stage === "completed" ? file.completionOrder : this.completedCount(),
    };
  }
  private recordPublicationFailure(
    error: unknown,
    group: readonly number[],
    plans: readonly PlannedMutation[],
  ): readonly string[] {
    const verified = error instanceof PublicationError ? error.modifiedFiles : [];
    const uncertain = error instanceof PublicationError ? error.uncertainFiles : [];
    this.recordEvidence(verified, uncertain);
    for (const index of group) {
      if (this.hasCompleted(index)) {
        continue;
      }
      const paths = committedPaths(required(plans[index]));
      if (paths.some((path) => this.paths.get(path) === "uncertain")) {
        this.files[index] = {
          stage: "failed",
          outcome: "uncertain",
          evidence: required(this.files[index]).evidence,
        };
      } else if (paths.every((path) => this.paths.get(path) === "verified")) {
        this.recordCompleted(index, "applied");
      } else {
        this.fail([index]);
      }
    }
    return uncertain;
  }
  private recordEvidence(verified: readonly string[], uncertain: readonly string[]): void {
    for (const path of verified) {
      if (this.paths.get(path) !== "uncertain") {
        this.paths.set(path, "verified");
      }
    }
    for (const path of uncertain) {
      this.paths.set(path, "uncertain");
    }
  }
  private verifiedPaths(): string[] {
    return [...this.paths].flatMap(([path, state]) => (state === "verified" ? [path] : []));
  }
  publicationFailure(
    error: unknown,
    index: number,
    group: readonly number[],
    plans: readonly PlannedMutation[],
  ): BatchPublicationError {
    const uncertain = this.recordPublicationFailure(error, group, plans);
    const completed = this.completedIndices();
    const failed = group.filter((item) => !this.hasCompleted(item));
    const names = (indices: readonly number[]): string =>
      indices.length > 0
        ? indices.map((item) => required(plans[item]).displayPath).join(", ")
        : "none";
    const verified = this.verifiedPaths();
    const earlierWarnings = [
      ...new Set(completed.flatMap((item) => required(this.files[item]).evidence.warnings)),
    ];
    const unattempted = plans.flatMap((_, item) =>
      this.hasCompleted(item) || failed.includes(item) ? [] : [item],
    );
    return this.failure(
      `Multi-file batch failed while publishing files[${index}] (${required(plans[index]).displayPath}) after ${verified.length} verified path change${verified.length === 1 ? "" : "s"}. ${errorMessage(error)}\n` +
        `Verified committed paths: ${verified.length > 0 ? verified.join(", ") : "none"}\nUncertain paths: ${uncertain.length > 0 ? uncertain.join(", ") : "none"}\n` +
        `Completed: ${names(completed.toSorted((a, b) => a - b))}\nFailed or uncertain: ${names(failed)}\nUnattempted: ${names(unattempted)}\n` +
        "Inspect failed/uncertain paths and any retained recovery files before retrying; do not replay the whole batch." +
        (earlierWarnings.length > 0
          ? ` Earlier warnings from completed files: ${earlierWarnings.join(" ")}`
          : ""),
    );
  }
}
