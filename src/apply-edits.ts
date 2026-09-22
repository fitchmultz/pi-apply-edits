import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { assertNotDanglingSymbolicLink, nativeRealpath, operationPath, prospectiveTarget } from "./native-path.ts";
import * as pi from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import {
  assertSafeToReplace,
  assertSnapshotCurrent,
  captureSnapshot,
  captureEntrySnapshot,
  planEntryMove,
  publishEntryDelete,
  publishEntryMove,
  type EntrySnapshot,
  type EntryMovePlan,
  discardPreparedNestedFiles,
  planNewFile,
  preparePlannedNestedFiles,
  publishNewFile,
  publishPreparedNestedFiles,
  publishReplacement,
  PublicationError,
  type NewFilePlan,
  type PreparedNestedFiles,
  throwIfAborted,
} from "./file-system.ts";
import { applyPatchUpdate, parsePatch, type PatchOperation } from "./patch.ts";
import { assertPlannedPathBudget, assertReplacementPathBudget, assertCreatePathBudget } from "./path-budget.ts";

export type InsertPosition = "before" | "after";

export interface TargetedEdit {
  oldText: string;
  newText: string;
  /** When set, replace from oldText through endText, including both anchors. */
  endText?: string;
  all?: boolean;
  /** When set, insert newText before/after the matched oldText instead of replacing it. */
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

/** Tool args: one file (path + edits|rewrite) or a plan-first multi-file batch. */
export interface ApplyEditsRequest {
  path?: string;
  edits?: TargetedEdit[];
  rewrite?: string;
  onMissing?: "error" | "create";
  requireMissing?: boolean;
  preserveFormatting?: boolean;
  files?: ApplyEditsInput[];
  preview?: boolean;
}


export type MatchStrategy = "exact" | "normalized" | "indent-normalized" | "whitespace" | "typography";

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

interface MutationInput extends ApplyEditsInput {
  patch?: Extract<PatchOperation, { kind: "update" }>;
  delete?: true;
}

class BatchPublicationError extends Error {
  readonly details: ApplyEditsBatchDetails;
  constructor(message: string, details: ApplyEditsBatchDetails) {
    super(message);
    this.details = details;
  }
}

export type ApplyEditsToolDetails = ApplyEditsDetails | ApplyEditsBatchDetails;

export interface ApplyEditsExecution {
  summary: string;
  details: ApplyEditsToolDetails;
}

interface TextEditResult {
  text: string;
  matches: AppliedEditDetail[];
}

interface TextLine {
  start: number;
  end: number;
  bodyEnd: number;
  body: string;
  ending: string;
  number: number;
}

interface Replacement {
  /** Write range [start, end). Zero-width for inserts. */
  start: number;
  end: number;
  /** Matched anchor range, used for overlap checks (inserts keep a non-zero span here). */
  matchStart: number;
  matchEnd: number;
  text: string;
  line: number;
}

interface MatchResult {
  strategy: MatchStrategy;
  replacements: Replacement[];
}

const { withFileMutationQueue } = pi;
// Official 0.87 exposes only the queue; newer hosts also expose its content identity.
const sharedQueueKey = "getFileMutationQueueKey" in pi && typeof pi.getFileMutationQueueKey === "function"
  ? pi.getFileMutationQueueKey as (path: string) => Promise<string> : undefined;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DIFF_WORK_LIMIT_BYTES = 1024 * 1024;
const DIFF_TIMEOUT_MS = 100;
const DIFF_MAX_EDIT_LENGTH = 4_000;
const DIFF_TOTAL_LINE_LIMIT = 20_000;
const FUZZY_SEARCH_LIMIT_BYTES = 64 * 1024;
const FUZZY_WORK_BUDGET = 2_000_000;
const FUZZY_SEARCH_LIMIT_LINES = 200;
const FUZZY_CONTENT_LIMIT_CHARS = 1_000_000;
const FUZZY_CONTENT_LIMIT_LINES = 50_000;
const MAX_REPLACEMENTS = 10_000;
export const MAX_EDITS_PER_FILE = 100;
export const MAX_BATCH_FILES = 64;
const MAX_EDIT_EXPANSION_CHARS = 8 * 1024 * 1024;
const DIAGNOSTIC_LIMIT_BYTES = 1_200;
const DIAGNOSTIC_SEARCH_LIMIT_BYTES = 8 * 1024;
const DIAGNOSTIC_SEARCH_LIMIT_LINES = 40;
const DIAGNOSTIC_CONTENT_LIMIT_CHARS = 500_000;
const DIAGNOSTIC_CONTENT_LIMIT_LINES = 20_000;
const DIAGNOSTIC_WORK_BUDGET = 2_000_000;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

type LineEnding = "\n" | "\r\n" | "\r";

export function resolveInputPath(input: string, cwd: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  return operationPath(input, cwd);
}

export function applyTargetedEdits(
  original: string,
  edits: TargetedEdit[],
  displayPath: string,
): TextEditResult {
  if (edits.length === 0) throw new Error("edits must contain at least one replacement");
  if (edits.length > MAX_EDITS_PER_FILE) {
    throw new Error(`edits cannot contain more than ${MAX_EDITS_PER_FILE} entries`);
  }

  let current = original;
  const maxResultLength = Math.min(Number.MAX_SAFE_INTEGER, original.length + MAX_EDIT_EXPANSION_CHARS);
  const matches: AppliedEditDetail[] = [];

  for (const [index, edit] of edits.entries()) {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      throw new Error(`edits[${index}] must contain string oldText and newText fields`);
    }
    if (edit.all !== undefined && typeof edit.all !== "boolean") {
      throw new Error(`edits[${index}].all must be a boolean`);
    }
    if (edit.insert !== undefined && edit.insert !== "before" && edit.insert !== "after") {
      throw new Error(`edits[${index}].insert must be "before" or "after"`);
    }
    if (edit.endText !== undefined && typeof edit.endText !== "string") {
      throw new Error(`edits[${index}].endText must be a string`);
    }
    // Preserve the caller's exact anchors. Line-ending tolerance belongs in fuzzy matching,
    // otherwise a mixed-EOL file can redirect an exact LF edit to a different block.
    const oldText = edit.oldText;
    const newText = edit.newText;
    const endText = edit.endText;
    if (oldText.length === 0) {
      throw new Error(`edits[${index}].oldText must not be empty`);
    }
    if (endText !== undefined && endText.length === 0) {
      throw new Error(`edits[${index}].endText must not be empty`);
    }
    if (oldText.includes("\0") || newText.includes("\0") || endText?.includes("\0")) {
      throw new Error(`edits[${index}] cannot read or write NUL bytes`);
    }
    if (
      !oldText.isWellFormed() ||
      !newText.isWellFormed() ||
      (endText !== undefined && !endText.isWellFormed())
    ) {
      throw new Error(`edits[${index}] must contain valid Unicode text`);
    }
    if (endText !== undefined && edit.all === true) {
      throw new Error(`edits[${index}].all cannot be combined with endText`);
    }
    if (endText !== undefined && edit.insert !== undefined) {
      throw new Error(`edits[${index}].insert cannot be combined with endText`);
    }
    if (edit.insert) {
      if (newText.length === 0) {
        throw new Error(`edits[${index}].newText must not be empty when insert is set`);
      }
    } else if (endText === undefined && oldText === newText) {
      throw new Error(`edits[${index}] would make no change because oldText and newText are identical`);
    }

    const match = endText === undefined
      ? findMatch(current, oldText, newText, edit.insert, edit.all === true, maxResultLength)
      : findRangeMatch(current, oldText, endText, newText, displayPath, index);
    if (!match) {
      throw new Error(missingEditMessage(current, oldText, newText, displayPath, index));
    }
    if (!edit.all && match.replacements.length > 1) {
      const lines = match.replacements.slice(0, 8).map((item) => item.line);
      const suffix = match.replacements.length > lines.length ? ", …" : "";
      throw new Error(
        `edits[${index}].oldText matched ${match.replacements.length} locations in ${displayPath} ` +
          `(lines ${lines.join(", ")}${suffix}). Add enough surrounding text to make it unique, ` +
          `or set all: true only when every match should change. No changes were written.`,
      );
    }

    const selected = (edit.all ? match.replacements : match.replacements.slice(0, 1)).map((item) => {
      // Preserve the unmatched half of a CRLF unless an inserted/replacement newline
      // supplies it. Literal CR/LF deletions must not consume adjacent bytes.
      const start = current[item.matchStart] === "\n" && current[item.matchStart - 1] === "\r" &&
        (edit.insert || /^[\r\n]/.test(item.text)) ? item.matchStart - 1 : item.matchStart;
      const end = current[item.matchEnd - 1] === "\r" && current[item.matchEnd] === "\n" &&
        (edit.insert || hasFinalLineEnding(item.text)) ? item.matchEnd + 1 : item.matchEnd;
      return toReplacement(start, end, item.text, item.line, edit.insert);
    });
    if (hasOverlaps(selected)) {
      throw new Error(
        `edits[${index}] has overlapping matches in ${displayPath}. ` +
          "Add more surrounding text so matches do not overlap. No changes were written.",
      );
    }
    const effective = edit.insert
      ? selected
      : selected.filter((item) => current.slice(item.start, item.end) !== item.text);
    if (effective.length === 0) {
      throw new Error(
        `edits[${index}] already produces the requested text at its matched location in ${displayPath}. ` +
          "No changes were written.",
      );
    }

    current = applyReplacements(current, effective, maxResultLength);
    matches.push({
      index,
      strategy: match.strategy,
      replacements: effective.length,
      lines: effective.slice(0, 32).map((item) => item.line),
      linesTruncated: effective.length > 32 || undefined,
    });
  }

