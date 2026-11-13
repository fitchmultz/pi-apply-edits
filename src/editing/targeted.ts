import {
  MAX_EDITS_PER_FILE,
  MAX_EDIT_EXPANSION_CHARS,
  required,
  type ReadonlyTargetedEdit,
  type AppliedEditDetail,
  type TextEditResult,
  type MatchResult,
  type Replacement,
  type MatchStrategy,
  type InsertPosition,
} from "./contracts.ts";
import { findMatch, toReplacement, type MatchAttempt } from "./matching.ts";
import { missingEditMessage } from "./diagnostics.ts";
import { hasFinalLineEnding, lineNumbersAt } from "./text.ts";
import { applyReplacements, hasOverlaps, nonOverlapping } from "./replacements.ts";

function validateEditStrings(edit: ReadonlyTargetedEdit, index: number): void {
  if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
    throw new Error(`edits[${index}] must contain string oldText and newText fields`);
  }
  if (edit.endText !== undefined && typeof edit.endText !== "string") {
    throw new Error(`edits[${index}].endText must be a string`);
  }
  if (edit.oldText.length === 0) {
    throw new Error(`edits[${index}].oldText must not be empty`);
  }
  if (edit.endText === "") {
    throw new Error(`edits[${index}].endText must not be empty`);
  }
  const texts = [edit.oldText, edit.newText, ...(edit.endText === undefined ? [] : [edit.endText])];
  if (texts.some((text) => text.includes("\0"))) {
    throw new Error(`edits[${index}] cannot read or write NUL bytes`);
  }
  if (texts.some((text) => !text.isWellFormed())) {
    throw new Error(`edits[${index}] must contain valid Unicode text`);
  }
}
function validateEdit(edit: ReadonlyTargetedEdit, index: number): void {
  validateEditStrings(edit, index);
  validateEditOptions(edit, index);
}
function validateEditOptions(edit: ReadonlyTargetedEdit, index: number): void {
  if (edit.all !== undefined && typeof edit.all !== "boolean") {
    throw new Error(`edits[${index}].all must be a boolean`);
  }
  const insert: unknown = edit.insert;
  if (insert !== undefined) {
    if (insert !== "before" && insert !== "after") {
      throw new Error(`edits[${index}].insert must be "before" or "after"`);
    }
    if (edit.newText.length === 0) {
      throw new Error(`edits[${index}].newText must not be empty when insert is set`);
    }
  }
  if (edit.endText !== undefined) {
    if (edit.all === true) {
      throw new Error(`edits[${index}].all cannot be combined with endText`);
    }
    if (edit.insert !== undefined) {
      throw new Error(`edits[${index}].insert cannot be combined with endText`);
    }
  }
}
/** A plain replacement by the same text changes nothing wherever it matches. */
function isIdenticalPair(edit: ReadonlyTargetedEdit): boolean {
  return edit.insert === undefined && edit.endText === undefined && edit.oldText === edit.newText;
}
export const IDENTICAL_PAIR = "would make no change because oldText and newText are identical";
type EditMode =
  | { readonly kind: "replace"; readonly applyAll: boolean }
  | { readonly kind: "range"; readonly endText: string; readonly applyAll: false }
  | { readonly kind: "insert"; readonly direction: InsertPosition; readonly applyAll: boolean };

