import { isAbsolute, relative, sep } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { PublicationError } from "../file-system.ts";
import { countTextLines } from "./text.ts";
import { resolveInputPath } from "./queue.ts";
import {
  errorMessage,
  required,
  type ApplyEditsDetails,
  type ApplyEditsBatchDetails,
  type FileReceipt,
  type FileStatus,
  type EditingExecution,
  type MutationInput,
  type PlannedMutation,
} from "./contracts.ts";

export class BatchPublicationError extends Error {
  readonly details: ApplyEditsBatchDetails;
  constructor(message: string, details: ApplyEditsBatchDetails) {
    super(message);
    this.details = details;
  }
}
export function displayPathFor(path: string, cwd: string): string {
  if (process.platform !== "win32") {
    const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
    if (!path.startsWith(prefix)) {
      return path;
    }
    const display = path.slice(prefix.length);
    return display.length > 0 ? display : ".";
  }
  const candidate = relative(cwd, path);
  const outside = candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate);
  const display = candidate.length > 0 ? candidate : ".";
  return (outside ? path : display).split(sep).join("/");
}
function boundedPatch(path: string, oldText: string, newText: string): string | undefined {
  if (oldText === newText) {
    return "";
  }
  if (
    Buffer.byteLength(oldText) + Buffer.byteLength(newText) > 1024 * 1024 ||
    countTextLines(oldText) + countTextLines(newText) > 20_000
  ) {
    return;
  }
  return createTwoFilesPatch(path, path, oldText, newText, undefined, undefined, {
    context: 3,
    headerOptions: FILE_HEADERS_ONLY,
    timeout: 100,
    maxEditLength: 4_000,
  });
}
function countPatchLines(patch: string): {
  readonly addedLines: number;
  readonly deletedLines: number;
} {
  let addedLines = 0;
  let deletedLines = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      addedLines++;
    } else if (inHunk && line.startsWith("-")) {
      deletedLines++;
    }
  }
  return { addedLines, deletedLines };
}
function receiptContent(
  plan: PlannedMutation,
  counts: { readonly addedLines: number | undefined; readonly deletedLines: number | undefined },
): Pick<ApplyEditsDetails, "bytesBefore" | "bytesAfter" | "addedLines" | "deletedLines"> {
  if (plan.entry !== undefined && plan.snapshot === undefined) {
    const bytesBefore = Number(plan.entry.stats.size);
    return {
      bytesBefore,
      bytesAfter: plan.movePlan === undefined ? 0 : bytesBefore,
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
export function receiptForPlan(plan: PlannedMutation, preview: boolean): FileReceipt {
  const patch = boundedPatch(plan.displayPath, plan.originalText, plan.nextText);
  const counts =
    patch === undefined
      ? { addedLines: undefined, deletedLines: undefined }
      : countPatchLines(patch);
  return {
    path: plan.inputPath,
    operation: plan.operation,
    editsRequested: plan.editsRequested,
    editsApplied: 0,
    matches: plan.matches,
    ...receiptContent(plan, counts),
    diff: patch ?? "[Diff omitted: input size or diff work exceeded the bounded budget.]",
    diffTruncated: patch === undefined,
    warnings: [],
    status: plan.needsWrite ? "unattempted" : "unchanged",
    ...(preview ? { preview: true } : {}),
    ...(plan.movePlan === undefined ? {} : { moveTo: plan.movePlan.destination.inputPath }),
  };
}
function inputOperation(input: MutationInput): ApplyEditsDetails["operation"] {
  if (input.delete === true) {
    return "delete";
  }
  if (input.patch !== undefined) {
    return input.patch.moveTo === undefined ? "patch" : "move";
  }
  if (input.edits !== undefined) {
    return "edit";
  }
  return input.requireMissing === true ? "create" : "rewrite";
}
export function emptyReceipt(input: MutationInput, cwd: string): FileReceipt {
  return {
    path: resolveInputPath(input.path, cwd),
    operation: inputOperation(input),
    editsRequested: 0,
    editsApplied: 0,
    matches: [],
    bytesBefore: 0,
    bytesAfter: 0,
    addedLines: 0,
    deletedLines: 0,
    diff: "",
    diffTruncated: false,
    warnings: [],
    status: "unattempted",
    ...(input.patch?.moveTo === undefined
      ? {}
      : { moveTo: resolveInputPath(input.patch.moveTo, cwd) }),
  };
}
function isArrayInput(value: unknown): boolean {
  return Array.isArray(value);
}
function hasStringPath(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "path" in value && typeof value.path === "string"
  );
}
export function failedExecution(
  error: unknown,
  preview: boolean,
  files: readonly MutationInput[] = [],
  cwd?: string,
): EditingExecution {
  const message = errorMessage(error);
  const details: ApplyEditsBatchDetails =
    error instanceof BatchPublicationError
      ? error.details
      : {
          files:
            isArrayInput(files) && cwd !== undefined
              ? files.filter(hasStringPath).map((file) => emptyReceipt(file, cwd))
              : [],
          modifiedFiles: [],
          ...(preview ? { preview: true } : {}),
          error: message,
        };
  return { summary: message, details };
}
export function committedPaths(plan: PlannedMutation): string[] {
  if (plan.movePlan !== undefined) {
    return [plan.movePlan.entry.actualPath, plan.movePlan.destination.targetPath];
  }
  return [
    plan.entry?.actualPath ??
      plan.snapshot?.actualPath ??
      plan.createPlan?.targetPath ??
      plan.inputPath,
  ];
}
function correctionSummary(files: readonly ApplyEditsDetails[]): string {
  const notes = files.flatMap((file) =>
    file.matches
      .filter((match) => match.strategy !== "exact")
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
  const displayFiles = details.files.map((file) =>
    Object.assign({}, file, {
      path: displayPathFor(file.path, cwd),
      moveTo: file.moveTo === undefined ? undefined : displayPathFor(file.moveTo, cwd),
    }),
  );
  const changed = displayFiles.filter((item) => item.operation !== "no_change");
  const preview = details.preview === true;
  if (changed.length === 0) {
    return {
      summary: `No change: ${details.files.length} file${details.files.length === 1 ? "" : "s"} already match.${preview ? " No files written (preview)." : ""}`,
      details,
    };
  }
  return {
    summary: `${changedDescription(changed, preview)}${correctionSummary(displayFiles)}.${preview ? " No files written." : ""}${warningSummary(details.files)}`,
    details,
  };
}

/** Owns mutable progress; published receipts are replaced, never mutated through input aliases. */
export class BatchReceipts {
  private readonly files: FileReceipt[];
  private readonly modifiedFiles: string[] = [];
  private readonly completed = new Set<number>();
  private readonly preview: boolean;
  constructor(inputs: readonly MutationInput[], cwd: string, preview: boolean) {
    this.files = inputs.map((input) => emptyReceipt(input, cwd));
    this.preview = preview;
  }
  snapshot(): ApplyEditsBatchDetails {
    return {
      files: [...this.files],
      modifiedFiles: [...new Set(this.modifiedFiles)],
      ...(this.preview ? { preview: true } : {}),
    };
  }
  failure(message: string): BatchPublicationError {
    return new BatchPublicationError(message, { ...this.snapshot(), error: message });
  }
  fail(indices: readonly number[]): void {
    for (const index of indices) {
      this.setStatus(index, "failed");
    }
  }
  plan(index: number, plan: PlannedMutation): void {
    this.files[index] = receiptForPlan(plan, this.preview);
  }
  hasCompleted(index: number): boolean {
    return this.completed.has(index);
  }
  completedCount(): number {
    return this.completed.size;
  }
  warnings(index: number, warnings: readonly string[]): void {
    const file = required(this.files[index]);
    this.files[index] = { ...file, warnings: [...file.warnings, ...warnings] };
  }
  complete(index: number, plan: PlannedMutation): void {
    this.completed.add(index);
    this.setStatus(index, plan.needsWrite ? "applied" : "unchanged");
    if (plan.needsWrite) {
      this.modifiedFiles.push(...committedPaths(plan));
    }
  }
  private setStatus(index: number, status: FileStatus): void {
    const file = required(this.files[index]);
    this.files[index] = {
      ...file,
      status,
      editsApplied: status === "applied" ? file.editsRequested : 0,
    };
  }
  private recordPublicationFailure(
    error: unknown,
    group: readonly number[],
    plans: readonly PlannedMutation[],
  ): readonly string[] {
    const uncertain = error instanceof PublicationError ? error.uncertainFiles : [];
    if (error instanceof PublicationError) {
      this.modifiedFiles.push(...error.modifiedFiles);
    }
    const verified = new Set(this.modifiedFiles);
    for (const index of group) {
      if (this.completed.has(index)) {
        continue;
      }
      const paths = committedPaths(required(plans[index]));
      let status: FileStatus = "failed";
      if (paths.some((path) => uncertain.includes(path))) {
        status = "uncertain";
      } else if (paths.every((path) => verified.has(path))) {
        status = "applied";
        this.completed.add(index);
      }
      this.setStatus(index, status);
    }
    return uncertain;
  }
  publicationFailure(
    error: unknown,
    index: number,
    group: readonly number[],
    plans: readonly PlannedMutation[],
  ): BatchPublicationError {
    const uncertain = this.recordPublicationFailure(error, group, plans);
    const failed = group.filter((item) => !this.completed.has(item));
    const names = (indices: readonly number[]): string =>
      indices.length > 0
        ? indices.map((item) => required(plans[item]).displayPath).join(", ")
        : "none";
    const verified = [...new Set(this.modifiedFiles)];
    const earlierWarnings = [
      ...new Set([...this.completed].flatMap((item) => required(this.files[item]).warnings)),
    ];
    const unattempted = plans.flatMap((_, item) =>
      this.completed.has(item) || failed.includes(item) ? [] : [item],
    );
    return this.failure(
      `Multi-file batch failed while publishing files[${index}] (${required(plans[index]).displayPath}) after ${verified.length} verified path change${verified.length === 1 ? "" : "s"}. ${errorMessage(error)}\n` +
        `Verified committed paths: ${verified.length > 0 ? verified.join(", ") : "none"}\nUncertain paths: ${uncertain.length > 0 ? uncertain.join(", ") : "none"}\n` +
        `Completed: ${names([...this.completed].sort((a, b) => a - b))}\nFailed or uncertain: ${names(failed)}\nUnattempted: ${names(unattempted)}\n` +
        "Inspect failed/uncertain paths and any retained recovery files before retrying; do not replay the whole batch." +
        (earlierWarnings.length > 0
          ? ` Earlier warnings from completed files: ${earlierWarnings.join(" ")}`
          : ""),
    );
  }
}