  if (current === original) {
    throw new Error(`The ordered edits cancel each other out in ${displayPath}; no changes were written.`);
  }
  return { text: current, matches };
}

export interface ReplaceTextRequest {
  files: Array<{ path: string; edits: TargetedEdit[] }>;
  preview?: boolean;
}

export interface WriteFilesRequest {
  files: Array<{ path: string; content: string; mode: "create" | "replace"; preserveFormatting?: boolean }>;
  preview?: boolean;
}

export async function replaceTextInFiles(
  input: ReplaceTextRequest, cwd: string, signal?: AbortSignal, onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  return executeFileBatch(input.files, cwd, input.preview === true, signal, onProgress);
}

export async function writeFiles(
  input: WriteFilesRequest, cwd: string, signal?: AbortSignal, onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  try {
    const files = input.files.map((file) => {
      if (file.mode !== "create" && file.mode !== "replace") throw new Error('mode must be "create" or "replace"');
      if (typeof file.content !== "string") throw new Error("content must be a string");
      return { path: file.path, rewrite: file.content,
        onMissing: file.mode === "create" ? "create" as const : "error" as const,
        requireMissing: file.mode === "create", preserveFormatting: file.preserveFormatting };
    });
    return executeFileBatch(files, cwd, input.preview === true, signal, onProgress);
  } catch (error) {
    return failedExecution(error, input.preview === true);
  }
}

export async function applyPatchToFiles(
  input: string, cwd: string, preview = false, signal?: AbortSignal, onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  try {
    const files: MutationInput[] = parsePatch(input).operations.map((operation) => {
      if (operation.kind === "add") return { path: operation.path, rewrite: operation.content, onMissing: "create", requireMissing: true };
      if (operation.kind === "delete") return { path: operation.path, delete: true };
      return { path: operation.path, patch: operation };
    });
    return executeFileBatch(files, cwd, preview, signal, onProgress);
  } catch (error) {
    return failedExecution(error, preview);
  }
}

async function executeFileBatch(
  files: MutationInput[], cwd: string, preview: boolean, signal?: AbortSignal, onProgress?: (summary: string) => void,
): Promise<EditingExecution> {
  try {
    throwIfAborted(signal);
    return await registerMutation(() => registerEditsBatch(files, cwd, signal, preview, onProgress));
  } catch (error) {
    return failedExecution(error, preview, files, cwd);
  }
}

function failedExecution(error: unknown, preview: boolean, files?: MutationInput[], cwd?: string): EditingExecution {
  const message = errorMessage(error);
  const details = error instanceof BatchPublicationError ? error.details
    : { files: Array.isArray(files) && cwd ? files.filter((file) => file && typeof file.path === "string").map((file) => emptyReceipt(file, cwd)) : [],
        modifiedFiles: [], ...(preview ? { preview: true as const } : {}), error: message };
  return { summary: message, details };
}

export async function applyEditsToFile(
  input: ApplyEditsRequest,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (summary: string) => void,
): Promise<ApplyEditsExecution> {
  validateRequest(input);
  throwIfAborted(signal);
  if (input.files) {
    const files = input.files;
    return registerMutation(() => registerEditsBatch(files, cwd, signal, input.preview === true, onProgress));
  }

  const single = input as ApplyEditsInput;
  const inputPath = resolveInputPath(single.path, cwd);
  return withCanonicalFileLock(inputPath, async () => {
    const planned = input.preview
      ? await planFileContents(single, inputPath, cwd, signal, false)
      : await planFileMutation(single, inputPath, cwd, signal);
    return input.preview ? describePlan(planned, true) : commitPlannedMutation(planned, signal);
  });
}

let canonicalLockRegistration = Promise.resolve();

function registerMutation<T>(discover: () => Promise<{ operation: Promise<T> }>): Promise<T> {
  // Resolve and reserve every call's keys in invocation order, without waiting for its writes.
  const registration = canonicalLockRegistration.then(discover);
  canonicalLockRegistration = registration.then(() => undefined, () => undefined);
  return registration.then(({ operation }) => operation);
}

function withCanonicalFileLock<T>(inputPath: string, fn: () => Promise<T>): Promise<T> {
  return registerMutation(async () => {
    const keys = await mutationQueueKeys(inputPath);
    return { operation: withMutationLocks(keys.needsCreateLock, keys.queueKeys, fn, [keys.targetKey]) };
  });
}

interface PlannedMutation {
  inputPath: string;
  displayPath: string;
  snapshot: Awaited<ReturnType<typeof captureSnapshot>>;
  nextBytes: Buffer;
  originalText: string;
  nextText: string;
  matches: AppliedEditDetail[];
  operation: ApplyEditsDetails["operation"];
  editsRequested: number;
  needsWrite: boolean;
  createPlan?: NewFilePlan;
  lockKey?: string;
  entry?: EntrySnapshot;
  movePlan?: EntryMovePlan;
}