function editMode(edit: ReadonlyTargetedEdit): EditMode {
  if (edit.endText !== undefined) {
    return { kind: "range", endText: edit.endText, applyAll: false };
  }
  const applyAll = edit.all === true;
  if (edit.insert !== undefined) {
    return { kind: "insert", direction: edit.insert, applyAll };
  }
  return { kind: "replace", applyAll };
}
function combinedStrategy(start: MatchStrategy, end: MatchStrategy): MatchStrategy {
  if (start === "indent-normalized" || end === "indent-normalized") {
    return "indent-normalized";
  }
  return start === "normalized" || end === "normalized" ? "normalized" : "exact";
}
interface EditLocation {
  readonly path: string;
  readonly index: number;
}
function assertUniqueRange(
  match: MatchResult,
  location: EditLocation,
  field: "oldText" | "endText",
): void {
  if (match.replacements.length <= 1) {
    return;
  }
  const lines = match.replacements.slice(0, 8).map((item) => item.line);
  const suffix = match.replacements.length > lines.length ? ", …" : "";
  const direction = field === "oldText" ? "start" : "end";
  const allNote = field === "oldText" ? "endText ranges do not support all: true. " : "";
  throw new Error(
    `edits[${location.index}].${field} matched ${match.replacements.length} locations in ${location.path} (lines ${lines.join(", ")}${suffix}). Add enough surrounding text to make the range ${direction} unique. ${allNote}No changes were written.`,
  );
}
/** Searches only after oldText, so earlier occurrences cannot make the range end ambiguous. */
function endMatchAfter(
  content: string,
  start: Replacement,
  endText: string,
  location: EditLocation,
): MatchResult {
  const search = {
    oldText: endText,
    newText: "",
    applyAll: false,
    maxResultLength: Number.MAX_SAFE_INTEGER,
    field: "endText" as const,
  };
  const offset = start.matchEnd;
  const endMatch = findMatch(content.slice(offset), search);
  if (endMatch.strategy === "missing") {
    const earlier = findMatch(content, search);
    if (earlier.strategy !== "missing") {
      throw new Error(
        `edits[${location.index}].endText must match after oldText in ${location.path} (oldText line ${start.line}, endText line ${required(earlier.replacements[0]).line}). No changes were written.`,
      );
    }
    throw new Error(
      missingEditMessage(content, {
        ...location,
        oldText: endText,
        newText: "",
        field: "endText",
        correctionSkipped: endMatch.correctionSkipped || earlier.correctionSkipped,
      }),
    );
  }
  const lineOffset = required(lineNumbersAt(content, [offset])[0]) - 1;
  return {
    strategy: endMatch.strategy,
    replacements: endMatch.replacements.map((item) => ({
      start: item.start + offset,
      end: item.end + offset,
      matchStart: item.matchStart + offset,
      matchEnd: item.matchEnd + offset,
      text: item.text,
      line: item.line + lineOffset,
    })),
  };
}
function rangeMatch(
  content: string,
  edit: ReadonlyTargetedEdit,
  endText: string,
  location: EditLocation,
): MatchAttempt {
  const startMatch = findMatch(content, {
    oldText: edit.oldText,
    newText: edit.newText,
    applyAll: false,
    maxResultLength: Number.MAX_SAFE_INTEGER,
  });
  if (startMatch.strategy === "missing") {
    return startMatch;
  }
  assertUniqueRange(startMatch, location, "oldText");
  const start = required(startMatch.replacements[0]);
  const endMatch = endMatchAfter(content, start, endText, location);
  assertUniqueRange(endMatch, location, "endText");
  const end = required(endMatch.replacements[0]);
  return {
    strategy: combinedStrategy(startMatch.strategy, endMatch.strategy),
    replacements: [
      toReplacement({
        start: start.matchStart,
        end: end.matchEnd,
        text: start.text,
        line: start.line,
      }),
    ],
  };
}
function assertUnique(match: MatchResult, applyAll: boolean, location: EditLocation): void {
  if (applyAll || match.replacements.length <= 1) {
    return;
  }
  const lines = match.replacements.slice(0, 8).map((item) => item.line);
  const suffix = match.replacements.length > lines.length ? ", …" : "";
  throw new Error(
    `edits[${location.index}].oldText matched ${match.replacements.length} locations in ${location.path} (lines ${lines.join(", ")}${suffix}). Add enough surrounding text to make it unique, or set all: true only when every match should change. No changes were written.`,
  );
}
function preserveCrLf(content: string, item: Replacement, mode: EditMode): Replacement {
  const insert = mode.kind === "insert" ? mode.direction : undefined;
  // Consume an unmatched CRLF half only if replacement/insertion supplies a newline.
  const joinsStart = content[item.matchStart] === "\n" && content[item.matchStart - 1] === "\r";
  const joinsEnd = content[item.matchEnd - 1] === "\r" && content[item.matchEnd] === "\n";
  const start =
    joinsStart && (insert !== undefined || /^[\r\n]/.test(item.text))
      ? item.matchStart - 1
      : item.matchStart;
  const end =
    joinsEnd && (insert !== undefined || hasFinalLineEnding(item.text))
      ? item.matchEnd + 1
      : item.matchEnd;
  return toReplacement({ start, end, text: item.text, line: item.line }, insert);
}
function effectiveReplacements(
  content: string,
  match: MatchResult,
  mode: EditMode,
  location: EditLocation,
): readonly Replacement[] {
  assertUnique(match, mode.applyAll, location);
  const candidates = mode.applyAll
    ? nonOverlapping(match.replacements)
    : match.replacements.slice(0, 1);
  const selected = candidates.map((item) => preserveCrLf(content, item, mode));
  if (hasOverlaps(selected)) {
    throw new Error(
      `edits[${location.index}] has overlapping matches in ${location.path}. Add more surrounding text so matches do not overlap. No changes were written.`,
    );
  }
  const effective =
    mode.kind === "insert"
      ? selected
      : selected.filter((item) => content.slice(item.start, item.end) !== item.text);
  if (effective.length === 0) {
    throw new Error(
      `edits[${location.index}] already produces the requested text at its matched location in ${location.path}. No changes were written.`,
    );
  }
  return effective;
}
function editDetail(
  index: number,
  strategy: MatchStrategy,
  replaced: readonly Replacement[],
): AppliedEditDetail {
  return {
    index,
    strategy,
    replacements: replaced.length,
    lines: replaced.slice(0, 32).map((item) => item.line),
    linesTruncated: replaced.length > 32 || undefined,
  };
}
/**
 * An identical pair replaces nothing, so its detail records where the text was found with
 * zero replacements. Text that is not there is refused: the caller believes otherwise.
 */
