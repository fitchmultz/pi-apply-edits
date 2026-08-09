import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  assertSafeToReplace,
  assertSnapshotCurrent,
  captureSnapshot,
  discardPreparedNestedFiles,
  planNewFile,
  preparePlannedNestedFiles,
  PartialCreatePublishError,
  publishNewFile,
  publishPreparedNestedFiles,
  publishReplacement,
  type NewFilePlan,
  type PreparedNestedFiles,
  throwIfAborted,
} from "./file-system.ts";

export type InsertPosition = "before" | "after";

export interface TargetedEdit {
  oldText: string;
  newText: string;
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
}

/** Tool args: one file (path + edits|rewrite) or an atomic multi-file batch. */
export interface ApplyEditsRequest {
  path?: string;
  edits?: TargetedEdit[];
  rewrite?: string;
  onMissing?: "error" | "create";
  requireMissing?: boolean;
  files?: ApplyEditsInput[];
}

export type ApplyEditsRetry =
  | { kind: "create"; files?: number[] }
  | { kind: "oldText"; file?: number; edit: number };

export class RetryableApplyEditsError extends Error {
  readonly retry: ApplyEditsRetry;

  constructor(message: string, retry: ApplyEditsRetry) {
    super(message);
    this.name = "RetryableApplyEditsError";
    this.retry = retry;
  }
}

class MissingCreateOptInError extends Error {}

class OldTextMatchError extends Error {
  readonly edit: number;

  constructor(message: string, edit: number) {
    super(message);
    this.edit = edit;
  }
}

export type MatchStrategy = "exact" | "normalized" | "indent-normalized";

export interface AppliedEditDetail {
  index: number;
  strategy: MatchStrategy;
  replacements: number;
  lines: number[];
  linesTruncated?: boolean;
}

export interface ApplyEditsDetails {
  path: string;
  operation: "edit" | "rewrite" | "create" | "no_change";
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

export interface ApplyEditsBatchDetails {
  files: ApplyEditsDetails[];
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

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DIFF_LIMIT_BYTES = 32 * 1024;
const DIFF_WORK_LIMIT_BYTES = 1024 * 1024;
const DIFF_LINE_PRODUCT_LIMIT = 4_000_000;
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
  return resolve(cwd, input);
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
    // Preserve the caller's exact anchor. Line-ending tolerance belongs in fuzzy matching,
    // otherwise a mixed-EOL file can redirect an exact LF edit to a different CRLF block.
    const oldText = edit.oldText;
    const newText = edit.newText;
    if (oldText.length === 0) {
      throw new Error(`edits[${index}].oldText must not be empty`);
    }
    if (oldText.includes("\0") || newText.includes("\0")) {
      throw new Error(`edits[${index}] cannot read or write NUL bytes`);
    }
    if (hasUnpairedSurrogate(oldText) || hasUnpairedSurrogate(newText)) {
      throw new Error(`edits[${index}] must contain valid Unicode text`);
    }
    if (edit.insert) {
      if (newText.length === 0) {
        throw new Error(`edits[${index}].newText must not be empty when insert is set`);
      }
    } else if (oldText === newText) {
      throw new Error(`edits[${index}] would make no change because oldText and newText are identical`);
    }

    const match = findMatch(current, oldText, newText, edit.insert, edit.all === true, maxResultLength);
    if (!match) {
      throw new OldTextMatchError(
        missingEditMessage(current, oldText, newText, displayPath, index),
        index,
      );
    }
    if (!edit.all && match.replacements.length > 1) {
      const lines = match.replacements.slice(0, 8).map((item) => item.line);
      const suffix = match.replacements.length > lines.length ? ", …" : "";
      throw new OldTextMatchError(
        `edits[${index}].oldText matched ${match.replacements.length} locations in ${displayPath} ` +
          `(lines ${lines.join(", ")}${suffix}). Add enough surrounding text to make it unique, ` +
          `or set all: true only when every match should change. No changes were written.`,
        index,
      );
    }