async function registerEditsBatch(
  files: MutationInput[],
  cwd: string,
  signal: AbortSignal | undefined,
  preview: boolean,
  onProgress?: (summary: string) => void,
): Promise<{ operation: Promise<EditingExecution> }> {
  if (files.length === 0 || files.length > MAX_BATCH_FILES) {
    throw new Error(`files must contain 1–${MAX_BATCH_FILES} entries`);
  }
  for (const [index, file] of files.entries()) {
    try {
      if (!file.patch && !file.delete) validateInput(file);
    } catch (error) {
      throw new Error(`files[${index}]: ${errorMessage(error)}`);
    }
  }
  const resolved = await Promise.all(files.map(async (file, index) => {
    const inputPath = resolveInputPath(file.path, cwd);
    try {
      const entryOperation = file.delete || file.patch?.moveTo;
      const keys = await (entryOperation ? entryMutationQueueKeys(inputPath) : mutationQueueKeys(inputPath));
      const destination = file.patch?.moveTo
        ? { inputPath: resolveInputPath(file.patch.moveTo, cwd),
            ...await mutationQueueKeys(resolveInputPath(file.patch.moveTo, cwd)), index }
        : undefined;
      return { file, inputPath, ...keys, index, destination };
    } catch (error) {
      const receipts = files.map((input) => emptyReceipt(input, cwd));
      receipts[index]!.status = "failed";
      const reason = isMissingPathError(error)
        ? error.code === "ENOENT" ? `File does not exist: ${displayPathFor(inputPath, cwd)}.`
          : `A parent path is not a directory: ${displayPathFor(inputPath, cwd)}.`
        : errorMessage(error);
      throw batchFailure(`files[${index}]: ${reason} No changes were written.`, {
        files: receipts, modifiedFiles: [], ...(preview ? { preview: true } : {}),
      });
    }
  }));
  const targets = resolved.flatMap((item) => item.destination ? [item, item.destination] : [item]);
  const seen = new Map<string, number>();
  for (const item of targets) {
    const prior = seen.get(item.targetKey);
    if (prior !== undefined) {
      throw new Error(`files[${item.index}] refers to the same file as files[${prior}] ` +
        `(${item.inputPath}). Combine edits for one path into a single entry.`);
    }
    seen.set(item.targetKey, item.index);
  }
  rejectAncestorPathConflicts(targets);
  const lockPaths = [...new Set(targets.flatMap((item) => item.queueKeys))].sort();
  return { operation: withMutationLocks(targets.some((item) => item.needsCreateLock), lockPaths, async () => {
    const receipt: ApplyEditsBatchDetails = {
      modifiedFiles: [], files: files.map((file) => emptyReceipt(file, cwd)),
      ...(preview ? { preview: true } : {}),
    };
    const planned: PlannedMutation[] = [];
    for (const item of resolved) {
      try {
        const plan = preview
          ? await planFileContents(item.file, item.inputPath, cwd, signal, false)
          : await planFileMutation(item.file, item.inputPath, cwd, signal);
        plan.lockKey = item.destination?.targetKey ?? item.targetKey;
        planned.push(plan);
        receipt.files[item.index] = receiptForPlan(plan, preview);
        onProgress?.(`${preview ? "Previewed" : "Planned"} ${planned.length}/${files.length}: ${plan.displayPath}. ` +
          (preview ? "No files written." : "No targets published."));
      } catch (error) {
        receipt.files[item.index]!.status = "failed";
        throw batchFailure(`files[${item.index}]: ${errorMessage(error)}`, receipt);
      }
    }
    // A canceled `..` directory can be staged within its own create root, but must
    // not claim another group's root or a requested file name before that operation.
    for (const [index, plan] of planned.entries()) {
      for (const path of plan.createPlan?.traversalDirectories ?? []) {
        const directory = normalizeLockKey(path);
        const ownRoot = nestedCreateRootKey(plan);
        const conflict = targets.some((target) => directory === target.targetKey || directory.startsWith(`${target.targetKey}${sep}`)) ||
          planned.some((other) => {
            const root = nestedCreateRootKey(other);
            return root && root !== ownRoot && (root === directory || root.startsWith(`${directory}${sep}`) || directory.startsWith(`${root}${sep}`));
          });
        if (conflict) {
          receipt.files[index]!.status = "failed";
          throw batchFailure(`files[${index}] requires a traversal directory (${path}) that overlaps another file or staged create root. ` +
            "Split these operations into separate calls. No changes were written.", receipt);
        }
      }
    }
    if (preview) return describeBatch(receipt.files, true, [], cwd);

    const nestedGroups = new Map<string, number[]>();
    for (const [index, plan] of planned.entries()) {
      const key = nestedCreateRootKey(plan);
      if (!key) continue;
      const group = nestedGroups.get(key) ?? [];
      group.push(index);
      nestedGroups.set(key, group);
    }
    for (const group of nestedGroups.values()) {
      const spellings = new Set(group.map((index) => planned[index]!.createPlan!.missingDirectories[0]));
      if (spellings.size > 1) {
        throw batchFailure(`files[${group.join(", ")}] use alias spellings for one missing directory. ` +
          "Use one consistent path spelling so the batch can publish it safely.", receipt);
      }
    }
    const preparedGroups = new Map<string, PreparedNestedFiles>();
    const completed = new Set<number>();
    let failure: BatchPublicationError | undefined;
    try {
      // Prepare every shared missing subtree before exposing any target.
      for (const [key, group] of nestedGroups) {
        try {
          preparedGroups.set(key, await preparePlannedNestedFiles(group.map((index) => ({
            plan: planned[index]!.createPlan!, bytes: planned[index]!.nextBytes,
            ...(planned[index]!.movePlan ? { move: { entry: planned[index]!.entry!, snapshot: planned[index]!.snapshot } } : {}),
          })), signal));
        } catch (error) {
          for (const index of group) receipt.files[index]!.status = "failed";
          throw batchFailure(`files[${group.join(", ")}] could not be prepared. ${errorMessage(error)}`, receipt);
        }
      }
      for (const [index, plan] of planned.entries()) {
        if (completed.has(index)) continue;
        const key = nestedCreateRootKey(plan);
        const group = key ? nestedGroups.get(key)! : [index];
        const names = group.map((item) => planned[item]!.displayPath).join(", ");
        try {
          onProgress?.(`Publishing ${names} (${completed.size}/${planned.length} files complete).`);
          if (key) {
            receipt.files[group[0]!]!.warnings.push(...await publishPreparedNestedFiles(preparedGroups.get(key)!, signal));
          } else {
            const result = await commitPlannedMutation(plan, signal);
            receipt.files[index]!.warnings.push(...result.details.warnings);
          }
          for (const item of group) {
            completed.add(item);
            const file = receipt.files[item]!;
            file.status = planned[item]!.needsWrite ? "applied" : "unchanged";
            file.editsApplied = planned[item]!.needsWrite ? file.editsRequested : 0;
            if (planned[item]!.needsWrite) receipt.modifiedFiles.push(...committedPaths(planned[item]!));
          }
          onProgress?.(`Completed ${completed.size}/${planned.length}: ${names}.`);
        } catch (error) {
          if (error instanceof PublicationError) {
            receipt.modifiedFiles.push(...error.modifiedFiles);
          }
          const verified = new Set(receipt.modifiedFiles);
          const uncertain = new Set(error instanceof PublicationError ? error.uncertainFiles : []);
          for (const item of group) {
            if (completed.has(item)) continue;
            const paths = committedPaths(planned[item]!);
            const file = receipt.files[item]!;
            file.status = paths.some((path) => uncertain.has(path)) ? "uncertain"
              : paths.every((path) => verified.has(path)) ? "applied" : "failed";
            if (file.status === "applied") {
              file.editsApplied = file.editsRequested;
              completed.add(item);
            }
          }
          const failed = group.filter((item) => !completed.has(item));
          const paths = (indices: number[]) => indices.length
            ? indices.map((item) => planned[item]!.displayPath).join(", ") : "none";
          const verifiedPaths = [...new Set(receipt.modifiedFiles)];
          const earlierWarnings = [...new Set([...completed].flatMap((item) => receipt.files[item]!.warnings))];
          throw batchFailure(
            `Multi-file batch failed while publishing files[${index}] (${plan.displayPath}) ` +
            `after ${verifiedPaths.length} verified path change${verifiedPaths.length === 1 ? "" : "s"}. ${errorMessage(error)}\n` +
            `Verified committed paths: ${verifiedPaths.join(", ") || "none"}\n` +
            `Uncertain paths: ${[...uncertain].join(", ") || "none"}\n` +
            `Completed: ${paths([...completed].sort((a, b) => a - b))}\n` +
            `Failed or uncertain: ${paths(failed)}\n` +
            `Unattempted: ${paths(planned.flatMap((_, item) => completed.has(item) || failed.includes(item) ? [] : [item]))}\n` +
            "Inspect failed/uncertain paths and any retained recovery files before retrying; do not replay the whole batch." +
            (earlierWarnings.length ? ` Earlier warnings from completed files: ${earlierWarnings.join(" ")}` : ""), receipt);
        }
      }
    } catch (error) {
      failure = error instanceof BatchPublicationError ? error : batchFailure(errorMessage(error), receipt);
    } finally {
      const cleanupFailures: string[] = [];
      for (const prepared of preparedGroups.values()) {
        try { await discardPreparedNestedFiles(prepared); }
        catch (error) { cleanupFailures.push(errorMessage(error)); }
      }
      if (cleanupFailures.length) {
        failure = batchFailure(`${failure ? `${failure.message} ` : ""}Staged create cleanup was incomplete: ${cleanupFailures.join("; ")}`, receipt);
      }
    }
    if (failure) throw failure;
    return describeBatch(receipt.files, false, receipt.modifiedFiles, cwd);
  }, targets.map((item) => item.targetKey)) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function batchFailure(message: string, details: ApplyEditsBatchDetails): BatchPublicationError {
  details.modifiedFiles = [...new Set(details.modifiedFiles)];
  details.error = message;
  return new BatchPublicationError(message, details);
}

function emptyReceipt(input: MutationInput, cwd: string): FileReceipt {
  const operation = input.delete ? "delete" : input.patch?.moveTo ? "move" : input.patch ? "patch"
    : input.edits ? "edit" : input.requireMissing ? "create" : "rewrite";
  return { ...buildDetails(resolveInputPath(input.path, cwd), operation, 0, 0, [], "", "", []),
    status: "unattempted", ...(input.patch?.moveTo ? { moveTo: resolveInputPath(input.patch.moveTo, cwd) } : {}) };
}

function receiptForPlan(plan: PlannedMutation, preview: boolean): FileReceipt {
  const details = describePlan(plan, preview).details;
  if (plan.entry && !plan.snapshot) {
    details.bytesBefore = Number(plan.entry.stats.size);
    details.bytesAfter = plan.movePlan ? details.bytesBefore : 0;
    details.addedLines = undefined;
    details.deletedLines = undefined;
  }
  return { ...details, path: plan.inputPath, editsApplied: 0,
    status: plan.needsWrite ? "unattempted" : "unchanged",
    ...(plan.movePlan ? { moveTo: plan.movePlan.destination.inputPath } : {}),
  };
}

function committedPaths(plan: PlannedMutation): string[] {
  if (plan.movePlan) return [plan.movePlan.entry.actualPath, plan.movePlan.destination.targetPath];
  return [plan.entry?.actualPath ?? plan.snapshot?.actualPath ?? plan.createPlan?.targetPath ?? plan.inputPath];
}

function describeBatch(
  files: FileReceipt[], preview = false, modifiedFiles: string[] = [], cwd?: string,
): EditingExecution {
  const displayFiles = cwd ? files.map((file) => ({ ...file, path: displayPathFor(file.path, cwd),
    moveTo: file.moveTo ? displayPathFor(file.moveTo, cwd) : undefined })) : files;
  const changed = displayFiles.filter((item) => item.operation !== "no_change");
  const details: ApplyEditsBatchDetails = { files, modifiedFiles: [...new Set(modifiedFiles)], ...(preview ? { preview: true } : {}) };
  if (changed.length === 0) {
    return {
      summary: `No change: ${files.length} file${files.length === 1 ? "" : "s"} already match.${preview ? " No files written (preview)." : ""}`,
      details,
    };
  }
  const countsKnown = changed.every((item) => item.addedLines !== undefined && item.deletedLines !== undefined);
  const added = changed.reduce((sum, item) => sum + (item.addedLines ?? 0), 0);
  const deleted = changed.reduce((sum, item) => sum + (item.deletedLines ?? 0), 0);
  const counts = countsKnown && added + deleted > 0 ? ` (+${added}/-${deleted})` : "";
  const verbs = { create: "create", delete: "delete", move: "move", rewrite: "rewrite", edit: "update", patch: "update", no_change: "update" } as const;
  const operation = changed.every((file) => file.operation === changed[0]!.operation) ? changed[0]!.operation : undefined;
  const verb = operation ? verbs[operation] : "update";
  const applied = { create: "Created", delete: "Deleted", move: "Moved", rewrite: "Rewrote", update: "Updated" };
  const names = changed.slice(0, 8).map((item) => `${operation ? "" : `${verbs[item.operation]} `}${item.moveTo ? `${item.path} → ${item.moveTo}` : item.path}`).join(", ") +
    (changed.length > 8 ? `, … ${changed.length - 8} more` : "");
  const warnings = [...new Set(files.flatMap((item) => item.warnings))];
  const warningText = warnings.length > 0
    ? ` Warning: ${warnings.slice(0, 4).join(" ")}${warnings.length > 4 ? ` … ${warnings.length - 4} more` : ""}`
    : "";
  const omitted = files.filter((item) => item.diffTruncated).length;
  const diffNote = omitted ? ` ${omitted} diff${omitted === 1 ? "" : "s"} omitted (diff budget).` : "";
  return {
    summary: `${preview ? `Would ${verb}` : applied[verb]} ${changed.length} file${changed.length === 1 ? "" : "s"}${counts}: ${names}${correctionSummary(displayFiles)}.` +
      `${preview ? " No files written." : ""}${diffNote}${warningText}`,
    details,
  };
}

function nestedCreateRootKey(plan: PlannedMutation): string | undefined {
  if (!plan.lockKey || !plan.createPlan || plan.createPlan.missingDirectories.length === 0) {
    return undefined;
  }
  let key = plan.lockKey;
  for (let index = 0; index < plan.createPlan.missingDirectories.length; index++) {
    key = dirname(key);
  }
  return key;
}

function rejectAncestorPathConflicts(
  resolved: Array<{ targetKey: string; inputPath: string; index: number }>,
): void {
  // Batch sizes are small; pairwise checking avoids collation-order assumptions (`a`, `a-`, `a/x`).
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const left = resolved[i]!;
      const right = resolved[j]!;
      const leftPrefix = left.targetKey.endsWith(sep) ? left.targetKey : `${left.targetKey}${sep}`;
      const rightPrefix = right.targetKey.endsWith(sep) ? right.targetKey : `${right.targetKey}${sep}`;
      const ancestor = right.targetKey.startsWith(leftPrefix)
        ? left
        : left.targetKey.startsWith(rightPrefix)
          ? right
          : undefined;
      if (!ancestor) continue;
      const descendant = ancestor === left ? right : left;
      throw new Error(
        `files[${descendant.index}] (${descendant.inputPath}) is nested under files[${ancestor.index}] ` +
          `(${ancestor.inputPath}). A batch cannot target a path and one of its ancestors.`,
      );
    }
  }
}