function identicalPairDetail(
  content: string,
  edit: ReadonlyTargetedEdit,
  location: EditLocation,
): AppliedEditDetail {
  const match = findMatch(content, {
    oldText: edit.oldText,
    newText: edit.newText,
    applyAll: true,
    maxResultLength: Number.MAX_SAFE_INTEGER,
  });
  if (match.strategy === "missing") {
    const state = location.index > 0 ? " after the preceding edits" : "";
    throw new Error(
      `edits[${location.index}] ${IDENTICAL_PAIR}, and its oldText was not found in ${location.path}${state}. No changes were written.`,
    );
  }
  return { ...editDetail(location.index, match.strategy, match.replacements), replacements: 0 };
}
interface AppliedEdit {
  readonly text: string;
  readonly detail: AppliedEditDetail;
}
function applyEdit(
  current: string,
  edit: ReadonlyTargetedEdit,
  location: EditLocation,
  maxResultLength: number,
): AppliedEdit {
  const mode = editMode(edit);
  const match =
    mode.kind === "range"
      ? rangeMatch(current, edit, mode.endText, location)
      : findMatch(current, {
          oldText: edit.oldText,
          newText: edit.newText,
          insert: mode.kind === "insert" ? mode.direction : undefined,
          applyAll: mode.applyAll,
          maxResultLength,
        });
  if (match.strategy === "missing") {
    throw new Error(
      missingEditMessage(current, {
        ...location,
        oldText: edit.oldText,
        newText: edit.newText,
        correctionSkipped: match.correctionSkipped,
      }),
    );
  }
  const effective = effectiveReplacements(current, match, mode, location);
  return {
    text: applyReplacements(current, effective, maxResultLength),
    detail: editDetail(location.index, match.strategy, effective),
  };
}
/**
 * Applies the ordered edits in memory. An identical pair found in the text is reported with
 * zero replacements; when every edit is one, the text is returned as is.
 */
export function editTargetedText(
  original: string,
  edits: readonly ReadonlyTargetedEdit[],
  displayPath: string,
): TextEditResult {
  if (edits.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }
  if (edits.length > MAX_EDITS_PER_FILE) {
    throw new Error(`edits cannot contain more than ${MAX_EDITS_PER_FILE} entries`);
  }
  const maxResultLength = Math.min(
    Number.MAX_SAFE_INTEGER,
    original.length + MAX_EDIT_EXPANSION_CHARS,
  );
  let current = original;
  const matches: AppliedEditDetail[] = [];
  for (const [index, edit] of edits.entries()) {
    validateEdit(edit, index);
    const location = { path: displayPath, index };
    if (isIdenticalPair(edit)) {
      matches.push(identicalPairDetail(current, edit, location));
    } else {
      const applied = applyEdit(current, edit, location, maxResultLength);
      current = applied.text;
      matches.push(applied.detail);
    }
  }
  if (current === original && matches.some((match) => match.replacements > 0)) {
    throw new Error(
      `The ordered edits cancel each other out in ${displayPath}; no changes were written.`,
    );
  }
  return { text: current, matches };
}
/** Single-text API: refuses a list in which every edit is an identical pair. */
export function applyTargetedEdits(
  original: string,
  edits: readonly ReadonlyTargetedEdit[],
  displayPath: string,
): TextEditResult {
  const result = editTargetedText(original, edits, displayPath);
  if (result.matches.every((match) => match.replacements === 0)) {
    throw new Error(`edits[0] ${IDENTICAL_PAIR}`);
  }
  return result;
}
