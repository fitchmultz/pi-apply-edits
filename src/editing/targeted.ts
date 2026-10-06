import {
  MAX_EDITS_PER_FILE,
  MAX_EDIT_EXPANSION_CHARS,
  required,
  type TargetedEdit,
  type AppliedEditDetail,
  type TextEditResult,
  type MatchResult,
  type Replacement,
  type MatchStrategy,
} from "./contracts.ts";
import { findMatch, toReplacement } from "./matching.ts";
import { missingEditMessage } from "./diagnostics.ts";
import { hasFinalLineEnding } from "./text.ts";
import { applyReplacements, hasOverlaps } from "./replacements.ts";

function validateEditStrings(edit: TargetedEdit, index: number): void {
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
function validateEdit(edit: TargetedEdit, index: number): void {
  validateEditStrings(edit, index);
  if (edit.all !== undefined && typeof edit.all !== "boolean") {
    throw new Error(`edits[${index}].all must be a boolean`);
  }
  const insert: unknown = edit.insert;
  if (insert !== undefined && insert !== "before" && insert !== "after") {
    throw new Error(`edits[${index}].insert must be "before" or "after"`);
  }
  validateRangeOptions(edit, index);
  validateEditChange(edit, index);
}
function validateRangeOptions(edit: TargetedEdit, index: number): void {
  if (edit.endText !== undefined && edit.all === true) {
    throw new Error(`edits[${index}].all cannot be combined with endText`);
  }
  if (edit.endText !== undefined && edit.insert !== undefined) {
    throw new Error(`edits[${index}].insert cannot be combined with endText`);
  }
}
function validateEditChange(edit: TargetedEdit, index: number): void {
  if (edit.insert !== undefined && edit.newText.length === 0) {
    throw new Error(`edits[${index}].newText must not be empty when insert is set`);
  }
  if (edit.insert === undefined && edit.endText === undefined && edit.oldText === edit.newText) {
    throw new Error(
      `edits[${index}] would make no change because oldText and newText are identical`,
    );
  }
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
function rangeMatch(
  content: string,
  edit: TargetedEdit,
  location: EditLocation,
): MatchResult | undefined {
  const startMatch = findMatch(content, {
    oldText: edit.oldText,
    newText: edit.newText,
    applyAll: false,
    maxResultLength: Number.MAX_SAFE_INTEGER,
  });
  if (startMatch === undefined) {
    return;
  }
  assertUniqueRange(startMatch, location, "oldText");
  const endText = required(edit.endText);
  const endMatch = findMatch(content, {
    oldText: endText,
    newText: "",
    applyAll: false,
    maxResultLength: Number.MAX_SAFE_INTEGER,
    field: "endText",
  });
  if (endMatch === undefined) {
    throw new Error(
      missingEditMessage(content, { ...location, oldText: endText, newText: "", field: "endText" }),
    );
  }
  assertUniqueRange(endMatch, location, "endText");
  const start = required(startMatch.replacements[0]);
  const end = required(endMatch.replacements[0]);
  if (end.matchStart < start.matchEnd) {
    throw new Error(
      `edits[${location.index}].endText must match after oldText in ${location.path} (oldText line ${start.line}, endText line ${end.line}). No changes were written.`,
    );
  }
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
function assertUnique(match: MatchResult, edit: TargetedEdit, location: EditLocation): void {
  if (edit.all === true || match.replacements.length <= 1) {
    return;
  }
  const lines = match.replacements.slice(0, 8).map((item) => item.line);
  const suffix = match.replacements.length > lines.length ? ", …" : "";
  throw new Error(
    `edits[${location.index}].oldText matched ${match.replacements.length} locations in ${location.path} (lines ${lines.join(", ")}${suffix}). Add enough surrounding text to make it unique, or set all: true only when every match should change. No changes were written.`,
  );
}
function preserveCrLf(content: string, item: Replacement, edit: TargetedEdit): Replacement {
  // Consume an unmatched CRLF half only if replacement/insertion supplies a newline.
  const joinsStart = content[item.matchStart] === "\n" && content[item.matchStart - 1] === "\r";
  const joinsEnd = content[item.matchEnd - 1] === "\r" && content[item.matchEnd] === "\n";
  const start =
    joinsStart && (edit.insert !== undefined || /^[\r\n]/.test(item.text))
      ? item.matchStart - 1
      : item.matchStart;
  const end =
    joinsEnd && (edit.insert !== undefined || hasFinalLineEnding(item.text))
      ? item.matchEnd + 1
      : item.matchEnd;
  return toReplacement({ start, end, text: item.text, line: item.line }, edit.insert);
}
function effectiveReplacements(
  content: string,
  match: MatchResult,
  edit: TargetedEdit,
  location: EditLocation,
): readonly Replacement[] {
  assertUnique(match, edit, location);
  const candidates = edit.all === true ? match.replacements : match.replacements.slice(0, 1);
  const selected = candidates.map((item) => preserveCrLf(content, item, edit));
  if (hasOverlaps(selected)) {
    throw new Error(
      `edits[${location.index}] has overlapping matches in ${location.path}. Add more surrounding text so matches do not overlap. No changes were written.`,
    );
  }
  const effective =
    edit.insert !== undefined
      ? selected
      : selected.filter((item) => content.slice(item.start, item.end) !== item.text);
  if (effective.length === 0) {
    throw new Error(
      `edits[${location.index}] already produces the requested text at its matched location in ${location.path}. No changes were written.`,
    );
  }
  return effective;
}
export function applyTargetedEdits(
  original: string,
  edits: readonly TargetedEdit[],
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
    const match =
      edit.endText === undefined
        ? findMatch(current, {
            oldText: edit.oldText,
            newText: edit.newText,
            insert: edit.insert,
            applyAll: edit.all === true,
            maxResultLength,
          })
        : rangeMatch(current, edit, location);
    if (match === undefined) {
      throw new Error(
        missingEditMessage(current, { ...location, oldText: edit.oldText, newText: edit.newText }),
      );
    }
    const effective = effectiveReplacements(current, match, edit, location);
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
    throw new Error(
      `The ordered edits cancel each other out in ${displayPath}; no changes were written.`,
    );
  }
  return { text: current, matches };
}