// Pi acquires one key at a time. Reserve a batch's entire key set before acquiring any Pi lock,
// so a later call cannot overtake it at a second key. Unrelated files remain parallel.
// Missing discoveries also share a path-independent key that survives ancestor publication.
const createMutationKey = Symbol("create");
const pendingMutations = new Map<string | symbol, Promise<void>>();

function withMutationLocks<T>(
  needsCreateLock: boolean, pi: string[], fn: () => Promise<T>, entries: string[] = [],
): Promise<T> {
  const keys: Array<string | symbol> = [...new Set([...pi, ...entries])];
  if (needsCreateLock) keys.push(createMutationKey);
  const previous = keys.flatMap((key) => pendingMutations.get(key) ?? []);
  const operation = Promise.all(previous).then(() => withOrderedFileLocks(pi, fn));
  const settled = operation.then(() => undefined, () => undefined);
  for (const key of keys) pendingMutations.set(key, settled);
  void settled.then(() => {
    for (const key of keys) {
      if (pendingMutations.get(key) === settled) pendingMutations.delete(key);
    }
  });
  return operation;
}

async function withOrderedFileLocks<T>(unordered: string[], fn: () => Promise<T>): Promise<T> {
  // One global order, so separate operations cannot deadlock against each other. Callers must
  // still pass keys that cannot canonicalize together, since Pi resolves each on acquisition
  // and this dedupe only compares the strings it is given.
  const paths = [...new Set(unordered)].sort();
  const run = async (index: number): Promise<T> => {
    if (index >= paths.length) return fn();
    return withFileMutationQueue(paths[index]!, () => run(index + 1));
  };
  return run(0);
}

// Read-only: publication checks stay separate because Android support probes create files.
async function planFileContents(
  input: MutationInput,
  inputPath: string,
  cwd: string,
  signal?: AbortSignal,
  requireWritable = true,
): Promise<PlannedMutation> {
  throwIfAborted(signal);
  const displayPath = displayPathFor(inputPath, cwd);
  assertPlannedPathBudget(displayPath, [inputPath]);
  if (input.delete || input.patch?.moveTo) {
    const entry = await captureEntrySnapshot(inputPath, requireWritable);
    if (!entry) throw new Error(`File does not exist: ${displayPath}. No changes were written.`);
    if (input.patch?.chunks.length && entry.symbolicLink) {
      throw new Error(`Cannot edit link-target content while moving the link entry ${displayPath}. Use separate calls.`);
    }
    const movePlan = input.patch?.moveTo
      ? await planEntryMove(entry, resolveInputPath(input.patch.moveTo, cwd), signal, !requireWritable)
      : undefined;
    const snapshot = input.patch?.chunks.length ? await captureSnapshot(inputPath, requireWritable) : undefined;
    const originalText = snapshot ? decodeText(snapshot.bytes, displayPath).text : "";
    const update = snapshot && input.patch ? applyPatchUpdate(originalText, input.patch) : undefined;
    const nextText = update?.text ?? "";
    return {
      inputPath, displayPath, snapshot, entry, movePlan, createPlan: movePlan?.destination,
      nextBytes: Buffer.from(nextText, "utf8"), originalText, nextText,
      matches: update?.matches.map((match, index) => ({ index, strategy: match.strategy, replacements: 1, lines: [match.line] })) ?? [],
      operation: movePlan ? "move" : "delete", editsRequested: input.patch?.chunks.length || 1, needsWrite: true,
    };
  }
  const snapshot = await captureSnapshot(inputPath, requireWritable);

  if (snapshot && input.requireMissing) {
    throw new Error(
      `File now exists: ${displayPath}. Create mode refuses to overwrite an existing target. ` +
        "No changes were written.",
    );
  }
  if (!snapshot && (input.edits || input.patch)) {
    throw new Error(
      `Cannot edit missing file ${displayPath}. Use write_files with mode: "create" to create it.`,
    );
  }
  if (!snapshot && input.onMissing !== "create") {
    const message =
      `File does not exist: ${displayPath}. Use write_files with mode: "create" to create it. ` +
      "No changes were written.";
    throw new Error(message);
  }

  let originalText = "";
  let originalBody = "";
  let hadBom = false;
  if (snapshot) {
    const decoded = decodeText(snapshot.bytes, displayPath);
    originalText = decoded.text;
    originalBody = decoded.body;
    hadBom = decoded.hadBom;
  }

  let nextText: string;
  let matches: AppliedEditDetail[] = [];
  let operation: ApplyEditsDetails["operation"];

  if (input.patch) {
    const result = applyPatchUpdate(originalText, input.patch);
    nextText = result.text;
    matches = result.matches.map((match, index) => ({
      index, strategy: match.strategy, replacements: 1, lines: [match.line],
    }));
    operation = "patch";
  } else if (input.edits) {
    const result = applyTargetedEdits(originalBody, input.edits, displayPath);
    if (countLeadingBomCharacters(result.text) > countLeadingBomCharacters(originalBody)) {
      throw new Error(
        `Targeted edits would move or add U+FEFF to the start of ${displayPath}. ` +
          "Use write_files with preserveFormatting: false for an exact encoding change. No changes were written.",
      );
    }
    nextText = `${hadBom ? "\uFEFF" : ""}${result.text}`;
    matches = result.matches;
    operation = "edit";
  } else {
    const rewrite = input.rewrite ?? "";
    const preserve = snapshot && input.preserveFormatting !== false;
    const body = preserve ? convertLineEndings(rewrite, detectLineEnding(originalBody)) : rewrite;
    nextText = `${preserve && hadBom && !body.startsWith("\uFEFF") ? "\uFEFF" : ""}${body}`;
    operation = snapshot ? "rewrite" : "create";
  }

  const createPlan = snapshot ? undefined : await planNewFile(inputPath, requireWritable);
  if (createPlan && await lstat(createPlan.targetPath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  })) {
    throw new Error(`Create mode refuses to overwrite an existing target: ${displayPath}. No changes were written.`);
  }
  const nextBytes = Buffer.from(nextText, "utf8");
  const needsWrite = !(snapshot && nextBytes.equals(snapshot.bytes));
  throwIfAborted(signal);
  return {
    inputPath,
    displayPath,
    snapshot,
    createPlan,
    nextBytes,
    originalText,
    nextText,
    matches,
    operation: needsWrite ? operation : "no_change",
    editsRequested: input.patch?.chunks.length ?? input.edits?.length ?? 1,
    needsWrite,
  };
}