    const selected = edit.all ? match.replacements : match.replacements.slice(0, 1);
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

export async function applyEditsToFile(
  input: ApplyEditsRequest,
  cwd: string,
  signal?: AbortSignal,
): Promise<ApplyEditsExecution> {
  validateRequest(input);
  if (input.files) return applyEditsBatch(input.files, cwd, signal);

  const single = input as ApplyEditsInput;
  const inputPath = resolveInputPath(single.path, cwd);
  return withCanonicalFileLock(inputPath, async () => {
    let planned: PlannedMutation;
    try {
      planned = await planFileMutation(single, inputPath, cwd, signal);
    } catch (error) {
      throw retryablePlanningError(error, [single]);
    }
    return commitPlannedMutation(planned, signal);
  });
}

let canonicalLockRegistration = Promise.resolve();

function withCanonicalFileLock<T>(inputPath: string, fn: () => Promise<T>): Promise<T> {
  // Resolve aliases in invocation order, then let Pi's queue serialize only matching keys.
  // Wrapping the operation prevents Promise assimilation from serializing unrelated files.
  const registration = canonicalLockRegistration.then(async () => {
    const keys = await mutationQueueKeys(inputPath);
    return {
      operation: withMutationLocks(keys.localKeys, keys.queueKeys, fn),
    };
  });
  canonicalLockRegistration = registration.then(() => undefined, () => undefined);
  return registration.then(({ operation }) => operation);
}

function retryablePlanningError(
  error: unknown,
  files: ApplyEditsInput[],
  file?: number,
): Error {
  const reason = error instanceof Error ? error.message : String(error);
  const prefix = file === undefined ? "" : `files[${file}]: `;
  if (
    error instanceof MissingCreateOptInError &&
    files.every((input) => typeof input.rewrite === "string" && input.edits === undefined)
  ) {
    return new RetryableApplyEditsError(`${prefix}${reason}`, { kind: "create" });
  }
  if (
    error instanceof OldTextMatchError &&
    files.every((input) => Array.isArray(input.edits) && input.rewrite === undefined)
  ) {
    return new RetryableApplyEditsError(`${prefix}${reason}`, {
      kind: "oldText",
      file,
      edit: error.edit,
    });
  }
  return error instanceof Error ? error : new Error(reason);
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
  insertsRequested: number;
  needsWrite: boolean;
  createPlan?: NewFilePlan;
  lockKey?: string;
}

async function applyEditsBatch(
  files: ApplyEditsInput[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ApplyEditsExecution> {
  if (files.length === 0) throw new Error("files must contain at least one entry");
  for (const [index, file] of files.entries()) {
    try {
      validateInput(file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`files[${index}]: ${reason}`);
    }
  }

  const resolved = await Promise.all(
    files.map(async (file, index) => {
      const inputPath = resolveInputPath(file.path, cwd);
      // Match Pi's mutation-queue key (realpath) so aliases cannot nest-lock or slip past dedupe.
      const keys = await mutationQueueKeys(inputPath);
      return { file, inputPath, ...keys, index };
    }),
  );
  const seen = new Map<string, number>();
  for (const item of resolved) {
    const prior = seen.get(item.targetKey);
    if (prior !== undefined) {
      throw new Error(
        `files[${item.index}] refers to the same file as files[${prior}] ` +
          `(${item.inputPath}). Combine edits for one path into a single entry.`,
      );
    }
    seen.set(item.targetKey, item.index);
  }
  rejectAncestorPathConflicts(resolved);

  const lockPaths = [...new Set(resolved.flatMap((item) => item.queueKeys))].sort();
  const localPaths = resolved.flatMap((item) => item.localKeys);
  return withMutationLocks(localPaths, lockPaths, async () => {
    const planned: PlannedMutation[] = [];
    const allRewrites = files.every(
      (input) => typeof input.rewrite === "string" && input.edits === undefined,
    );
    const missingCreates: Array<{ file: number; message: string }> = [];
    const missingTargets = new Set<number>();
    for (const item of resolved) {
      try {
        const plan = await planFileMutation(item.file, item.inputPath, cwd, signal, item.targetKey);
        planned.push(plan);
        if (plan.operation === "create") missingTargets.add(item.index);
      } catch (error) {
        if (allRewrites && error instanceof MissingCreateOptInError) {
          missingTargets.add(item.index);
          missingCreates.push({ file: item.index, message: error.message });
          continue;
        }
        throw retryablePlanningError(error, files, item.index);
      }
    }
    if (missingCreates.length > 0) {
      throw new RetryableApplyEditsError(
        missingCreates.map(({ file, message }) => `files[${file}]: ${message}`).join("\n"),
        { kind: "create", files: [...missingTargets].sort((left, right) => left - right) },
      );
    }

    const nestedGroups = new Map<string, number[]>();
    for (const [index, plan] of planned.entries()) {
      const key = nestedCreateRootKey(plan);
      if (!key) continue;
      const group = nestedGroups.get(key) ?? [];
      group.push(index);
      nestedGroups.set(key, group);
    }
    for (const group of nestedGroups.values()) {
      const spellings = new Set(
        group.map((index) => planned[index]!.createPlan!.missingDirectories[0]),
      );
      if (spellings.size > 1) {
        throw new Error(
          `files[${group.join(", ")}] use alias spellings for one missing directory. ` +
            "Use one consistent path spelling so the batch can publish it safely.",
        );
      }
    }

    // Build every nested-create staging tree before any target publication.
    const preparedExecutions = new Map<number, ApplyEditsExecution>();
    const preparedGroups = new Map<string, PreparedNestedFiles>();
    let failure: unknown;
    try {
      for (const [key, group] of nestedGroups) {
        for (const groupIndex of group) {
          preparedExecutions.set(
            groupIndex,
            await commitPlannedMutation(planned[groupIndex]!, signal, []),
          );
        }
        try {
          preparedGroups.set(
            key,
            await preparePlannedNestedFiles(
              group.map((groupIndex) => ({
                plan: planned[groupIndex]!.createPlan!,
                bytes: planned[groupIndex]!.nextBytes,
              })),
              signal,
            ),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`files[${group.join(", ")}] could not be prepared. ${reason}`);
        }
      }

      // Plan and stage fully before any write. Mid-publish FS failure can still leave earlier files written.
      const detailsList = new Array<ApplyEditsDetails>(planned.length);
      const publishedGroups = new Set<string>();
      let written = 0;
      for (const [index, plan] of planned.entries()) {
        try {
          const key = nestedCreateRootKey(plan);
          let execution = key ? preparedExecutions.get(index) : undefined;
          if (key) {
            const group = nestedGroups.get(key)!;
            if (!publishedGroups.has(key)) {
              const warnings = await publishPreparedNestedFiles(preparedGroups.get(key)!, signal);
              const firstExecution = preparedExecutions.get(group[0]!);
              if (firstExecution && "warnings" in firstExecution.details) {
                firstExecution.details.warnings.push(...warnings);
              }
              publishedGroups.add(key);
              written += group.length;
            }
          } else {
            execution = await commitPlannedMutation(plan, signal);
            if (plan.needsWrite) written += 1;
          }
          if (!execution) throw new Error(`Missing prepared result for files[${index}]`);
          detailsList[index] = execution.details as ApplyEditsDetails;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const completed = written + (error instanceof PartialCreatePublishError
            ? error.publishedFiles
            : 0);
          throw new Error(
            `Multi-file batch failed while writing files[${index}] (${plan.displayPath}) ` +
              `after ${completed} successful write${completed === 1 ? "" : "s"}. ${reason}`,
          );
        }
      }

      const changed = detailsList.filter((item) => item.operation !== "no_change");
      if (changed.length === 0) {
        return {
          summary: `No change: ${detailsList.length} file${detailsList.length === 1 ? "" : "s"} already match.`,
          details: { files: detailsList },
        };
      }
      const countsKnown = changed.every(
        (item) => item.addedLines !== undefined && item.deletedLines !== undefined,
      );
      const added = changed.reduce((sum, item) => sum + (item.addedLines ?? 0), 0);
      const deleted = changed.reduce((sum, item) => sum + (item.deletedLines ?? 0), 0);
      const counts = countsKnown && added + deleted > 0 ? ` (+${added}/-${deleted})` : "";
      const visibleNames = changed.slice(0, 8).map((item) => item.path).join(", ");
      const names = changed.length > 8
        ? `${visibleNames}, … ${changed.length - 8} more`
        : visibleNames;
      const warnings = detailsList.flatMap((item) => item.warnings);
      const visibleWarnings = warnings.slice(0, 4).join(" ");
      const warningText = warnings.length > 0
        ? ` Warning: ${visibleWarnings}${warnings.length > 4 ? ` … ${warnings.length - 4} more` : ""}`
        : "";
      return {
        summary: `Updated ${changed.length} file${changed.length === 1 ? "" : "s"}${counts}: ${names}.${warningText}`,
        details: { files: detailsList },
      };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const cleanupFailures: string[] = [];
      for (const prepared of preparedGroups.values()) {
        try {
          await discardPreparedNestedFiles(prepared);
        } catch (error) {
          cleanupFailures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (cleanupFailures.length > 0) {
        const cleanup = `Staged create cleanup was incomplete: ${cleanupFailures.join("; ")}`;
        if (failure instanceof Error) {
          failure.message = `${failure.message} ${cleanup}`;
          throw failure;
        }
        throw new Error(`${failure === undefined ? "" : `${String(failure)} `}${cleanup}`);
      }
    }
  });
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

// Package-local mutex. Unlike Pi's queue, these keys are literal strings this module chooses
// and never resolves, so two distinct keys can never become one lock. That is what makes it
// safe to hold several at once, and what makes it usable for coordination that must survive a
// path coming into existence: case-folded spellings of one create, and the shared missing root
// of sibling creates. Always acquired outside Pi's queue, never inside, so the two orderings
// cannot form a cycle.
const localMutationLocks = new Map<string, Promise<void>>();

function withMutationLocks<T>(local: string[], pi: string[], fn: () => Promise<T>): Promise<T> {
  return withLocalLocks(local, () => withOrderedFileLocks(pi, fn));
}

async function withLocalLocks<T>(unordered: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(unordered)].sort();
  const run = async (index: number): Promise<T> => {
    if (index >= keys.length) return fn();
    const key = keys[index]!;
    // Registration is synchronous, so two callers cannot interleave between read and write.
    const previous = localMutationLocks.get(key) ?? Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => held);
    localMutationLocks.set(key, chained);
    await previous;
    try {
      return await run(index + 1);
    } finally {
      release();
      if (localMutationLocks.get(key) === chained) localMutationLocks.delete(key);
    }
  };
  return run(0);
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

async function planFileMutation(
  input: ApplyEditsInput,
  inputPath: string,
  cwd: string,
  signal?: AbortSignal,
  lockKey?: string,
): Promise<PlannedMutation> {
  throwIfAborted(signal);
  const snapshot = await captureSnapshot(inputPath);
  const displayPath = displayPathFor(inputPath, cwd);

  if (snapshot && input.requireMissing) {
    throw new Error(
      `File now exists: ${displayPath}. Compact create retries require targets to remain missing. ` +
        "No changes were written.",
    );
  }
  if (!snapshot && input.edits) {
    throw new Error(
      `Cannot edit missing file ${displayPath}. Use rewrite with onMissing: "create" to create it.`,
    );
  }
  if (!snapshot && input.onMissing !== "create") {
    const message =
      `File does not exist: ${displayPath}. Set onMissing: "create" with rewrite to create it. ` +
      "No changes were written.";
    if (input.onMissing === undefined) throw new MissingCreateOptInError(message);
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

  if (input.edits) {
    const result = applyTargetedEdits(originalBody, input.edits, displayPath);
    if (countLeadingBomCharacters(result.text) > countLeadingBomCharacters(originalBody)) {
      throw new Error(
        `Targeted edits would move or add U+FEFF to the start of ${displayPath}. ` +
          "Use rewrite to make that encoding change explicit. No changes were written.",
      );
    }
    nextText = `${hadBom ? "\uFEFF" : ""}${result.text}`;
    matches = result.matches;
    operation = "edit";
  } else {
    const rewrite = input.rewrite ?? "";
    const body = snapshot ? convertLineEndings(rewrite, detectLineEnding(originalBody)) : rewrite;
    nextText = `${snapshot && hadBom && !body.startsWith("\uFEFF") ? "\uFEFF" : ""}${body}`;
    operation = snapshot ? "rewrite" : "create";
  }

  const nextBytes = Buffer.from(nextText, "utf8");
  const needsWrite = !(snapshot && nextBytes.equals(snapshot.bytes));
  let createPlan: NewFilePlan | undefined;
  // Fail closed during plan (before any multi-file write) for known-unsafe targets.
  if (needsWrite) {
    if (snapshot) await assertSafeToReplace(snapshot, signal);
    else createPlan = await planNewFile(inputPath);
  }
  return {
    inputPath,
    displayPath,
    snapshot,
    nextBytes,
    originalText,
    nextText,
    matches,
    operation: needsWrite ? operation : "no_change",
    editsRequested: input.edits?.length ?? 1,
    insertsRequested: input.edits?.filter((edit) => edit.insert !== undefined).length ?? 0,
    needsWrite,
    createPlan,
    lockKey,
  };
}

async function commitPlannedMutation(
  plan: PlannedMutation,
  signal?: AbortSignal,
  publicationWarnings?: string[],
): Promise<ApplyEditsExecution> {
  if (!plan.needsWrite) {
    throwIfAborted(signal);
    if (plan.snapshot) await assertSnapshotCurrent(plan.snapshot);
    const details = buildDetails(
      plan.displayPath,
      "no_change",
      plan.editsRequested,
      0,
      plan.matches,
      plan.originalText,
      plan.nextText,
      [],
    );
    return {
      summary: `No change: ${plan.displayPath} already matches the requested content.`,
      details,
    };
  }

  throwIfAborted(signal);
  const editsApplied = plan.editsRequested;
  const details = buildDetails(
    plan.displayPath,
    plan.operation,
    editsApplied,
    editsApplied,
    plan.matches,
    plan.originalText,
    plan.nextText,
    [],
  );
  throwIfAborted(signal);
  const warnings = publicationWarnings ?? (plan.snapshot
    ? await publishReplacement(plan.snapshot, plan.nextBytes, signal)
    : await publishNewFile(plan.inputPath, plan.nextBytes, signal, plan.createPlan));
  details.warnings.push(...warnings);
  if (plan.insertsRequested > 0) {
    details.warnings.push(
      `${plan.insertsRequested} insert${plan.insertsRequested === 1 ? "" : "s"} spliced exactly with zero separator; ` +
        "all newlines and spaces came from newText.",
    );
  }
  const corrected = plan.matches.filter((item) => item.strategy !== "exact").length;
  const counts = (details.addedLines ?? 0) + (details.deletedLines ?? 0) > 0
    ? ` (+${details.addedLines ?? 0}/-${details.deletedLines ?? 0})`
    : "";
  const correction = corrected > 0
    ? `; ${corrected} edit${corrected === 1 ? "" : "s"} matched safely after normalization`
    : "";
  const warningText =
    details.warnings.length > 0 ? ` Warning: ${details.warnings.join(" ")}` : "";
  const verb = plan.operation === "create"
    ? "Created"
    : plan.operation === "rewrite"
      ? "Rewrote"
      : "Edited";
  const unit = plan.matches.length > 0 || plan.operation === "edit"
    ? `${editsApplied} ordered edit${editsApplied === 1 ? "" : "s"}`
    : "full content";

  return {
    summary: `${verb} ${plan.displayPath}: ${unit}${counts}${correction}.${warningText}`,
    details,
  };
}

function validateRequest(input: ApplyEditsRequest): void {
  if (!input || typeof input !== "object") throw new Error("apply_edits input must be an object");
  const hasFiles = Array.isArray(input.files);
  const hasTopLevel =
    input.path !== undefined ||
    input.edits !== undefined ||
    input.rewrite !== undefined ||
    input.onMissing !== undefined ||
    input.requireMissing !== undefined;
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
  if (!input || typeof input !== "object") throw new Error("apply_edits input must be an object");
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (input.path.includes("\0")) throw new Error("path cannot contain NUL bytes");
  if (hasUnpairedSurrogate(input.path)) throw new Error("path must contain valid Unicode text");
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
  if (hasRewrite && input.rewrite && hasUnpairedSurrogate(input.rewrite)) {
    throw new Error("rewrite must contain valid Unicode text");
  }
  if (hasEdits && input.onMissing !== undefined) {
    throw new Error("onMissing is valid only with rewrite");
  }
  if (hasEdits && input.requireMissing !== undefined) {
    throw new Error("requireMissing is valid only with rewrite");
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
      `oldText matched more than ${MAX_REPLACEMENTS.toLocaleString()} locations. ` +
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
    content, oldText, newText, false, insert, applyAll, maxResultLength,
  );
  if (normalized.length > 0) return { strategy: "normalized", replacements: normalized };

  const indentation = findLineBlockMatches(
    content, oldText, newText, true, insert, applyAll, maxResultLength,
  );
  if (indentation.length > 0) return { strategy: "indent-normalized", replacements: indentation };

  return undefined;
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

async function mutationQueueKeys(
  filePath: string,
): Promise<{ targetKey: string; queueKeys: string[]; localKeys: string[] }> {
  const resolvedPath = resolve(filePath);
  try {
    const key = await realpath(resolvedPath);
    return { targetKey: key, queueKeys: [key], localKeys: [] };
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  // A dangling symbolic link is not a missing path for mutation purposes. More importantly,
  // a batch cannot safely queue both it and its missing target: if the target appears while
  // Pi acquires its one-key locks, realpath makes the two keys collapse and the nested second
  // acquisition waits on the batch's own first lock. Reject before acquiring any lock. There
  // remains an inherent race if an external process creates both the link and its target after
  // this lstat; closing that requires an atomic multi-key queue API from Pi.
  await assertNotDanglingSymbolicLink(resolvedPath);

  // Exactly one Pi key per file. Pi canonicalizes each key with realpath at the moment it is
  // acquired, so any two keys an operation holds can collapse onto one queue and deadlock it
  // against itself: a deeper path is not safely distinct from its parent, because a symbolic
  // link can resolve it back up.
  //
  // That key must be the exact-case path. Once the create publishes, an edit of the same file
  // resolves through realpath, which returns the spelling on disk, which is the spelling this
  // create is about to use. A case-folded key would name a different queue after publication
  // and let the edit run against a half-published file. Case folding is kept for targetKey,
  // which only feeds batch duplicate detection, and for the local keys below, which are never
  // canonicalized and so can fold safely.
  const missing: string[] = [];
  let current = resolvedPath;
  while (true) {
    const parent = dirname(current);
    if (parent === current) {
      const targetKey = normalizeLockKey(resolvedPath, missing);
      return { targetKey, queueKeys: [resolvedPath], localKeys: [targetKey] };
    }
    try {
      const realParent = await realpath(parent);
      missing.unshift(basename(current));
      const targetKey = normalizeLockKey(realParent, missing);
      // Fold the target so two spellings of one create serialize, and the missing root so
      // separate creates that would each claim it serialize instead of racing the claim.
      const localKeys = [targetKey];
      if (missing.length > 1) localKeys.push(normalizeLockKey(realParent, missing.slice(0, 1)));
      return { targetKey, queueKeys: [join(realParent, ...missing)], localKeys };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await assertNotDanglingSymbolicLink(parent);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function assertNotDanglingSymbolicLink(path: string): Promise<void> {
  const entry = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (entry?.isSymbolicLink()) {
    throw new Error(`Cannot mutate dangling symbolic link ${path}. No changes were written.`);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeLockKey(existingPrefix: string, missingParts: string[]): string {
  if (missingParts.length === 0) return existingPrefix;
  // Prefer over-dedupe on default macOS/Windows volumes over deterministic partial batch writes.
  const foldCase = process.platform === "darwin" || process.platform === "win32";
  const parts = missingParts.map((part) => {
    if (!foldCase) return part;
    const normalized = part.normalize("NFC");
    // upper→lower is a closer caseless key than lower alone for APFS aliases:
    // ſ/s, ς/σ, ß/ss, and ﬀ/ff all collapse consistently.
    return normalized.toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
  });
  return join(existingPrefix, ...parts);
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
        `Corrected oldText matched more than ${MAX_REPLACEMENTS.toLocaleString()} locations. ` +
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
  return splitLines(replacement)
    .map((line) => {
      if (line.body.trim().length === 0) return line.ending;
      const indent = leadingWhitespace(line.body);
      const width = Math.max(0, indentationWidth(indent) + delta);
      return `${" ".repeat(width)}${line.body.slice(indent.length)}${line.ending}`;
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
      "characters. Use rewrite or smaller edits. No changes were written.",
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
      `${closest.excerpt}\nUse the actual block above as oldText and retry.`
    : fileHeadHint(content);
  return `Could not find edits[${index}].oldText in ${path}.${alreadyPresent}${hint}\nNo changes were written.`;
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

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= text.length) return true;
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
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
  let diffTooExpensive = bytesBefore + bytesAfter > DIFF_WORK_LIMIT_BYTES;
  if (!diffTooExpensive) {
    const oldLines = countTextLines(oldText);
    const newLines = countTextLines(newText);
    diffTooExpensive =
      oldLines + newLines > DIFF_TOTAL_LINE_LIMIT ||
      oldLines * newLines > DIFF_LINE_PRODUCT_LIMIT;
  }
  const patch = oldText === newText
    ? ""
    : diffTooExpensive
      ? `[Diff omitted because the before/after inputs exceed the bounded diff budget.]`
      : generateUnifiedPatch(path, oldText, newText, 3);
  const { addedLines, deletedLines } = diffTooExpensive
    ? { addedLines: undefined, deletedLines: undefined }
    : countPatchLines(patch);
  const truncated = truncateUtf8(patch, DIFF_LIMIT_BYTES);
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
    diff: truncated.truncated ? `${truncated.text}\n... diff truncated ...` : truncated.text,
    diffTruncated: diffTooExpensive || truncated.truncated,
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
  const candidate = relative(cwd, path);
  const outside = candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate);
  return (outside ? path : candidate || ".").split(sep).join("/");
}