async function planFileMutation(
  input: MutationInput,
  inputPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<PlannedMutation> {
  const plan = await planFileContents(input, inputPath, cwd, signal);
  // Fail closed before any batch publication, without running these probes during previews.
  if (plan.entry) {
    if (plan.snapshot) await assertSafeToReplace(plan.snapshot, signal);
  } else if (plan.needsWrite) {
    if (plan.snapshot) {
      assertReplacementPathBudget(plan.snapshot.actualPath, plan.displayPath);
      await assertSafeToReplace(plan.snapshot, signal);
    } else {
      assertCreatePathBudget(plan.createPlan!, plan.displayPath);
    }
  }
  return plan;
}

function correctionSummary(files: ApplyEditsDetails[]): string {
  const notes = files.flatMap((file) => file.matches
    .filter((match) => match.strategy !== "exact")
    .map((match) => `${files.length > 1 ? `${file.path}: ` : ""}${file.operation === "patch" || file.operation === "move" ? "matches" : "edits"}[${match.index}] used ${match.strategy} matching ` +
      `(start line${match.lines.length === 1 ? "" : "s"} ${match.lines.slice(0, 8).join(", ")}${match.lines.length > 8 || match.linesTruncated ? ", …" : ""})`));
  return notes.length === 0 ? "" : `; ${notes.slice(0, 4).join("; ")}` +
    (notes.length > 4 ? `; ${notes.length - 4} more corrected edits in details` : "");
}

function describePlan(plan: PlannedMutation, preview = false): ApplyEditsExecution & { details: ApplyEditsDetails } {
  const details = buildDetails(
    plan.displayPath,
    plan.operation,
    plan.editsRequested,
    preview || !plan.needsWrite ? 0 : plan.editsRequested,
    plan.matches,
    plan.originalText,
    plan.nextText,
    [],
  );
  if (preview) details.preview = true;
  if (!plan.needsWrite) {
    return {
      summary: `No change: ${plan.displayPath} already matches the requested content.${preview ? " No files written (preview)." : ""}`,
      details,
    };
  }
  const counts = (details.addedLines ?? 0) + (details.deletedLines ?? 0) > 0
    ? ` (+${details.addedLines ?? 0}/-${details.deletedLines ?? 0})`
    : "";
  const verb = plan.operation === "create"
    ? preview ? "Would create" : "Created"
    : plan.operation === "rewrite"
      ? preview ? "Would rewrite" : "Rewrote"
      : preview ? "Would edit" : "Edited";
  const unit = plan.operation === "edit"
    ? `${plan.editsRequested} ordered edit${plan.editsRequested === 1 ? "" : "s"}`
    : "full content";
  return {
    summary: `${verb} ${plan.displayPath}: ${unit}${counts}${correctionSummary([details])}.` +
      `${preview ? " No files written." : ""}${details.diffTruncated ? " Diff omitted (diff budget)." : ""}`,
    details,
  };
}

async function commitPlannedMutation(
  plan: PlannedMutation,
  signal?: AbortSignal,
): Promise<ApplyEditsExecution & { details: ApplyEditsDetails }> {
  throwIfAborted(signal);
  const result = describePlan(plan);
  if (!plan.needsWrite) {
    if (plan.snapshot) await assertSnapshotCurrent(plan.snapshot);
    return result;
  }
  throwIfAborted(signal);
  const warnings = plan.movePlan
    ? await publishEntryMove(plan.movePlan, plan.snapshot ? { snapshot: plan.snapshot, bytes: plan.nextBytes } : undefined, signal)
    : plan.entry ? await publishEntryDelete(plan.entry, signal)
    : plan.snapshot ? await publishReplacement(plan.snapshot, plan.nextBytes, signal)
    : await publishNewFile(plan.inputPath, plan.nextBytes, signal, plan.createPlan);
  result.details.warnings.push(...warnings);
  if (warnings.length > 0) result.summary += ` Warning: ${warnings.join(" ")}`;
  return result;
}

function validateRequest(input: ApplyEditsRequest): void {
  if (!input || typeof input !== "object") throw new Error("File mutation input must be an object");
  if (input.preview !== undefined && typeof input.preview !== "boolean") {
    throw new Error("preview must be a boolean");
  }
  const hasFiles = Array.isArray(input.files);
  const hasTopLevel =
    input.path !== undefined ||
    input.edits !== undefined ||
    input.rewrite !== undefined ||
    input.onMissing !== undefined ||
    input.requireMissing !== undefined ||
    input.preserveFormatting !== undefined;
  if (hasFiles === hasTopLevel) {
    throw new Error('Provide either files: [...] or a single-file path with edits/rewrite');
  }
  if (hasFiles) {
    if (!input.files || input.files.length === 0) throw new Error("files must contain at least one entry");
    if (input.files.length > MAX_BATCH_FILES) {
      throw new Error(`files cannot contain more than ${MAX_BATCH_FILES} entries`);
    }
    return;
  }
  validateInput(input as ApplyEditsInput);
}

function validateInput(input: ApplyEditsInput): void {
  if (!input || typeof input !== "object") throw new Error("File mutation input must be an object");
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (input.path.includes("\0")) throw new Error("path cannot contain NUL bytes");
  if (!input.path.isWellFormed()) throw new Error("path must contain valid Unicode text");
  const hasEdits = Array.isArray(input.edits);
  const hasRewrite = typeof input.rewrite === "string";
  if (hasEdits === hasRewrite) {
    throw new Error("Provide exactly one of edits or rewrite");
  }
  if (hasEdits && input.edits?.length === 0) throw new Error("edits must contain at least one replacement");
  if (hasEdits && input.edits && input.edits.length > MAX_EDITS_PER_FILE) {
    throw new Error(`edits cannot contain more than ${MAX_EDITS_PER_FILE} entries`);
  }
  if (hasRewrite && input.rewrite?.includes("\0")) throw new Error("rewrite cannot contain NUL bytes");
  if (hasRewrite && input.rewrite && !input.rewrite.isWellFormed()) {
    throw new Error("rewrite must contain valid Unicode text");
  }
  if (hasEdits && input.onMissing !== undefined) {
    throw new Error("onMissing is valid only with rewrite");
  }
  if (hasEdits && input.requireMissing !== undefined) {
    throw new Error("requireMissing is valid only with rewrite");
  }
  if (hasEdits && input.preserveFormatting !== undefined) {
    throw new Error("preserveFormatting is valid only with rewrite");
  }
  if (input.preserveFormatting !== undefined && typeof input.preserveFormatting !== "boolean") {
    throw new Error("preserveFormatting must be a boolean");
  }
  if (input.requireMissing !== undefined && typeof input.requireMissing !== "boolean") {
    throw new Error("requireMissing must be a boolean");
  }
  if (input.onMissing !== undefined && input.onMissing !== "error" && input.onMissing !== "create") {
    throw new Error('onMissing must be either "error" or "create"');
  }
  if (input.requireMissing === true && input.onMissing !== "create") {
    throw new Error('requireMissing requires onMissing: "create"');
  }
}

function findMatch(
  content: string,
  oldText: string,
  newText: string,
  insert: InsertPosition | undefined,
  applyAll: boolean,
  maxResultLength: number,
  field: "oldText" | "endText" = "oldText",
): MatchResult | undefined {
  const maximumReplacementLength = convertLineEndings(newText, "\r\n").length;
  const findExact = (search: string) => {
    const removedPerMatch = insert ? 0 : search.length;
    const expansionPerMatch = maximumReplacementLength - removedPerMatch;
    const maximumExpansionMatches = applyAll && expansionPerMatch > 0
      ? Math.floor((maxResultLength - content.length) / expansionPerMatch)
      : Number.POSITIVE_INFINITY;
    // Stop scanning before even the offsets array can consume the heap for a doomed expansion.
    const exactLimit = Math.min(MAX_REPLACEMENTS + 1, maximumExpansionMatches + 1);
    return {
      search,
      removedPerMatch,
      maximumExpansionMatches,
      offsets: findOccurrences(content, search, exactLimit),
    };
  };
  let exactResult = findExact(oldText);
  if (exactResult.offsets.length === 0) {
    const ending = uniformLineEnding(content);
    const converted = ending ? convertLineEndings(oldText, ending) : oldText;
    if (converted !== oldText) exactResult = findExact(converted);
  }
  const {
    search: matchedOldText,
    removedPerMatch,
    maximumExpansionMatches,
    offsets: exactOffsets,
  } = exactResult;
  if (exactOffsets.length > maximumExpansionMatches) throwExpansionError();
  if (exactOffsets.length > MAX_REPLACEMENTS) {
    throw new Error(
      `${field} matched more than ${MAX_REPLACEMENTS.toLocaleString()} locations. ` +
        `Add surrounding context instead. No changes were written.`,
    );
  }
  const exactCount = applyAll ? exactOffsets.length : Math.min(exactOffsets.length, 1);
  assertProjectedExpansion(
    content.length,
    exactCount,
    removedPerMatch,
    maximumReplacementLength,
    maxResultLength,
  );
  const exactLines = lineNumbersAt(content, exactOffsets);
  const exactEndings = lineEndingsAt(content, exactOffsets);
  const replacementsByEnding = new Map<LineEnding, string>();
  const exact = exactOffsets.map((start, index) => {
    const end = start + matchedOldText.length;
    const replacement = convertedReplacement(
      newText,
      exactEndings[index] ?? "\n",
      replacementsByEnding,
    );
    return toReplacement(start, end, replacement, exactLines[index] ?? 1, insert);
  });
  if (exact.length > 0) return { strategy: "exact", replacements: exact };

  const normalized = findLineBlockMatches(
    content, oldText, newText, false, insert, applyAll, maxResultLength, field,
  );
  if (normalized.length > 0) return { strategy: "normalized", replacements: normalized };

  const indentation = findLineBlockMatches(
    content, oldText, newText, true, insert, applyAll, maxResultLength, field,
  );
  if (indentation.length > 0) return { strategy: "indent-normalized", replacements: indentation };

  return undefined;
}

function findRangeMatch(
  content: string,
  oldText: string,
  endText: string,
  newText: string,
  displayPath: string,
  editIndex: number,
): MatchResult | undefined {
  // Match anchors without charging the replacement against only the start span;
  // applyReplacements enforces the expansion budget against the full range.
  const startMatch = findMatch(
    content,
    oldText,
    newText,
    undefined,
    false,
    Number.MAX_SAFE_INTEGER,
  );
  if (!startMatch) return undefined;
  if (startMatch.replacements.length > 1) {
    const lines = startMatch.replacements.slice(0, 8).map((item) => item.line);
    const suffix = startMatch.replacements.length > lines.length ? ", …" : "";
    throw new Error(
      `edits[${editIndex}].oldText matched ${startMatch.replacements.length} locations in ${displayPath} ` +
        `(lines ${lines.join(", ")}${suffix}). Add enough surrounding text to make the range start unique. ` +
        "endText ranges do not support all: true. No changes were written.",
    );
  }

  const endMatch = findMatch(
    content,
    endText,
    "",
    undefined,
    false,
    Number.MAX_SAFE_INTEGER,
    "endText",
  );
  if (!endMatch) {
    throw new Error(missingEditMessage(content, endText, "", displayPath, editIndex, "endText"));
  }
  if (endMatch.replacements.length > 1) {
    const lines = endMatch.replacements.slice(0, 8).map((item) => item.line);
    const suffix = endMatch.replacements.length > lines.length ? ", …" : "";
    throw new Error(
      `edits[${editIndex}].endText matched ${endMatch.replacements.length} locations in ${displayPath} ` +
        `(lines ${lines.join(", ")}${suffix}). Add enough surrounding text to make the range end unique. ` +
        "No changes were written.",
    );
  }

  const start = startMatch.replacements[0]!;
  const end = endMatch.replacements[0]!;
  if (end.matchStart < start.matchEnd) {
    throw new Error(
      `edits[${editIndex}].endText must match after oldText in ${displayPath} ` +
        `(oldText line ${start.line}, endText line ${end.line}). No changes were written.`,
    );
  }

  const strategy: MatchStrategy =
    startMatch.strategy === "indent-normalized" || endMatch.strategy === "indent-normalized"
      ? "indent-normalized"
      : startMatch.strategy === "normalized" || endMatch.strategy === "normalized"
        ? "normalized"
        : "exact";
  return {
    strategy,
    replacements: [toReplacement(start.matchStart, end.matchEnd, start.text, start.line)],
  };
}

function toReplacement(
  start: number,
  end: number,
  text: string,
  line: number,
  insert?: InsertPosition,
): Replacement {
  if (insert === "before") return { start, end: start, matchStart: start, matchEnd: end, text, line };
  if (insert === "after") return { start: end, end, matchStart: start, matchEnd: end, text, line };
  return { start, end, matchStart: start, matchEnd: end, text, line };
}

async function entryMutationQueueKeys(filePath: string): Promise<{ targetKey: string; queueKeys: string[]; needsCreateLock: boolean }> {
  await lstat(filePath); // Validate the original traversal, including trailing separators.
  const parent = await nativeRealpath(dirname(filePath));
  const entryPath = join(parent, basename(filePath));
  const entry = await lstat(entryPath);
  const key = await realpath(entryPath).catch((error: unknown) => {
    // ponytail: Pi resolves queue paths, so unresolvable links share their parent
    // queue. Use entry-key native queues if Pi adds them. The local entry key
    // stays reserved after deletion so following creates cannot overtake cleanup.
    if (entry.isSymbolicLink()) return parent;
    if (isMissingPathError(error)) return entryPath;
    throw error;
  });
  return { targetKey: normalizeLockKey(entryPath), queueKeys: [key], needsCreateLock: false };
}

async function mutationQueueKeys(
  filePath: string,
): Promise<{ targetKey: string; queueKeys: string[]; needsCreateLock: boolean }> {
  const resolvedPath = operationPath(filePath);
  try {
    const key = await realpath(resolvedPath);
    return contentQueueKeys(key, false);
  } catch (error) {
    if (!isMissingPathError(error)) {
      // Reserve a final link even when its target cannot resolve, so a later
      // create can wait for an earlier entry deletion instead of failing early.
      if ((await lstat(resolvedPath)).isSymbolicLink()) return entryMutationQueueKeys(resolvedPath);
      throw error;
    }
  }

  // A dangling symbolic link is not a missing path for mutation purposes. More importantly,
  // a batch cannot safely queue both it and its missing target: if the target appears while
  // Pi acquires its one-key locks, realpath makes the two keys collapse and the nested second
  // acquisition waits on the batch's own first lock. Reject before acquiring any lock. There
  // remains an inherent race if an external process creates both the link and its target after
  // this lstat; closing that requires an atomic multi-key queue API from Pi.
  await assertNotDanglingSymbolicLink(resolvedPath);

  // Pass canonical prospective targets even on official Pi, whose public queue still
  // normalizes its input lexically. One key per target avoids nested alias acquisition.
  const key = await prospectiveTarget(resolvedPath);
  return contentQueueKeys(key, true);
}

async function contentQueueKeys(key: string, needsCreateLock: boolean) {
  key = sharedQueueKey ? await sharedQueueKey(key) : key;
  return { targetKey: normalizeLockKey(key), queueKeys: [key], needsCreateLock };
}

function isMissingPathError(error: unknown): error is { code: "ENOENT" | "ENOTDIR" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeLockKey(path: string): string {
  const fullPath = join(path);
  // Prefer over-dedupe on default macOS/Windows volumes over deterministic partial batch writes.
  // Fold the entire logical target, not only its missing suffix: an ancestor can move from
  // missing to existing between two batch discoveries, and realpath then supplies its on-disk
  // capitalization. Existing and missing observations must still dedupe as one target.
  if (process.platform !== "darwin" && process.platform !== "win32") return fullPath;
  return fullPath.split(sep).map(normalizeLockComponent).join(sep);
}

// Only called for darwin/win32; normalizeLockKey returns other platforms' paths untouched.
function normalizeLockComponent(part: string): string {
  // NFC handles normalization-insensitive aliases. Per-code-point upper→lower covers the full
  // case-fold equivalences APFS uses for long-s, ligatures, final sigma, and sharp-S. Preserve
  // dotless U+0131: it is the one character this transform would over-collapse onto ASCII `i`,
  // and APFS keeps those names distinct. Capital U+1E9E is the inverse edge: JavaScript lowers
  // it to ß while Unicode case folding maps both sharp-S forms to `ss`.
  return [...part.normalize("NFC")]
    .map((character) => {
      if (character === "ı") return character;
      if (character === "ẞ") return "ss";
      return character.toUpperCase().toLowerCase();
    })
    .join("")
    .normalize("NFC");
}

function findOccurrences(content: string, search: string, limit = Number.POSITIVE_INFINITY): number[] {
  const offsets: number[] = [];
  if (search.length === 0) return offsets;
  let from = 0;
  while (from <= content.length - search.length && offsets.length < limit) {
    const index = content.indexOf(search, from);
    if (index < 0) break;
    offsets.push(index);
    // Advance by 1 so overlapping exact matches (e.g. "ana" in "banana") are visible
    // to uniqueness / overlap checks. Non-overlapping all:true still applies cleanly.
    from = index + 1;
  }
  return offsets;
}

function findLineBlockMatches(
  content: string,
  search: string,
  replacement: string,
  ignoreBaseIndent: boolean,
  insert: InsertPosition | undefined,
  applyAll: boolean,
  maxResultLength: number,
  field: "oldText" | "endText",
): Replacement[] {
  if (Buffer.byteLength(search) > FUZZY_SEARCH_LIMIT_BYTES) return [];
  const searchLines = splitLines(search);
  if (searchLines.length === 0 || searchLines.length > FUZZY_SEARCH_LIMIT_LINES) return [];
  if (
    content.length > FUZZY_CONTENT_LIMIT_CHARS ||
    countTextLines(content) > FUZZY_CONTENT_LIMIT_LINES ||
    content.length * searchLines.length > FUZZY_WORK_BUDGET
  ) {
    return [];
  }
  const contentLines = splitLines(content);
  if (contentLines.length < searchLines.length) return [];
  const replacementsByEnding = new Map<LineEnding, string>();

  const searchBodies = searchLines.map((line) => line.body);
  const searchSignature = ignoreBaseIndent
    ? indentationSignature(searchBodies)
    : searchBodies.map(normalizeLine);
  const normalizedContent = ignoreBaseIndent
    ? undefined
    : contentLines.map((line) => normalizeLine(line.body));
  const includeFinalEnding = hasFinalLineEnding(search);
  const matches: Replacement[] = [];
  let projectedLength = content.length;

  for (let start = 0; start <= contentLines.length - searchLines.length; start++) {
    const window = contentLines.slice(start, start + searchLines.length);
    if (includeFinalEnding && window.at(-1)?.ending === "") continue;
    const bodies = window.map((line) => line.body);
    const candidateMatches = normalizedContent
      ? stringsMatchAt(normalizedContent, searchSignature, start)
      : sameStrings(searchSignature, indentationSignature(bodies));
    if (!candidateMatches) continue;

    const first = window[0];
    const last = window.at(-1);
    if (!first || !last) continue;
    const matchStart = first.start;
    const matchEnd = includeFinalEnding ? last.end : last.bodyEnd;
    const ending = (window.find((line) => line.ending !== "")?.ending || detectLineEnding(content)) as LineEnding;
    const localReplacement = convertedReplacement(replacement, ending, replacementsByEnding);
    // Insert keeps caller indentation; only full indent-normalized replacements reindent.
    const text = insert || !ignoreBaseIndent
      ? localReplacement
      : reindentReplacement(localReplacement, searchBodies, bodies);
    if (applyAll || matches.length === 0) {
      projectedLength += text.length - (insert ? 0 : matchEnd - matchStart);
      if (projectedLength > maxResultLength) throwExpansionError();
    }
    matches.push(toReplacement(matchStart, matchEnd, text, first.number, insert));
    if (matches.length > MAX_REPLACEMENTS) {
      throw new Error(
        `Corrected ${field} matched more than ${MAX_REPLACEMENTS.toLocaleString()} locations. ` +
          `Add surrounding context instead. No changes were written.`,
      );
    }
  }
  return matches;
}

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "\n" && char !== "\r") continue;
    const ending = char === "\r" && text[index + 1] === "\n" ? "\r\n" : char;
    const bodyEnd = index;
    const end = index + ending.length;
    lines.push({ start, end, bodyEnd, body: text.slice(start, bodyEnd), ending, number });
    start = end;
    number++;
    if (ending === "\r\n") index++;
  }
  if (start < text.length) {
    lines.push({
      start,
      end: text.length,
      bodyEnd: text.length,
      body: text.slice(start),
      ending: "",
      number,
    });
  }
  return lines;
}

function normalizeLine(line: string): string {
  return normalizeTypography(line).trimEnd();
}

function normalizeTypography(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(UNICODE_SPACES, " ");
}

function indentationSignature(lines: string[]): string[] {
  const common = minimumIndentWidth(lines);
  return lines.map((line) => {
    if (line.trim().length === 0) return "";
    const leading = leadingWhitespace(line);
    const body = line.slice(leading.length);
    return `${Math.max(0, indentationWidth(leading) - common)}:${normalizeTypography(body).trimEnd()}`;
  });
}

function minimumIndentWidth(lines: string[]): number {
  const widths = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => indentationWidth(leadingWhitespace(line)));
  return widths.length > 0 ? Math.min(...widths) : 0;
}

function reindentReplacement(
  replacement: string,
  searchLines: string[],
  candidateLines: string[],
): string {
  const delta = minimumIndentWidth(candidateLines) - minimumIndentWidth(searchLines);
  if (delta === 0) return replacement;

  const targetIndents = new Map<number, string | null>();
  for (const line of candidateLines) {
    if (line.trim().length === 0) continue;
    const indent = leadingWhitespace(line);
    const width = indentationWidth(indent);
    const prior = targetIndents.get(width);
    targetIndents.set(width, prior === undefined || prior === indent ? indent : null);
  }
  const targetUsesTabs = [...targetIndents.values()].some((indent) => indent?.includes("\t"));
  return splitLines(replacement)
    .map((line) => {
      if (line.body.trim().length === 0) return line.body + line.ending;
      const indent = leadingWhitespace(line.body);
      const width = Math.max(0, indentationWidth(indent) + delta);
      const callerUsesTabs = indent.includes("\t");
      if (callerUsesTabs && width < 4) {
        throw new Error("Cannot preserve tab indentation after this correction. Use exact oldText or write_files. No changes were written.");
      }
      const targetIndent = callerUsesTabs ? undefined : targetIndents.get(width);
      if (targetIndent === null) {
        throw new Error("Matched lines mix tabs and spaces at the same depth. Use exact oldText or write_files. No changes were written.");
      }
      // Caller tabs can be syntax (Makefiles). Otherwise reuse the target's known indentation.
      const shifted = targetIndent ?? (targetUsesTabs || callerUsesTabs
        ? "\t".repeat(Math.floor(width / 4)) + " ".repeat(width % 4)
        : " ".repeat(width));
      return `${shifted}${line.body.slice(indent.length)}${line.ending}`;
    })
    .join("");
}

function leadingWhitespace(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? "";
}

function indentationWidth(value: string): number {
  let width = 0;
  for (const char of value) width = char === "\t" ? width + (4 - (width % 4)) : width + 1;
  return width;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringsMatchAt(content: string[], search: string[], start: number): boolean {
  return search.every((value, index) => value === content[start + index]);
}

function hasFinalLineEnding(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

function hasOverlaps(replacements: Replacement[]): boolean {
  const ordered = [...replacements].sort((left, right) => left.matchStart - right.matchStart);
  return ordered.some((item, index) => index > 0 && item.matchStart < ordered[index - 1]!.matchEnd);
}

function assertProjectedExpansion(
  contentLength: number,
  count: number,
  removedPerMatch: number,
  replacementLength: number,
  maxResultLength: number,
): void {
  if (count === 0) return;
  const projectedLength = contentLength + count * (replacementLength - removedPerMatch);
  if (projectedLength > maxResultLength) throwExpansionError();
}

function throwExpansionError(): never {
  throw new Error(
    `Ordered edits would expand the result by more than ${MAX_EDIT_EXPANSION_CHARS.toLocaleString()} ` +
      "characters. Use write_files or smaller edits. No changes were written.",
  );
}

function applyReplacements(
  content: string,
  replacements: Replacement[],
  maxResultLength: number,
): string {
  const ordered = [...replacements].sort((left, right) => left.start - right.start);
  let projectedLength = content.length;
  for (const replacement of ordered) {
    projectedLength += replacement.text.length - (replacement.end - replacement.start);
    if (projectedLength > maxResultLength) throwExpansionError();
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of ordered) {
    parts.push(content.slice(cursor, replacement.start), replacement.text);
    cursor = replacement.end;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

function missingEditMessage(
  content: string,
  oldText: string,
  newText: string,
  path: string,
  index: number,
  field: "oldText" | "endText" = "oldText",
): string {
  const replacementOffsets = newText.length > 0 ? findOccurrences(content, newText, 7) : [];
  const replacementLines = replacementOffsets
    .slice(0, 6)
    .map((offset) => lineNumberAt(content, offset));
  const replacementSuffix = replacementOffsets.length > replacementLines.length ? ", …" : "";
  const alreadyPresent = replacementOffsets.length > 0
    ? ` The replacement text already appears at line${replacementOffsets.length === 1 ? "" : "s"} ` +
      `${replacementLines.join(", ")}${replacementSuffix}; the edit may already be applied.`
    : "";
  const closest = findClosestBlock(content, oldText);
  const similarity = closest ? Math.round(closest.score * 100) : 0;
  const candidateLabel = closest?.sampled ? "Similar sampled block" : "Closest block";
  const hint = closest
    ? `\n${candidateLabel} is lines ${closest.startLine}-${closest.endLine} (${similarity}% similar):\n` +
      `${closest.excerpt}\nUse the actual block above as ${field} and retry.`
    : fileHeadHint(content);
  return `Could not find edits[${index}].${field} in ${path}.${alreadyPresent}${hint}\nNo changes were written.`;
}

function fileHeadHint(content: string): string {
  if (content.length === 0) return "\nFile is empty. Re-read the target area and retry with the current text.";
  let end = 0;
  let lines = 1;
  const scanLimit = Math.min(content.length, DIAGNOSTIC_LIMIT_BYTES);
  while (end < scanLimit && lines <= 8) {
    const char = content[end++];
    if (char === "\n" || (char === "\r" && content[end] !== "\n")) lines++;
  }
  const excerpt = truncateUtf8(content.slice(0, end).replace(/\r\n|\r/g, "\n"), DIAGNOSTIC_LIMIT_BYTES).text;
  const more = end < content.length ? "\n..." : "";
  return (
    `\nFile starts with:\n${excerpt}${more}\n` +
    "Re-read the target area and retry with the current text."
  );
}

function findClosestBlock(
  content: string,
  search: string,
): { startLine: number; endLine: number; score: number; excerpt: string; sampled: boolean } | undefined {
  if (Buffer.byteLength(search) > DIAGNOSTIC_SEARCH_LIMIT_BYTES) return undefined;
  const searchLines = splitLines(search);
  if (searchLines.length === 0 || searchLines.length > DIAGNOSTIC_SEARCH_LIMIT_LINES) return undefined;
  if (
    content.length > DIAGNOSTIC_CONTENT_LIMIT_CHARS ||
    countTextLines(content) > DIAGNOSTIC_CONTENT_LIMIT_LINES
  ) {
    return undefined;
  }
  const contentLines = splitLines(content);
  if (contentLines.length === 0 || contentLines.length < searchLines.length) return undefined;

  const wanted = normalizeForSimilarity(searchLines.map((line) => line.body).join("\n"));
  if (wanted.length === 0) return undefined;
  let best: { start: number; score: number; text: string } | undefined;
  const totalWindows = contentLines.length - searchLines.length + 1;
  const windows = Math.min(
    totalWindows,
    Math.max(1, Math.floor(DIAGNOSTIC_WORK_BUDGET / wanted.length)),
  );
  let previousStart = -1;
  for (let sample = 0; sample < windows; sample++) {
    const start = windows === totalWindows
      ? sample
      : Math.floor((sample * (totalWindows - 1)) / Math.max(1, windows - 1));
    if (start === previousStart) continue;
    previousStart = start;
    const text = contentLines.slice(start, start + searchLines.length).map((line) => line.body).join("\n");
    const score = diceSimilarity(wanted, normalizeForSimilarity(text));
    if (!best || score > best.score) best = { start, score, text };
  }
  if (!best || best.score < 0.35) return undefined;

  return {
    startLine: best.start + 1,
    endLine: best.start + searchLines.length,
    score: best.score,
    excerpt: truncateUtf8(best.text, DIAGNOSTIC_LIMIT_BYTES).text,
    sampled: windows < totalWindows,
  };
}

function normalizeForSimilarity(value: string): string {
  return normalizeTypography(value).replace(/\s+/g, " ").trim();
}

function diceSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index++) {
    const pair = left.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index++) {
    const pair = right.slice(index, index + 2);
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      overlap++;
      counts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

function lineNumbersAt(content: string, offsets: number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let cursor = 0;
  for (const offset of offsets) {
    while (cursor < offset) {
      if (content[cursor] === "\n") line++;
      else if (content[cursor] === "\r" && content[cursor + 1] !== "\n") line++;
      cursor++;
    }
    lines.push(line);
  }
  return lines;
}

function lineNumberAt(content: string, offset: number): number {
  return lineNumbersAt(content, [offset])[0] ?? 1;
}

function lineEndingsAt(content: string, offsets: number[]): LineEnding[] {
  const endings: LineEnding[] = [];
  const fallback = detectLineEnding(content);
  let cursor = 0;
  for (const offset of offsets) {
    if (content[offset] === "\n" && content[offset - 1] === "\r") {
      endings.push("\r\n");
      continue;
    }
    if (cursor < offset) cursor = offset;
    while (cursor < content.length && content[cursor] !== "\r" && content[cursor] !== "\n") cursor++;
    if (cursor >= content.length) {
      endings.push(fallback);
    } else if (content[cursor] === "\r" && content[cursor + 1] === "\n") {
      endings.push("\r\n");
    } else {
      endings.push(content[cursor] as "\r" | "\n");
    }
  }
  return endings;
}

function uniformLineEnding(text: string): LineEnding | undefined {
  let found: LineEnding | undefined;
  for (let index = 0; index < text.length; index++) {
    let ending: LineEnding | undefined;
    if (text[index] === "\r" && text[index + 1] === "\n") {
      ending = "\r\n";
      index++;
    } else if (text[index] === "\n") ending = "\n";
    else if (text[index] === "\r") ending = "\r";
    if (!ending) continue;
    if (found && ending !== found) return undefined;
    found = ending;
  }
  return found;
}

function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      crlf++;
      index++;
    } else if (text[index] === "\n") lf++;
    else if (text[index] === "\r") cr++;
  }
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

function convertLineEndings(text: string, ending: LineEnding): string {
  return text.replace(/\r\n|\r|\n/g, ending);
}

function convertedReplacement(
  text: string,
  ending: LineEnding,
  cache: Map<LineEnding, string>,
): string {
  const cached = cache.get(ending);
  if (cached !== undefined) return cached;
  const converted = convertLineEndings(text, ending);
  cache.set(ending, converted);
  return converted;
}

function countLeadingBomCharacters(text: string): number {
  let count = 0;
  while (text[count] === "\uFEFF") count++;
  return count;
}

function decodeText(bytes: Buffer, path: string): { text: string; body: string; hadBom: boolean } {
  const hadBom = bytes.subarray(0, 3).equals(UTF8_BOM);
  const content = hadBom ? bytes.subarray(3) : bytes;
  let body: string;
  try {
    // The first BOM was removed explicitly; preserve any following U+FEFF content.
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new Error(`Cannot edit non-UTF-8 file: ${path}`);
  }
  if (body.includes("\0")) throw new Error(`Cannot edit file containing NUL bytes: ${path}`);
  return { text: `${hadBom ? "\uFEFF" : ""}${body}`, body, hadBom };
}

function buildDetails(
  path: string,
  operation: ApplyEditsDetails["operation"],
  editsRequested: number,
  editsApplied: number,
  matches: AppliedEditDetail[],
  oldText: string,
  newText: string,
  warnings: string[],
): ApplyEditsDetails {
  const bytesBefore = Buffer.byteLength(oldText);
  const bytesAfter = Buffer.byteLength(newText);
  const exceedsInputBudget = bytesBefore + bytesAfter > DIFF_WORK_LIMIT_BYTES ||
    countTextLines(oldText) + countTextLines(newText) > DIFF_TOTAL_LINE_LIMIT;
  const patch = oldText === newText
    ? ""
    : exceedsInputBudget
      ? undefined
      : createTwoFilesPatch(path, path, oldText, newText, undefined, undefined, {
        context: 3,
        headerOptions: FILE_HEADERS_ONLY,
        timeout: DIFF_TIMEOUT_MS,
        maxEditLength: DIFF_MAX_EDIT_LENGTH,
      });
  const { addedLines, deletedLines } = patch === undefined
    ? { addedLines: undefined, deletedLines: undefined }
    : countPatchLines(patch);
  return {
    path,
    operation,
    editsRequested,
    editsApplied,
    matches,
    bytesBefore,
    bytesAfter,
    addedLines,
    deletedLines,
    diff: patch ?? "[Diff omitted: input size or diff work exceeded the bounded budget.]",
    diffTruncated: patch === undefined,
    warnings,
  };
}

function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") lines++;
    else if (text[index] === "\r" && text[index + 1] !== "\n") lines++;
  }
  return lines;
}

function countPatchLines(patch: string): { addedLines: number; deletedLines: number } {
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

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end--;
    }
  }
  return { text: "", truncated: true };
}

function displayPathFor(path: string, cwd: string): string {
  if (process.platform !== "win32") {
    const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
    return path.startsWith(prefix) ? path.slice(prefix.length) || "." : path;
  }
  const candidate = relative(cwd, path);
  const outside = candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate);
  return (outside ? path : candidate || ".").split(sep).join("/");
}

