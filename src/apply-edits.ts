import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  captureSnapshot,
  publishNewFile,
  publishReplacement,
  throwIfAborted,
} from "./file-system.ts";

export interface TargetedEdit {
  oldText: string;
  newText: string;
  all?: boolean;
}

export interface ApplyEditsInput {
  path: string;
  edits?: TargetedEdit[];
  rewrite?: string;
  onMissing?: "error" | "create";
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
  addedLines: number;
  deletedLines: number;
  diff: string;
  diffTruncated: boolean;
  warnings: string[];
}

export interface ApplyEditsExecution {
  summary: string;
  details: ApplyEditsDetails;
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
  start: number;
  end: number;
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

  const literal = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  let transformed = input;
  if (transformed === "~") transformed = homedir();
  else if (
    transformed.startsWith("~/") ||
    (process.platform === "win32" && transformed.startsWith("~\\"))
  ) {
    transformed = join(homedir(), transformed.slice(2));
  }
  if (transformed.startsWith("file://")) {
    try {
      transformed = fileURLToPath(transformed);
    } catch (error) {
      if (pathExists(literal)) return literal;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid file URL path ${input}: ${reason}`);
    }
  }
  transformed = isAbsolute(transformed) ? resolve(transformed) : resolve(cwd, transformed);
  if (literal === transformed) return literal;

  const literalExists = pathExists(literal);
  const transformedExists = pathExists(transformed);
  if (literalExists && transformedExists) {
    throw new Error(`Ambiguous path: both ${literal} and ${transformed} exist. Use an explicit absolute path.`);
  }
  return literalExists ? literal : transformed;
}

export function applyTargetedEdits(
  original: string,
  edits: TargetedEdit[],
  displayPath: string,
): TextEditResult {
  if (edits.length === 0) throw new Error("edits must contain at least one replacement");

  const lineEnding = detectLineEnding(original);
  let current = original;
  const matches: AppliedEditDetail[] = [];

  for (const [index, edit] of edits.entries()) {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      throw new Error(`edits[${index}] must contain string oldText and newText fields`);
    }
    const oldText = convertLineEndings(stripBomCharacter(edit.oldText), lineEnding);
    const newText = convertLineEndings(edit.newText, lineEnding);
    if (oldText.length === 0) {
      throw new Error(`edits[${index}].oldText must not be empty`);
    }
    if (oldText.includes("\0") || newText.includes("\0")) {
      throw new Error(`edits[${index}] cannot read or write NUL bytes`);
    }
    if (hasUnpairedSurrogate(oldText) || hasUnpairedSurrogate(newText)) {
      throw new Error(`edits[${index}] must contain valid Unicode text`);
    }
    if (oldText === newText) {
      throw new Error(`edits[${index}] would make no change because oldText and newText are identical`);
    }

    const match = findMatch(current, oldText, newText);
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

    const selected = edit.all ? match.replacements : match.replacements.slice(0, 1);
    if (hasOverlaps(selected)) {
      throw new Error(
        `edits[${index}] has overlapping normalized matches in ${displayPath}. ` +
          "Add more surrounding text so matches do not overlap. No changes were written.",
      );
    }
    const effective = selected.filter((item) => current.slice(item.start, item.end) !== item.text);
    if (effective.length === 0) {
      throw new Error(
        `edits[${index}] already produces the requested text at its matched location in ${displayPath}. ` +
          "No changes were written.",
      );
    }

    current = applyReplacements(current, effective);
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
  input: ApplyEditsInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<ApplyEditsExecution> {
  validateInput(input);
  const inputPath = resolveInputPath(input.path, cwd);

  return withFileMutationQueue(inputPath, async () => {
    throwIfAborted(signal);
    let snapshot = await captureSnapshot(inputPath);
    const displayPath = displayPathFor(inputPath, cwd);

    if (!snapshot && input.edits) {
      throw new Error(
        `Cannot edit missing file ${displayPath}. Use rewrite with onMissing: "create" to create it.`,
      );
    }
    if (!snapshot && input.onMissing !== "create") {
      throw new Error(
        `File does not exist: ${displayPath}. Set onMissing: "create" with rewrite to create it.`,
      );
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
      nextText = `${hadBom ? "\uFEFF" : ""}${stripBomCharacter(result.text)}`;
      matches = result.matches;
      operation = "edit";
    } else {
      const rewrite = input.rewrite ?? "";
      const body = snapshot ? convertLineEndings(rewrite, detectLineEnding(originalBody)) : rewrite;
      nextText = `${snapshot && hadBom && !body.startsWith("\uFEFF") ? "\uFEFF" : ""}${body}`;
      operation = snapshot ? "rewrite" : "create";
    }

    const nextBytes = Buffer.from(nextText, "utf8");
    if (snapshot && nextBytes.equals(snapshot.bytes)) {
      const details = buildDetails(
        displayPath,
        "no_change",
        input.edits?.length ?? 1,
        0,
        matches,
        originalText,
        nextText,
        [],
      );
      return {
        summary: `No change: ${displayPath} already matches the requested content.`,
        details,
      };
    }

    throwIfAborted(signal);
    const editsApplied = input.edits?.length ?? 1;
    const details = buildDetails(
      displayPath,
      operation,
      editsApplied,
      editsApplied,
      matches,
      originalText,
      nextText,
      [],
    );
    throwIfAborted(signal);
    const warnings = snapshot
      ? await publishReplacement(snapshot, nextBytes, signal)
      : await publishNewFile(inputPath, nextBytes, signal);
    details.warnings.push(...warnings);
    const corrected = matches.filter((item) => item.strategy !== "exact").length;
    const counts = details.addedLines + details.deletedLines > 0
      ? ` (+${details.addedLines}/-${details.deletedLines})`
      : "";
    const correction = corrected > 0
      ? `; ${corrected} edit${corrected === 1 ? "" : "s"} matched safely after normalization`
      : "";
    const warningText = warnings.length > 0 ? ` Warning: ${warnings.join(" ")}` : "";
    const verb = operation === "create" ? "Created" : operation === "rewrite" ? "Rewrote" : "Edited";
    const unit = input.edits ? `${editsApplied} ordered edit${editsApplied === 1 ? "" : "s"}` : "full content";

    return {
      summary: `${verb} ${displayPath}: ${unit}${counts}${correction}.${warningText}`,
      details,
    };
  });
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
  if (hasRewrite && input.rewrite?.includes("\0")) throw new Error("rewrite cannot contain NUL bytes");
  if (hasRewrite && input.rewrite && hasUnpairedSurrogate(input.rewrite)) {
    throw new Error("rewrite must contain valid Unicode text");
  }
  if (hasEdits && input.onMissing !== undefined) {
    throw new Error("onMissing is valid only with rewrite");
  }
  if (input.onMissing !== undefined && input.onMissing !== "error" && input.onMissing !== "create") {
    throw new Error('onMissing must be either "error" or "create"');
  }
}

function findMatch(content: string, oldText: string, newText: string): MatchResult | undefined {
  const exactOffsets = findOccurrences(content, oldText, MAX_REPLACEMENTS + 1);
  if (exactOffsets.length > MAX_REPLACEMENTS) {
    throw new Error(
      `oldText matched more than ${MAX_REPLACEMENTS.toLocaleString()} locations. ` +
        `Add surrounding context instead. No changes were written.`,
    );
  }
  const exactLines = lineNumbersAt(content, exactOffsets);
  const exact = exactOffsets.map((start, index) => ({
    start,
    end: start + oldText.length,
    text: newText,
    line: exactLines[index] ?? 1,
  }));
  if (exact.length > 0) return { strategy: "exact", replacements: exact };

  const normalized = findLineBlockMatches(content, oldText, newText, false);
  if (normalized.length > 0) return { strategy: "normalized", replacements: normalized };

  const indentation = findLineBlockMatches(content, oldText, newText, true);
  if (indentation.length > 0) return { strategy: "indent-normalized", replacements: indentation };

  return undefined;
}

function findOccurrences(content: string, search: string, limit = Number.POSITIVE_INFINITY): number[] {
  const offsets: number[] = [];
  let from = 0;
  while (from <= content.length - search.length && offsets.length < limit) {
    const index = content.indexOf(search, from);
    if (index < 0) break;
    offsets.push(index);
    from = index + search.length;
  }
  return offsets;
}

function findLineBlockMatches(
  content: string,
  search: string,
  replacement: string,
  ignoreBaseIndent: boolean,
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

  const searchBodies = searchLines.map((line) => line.body);
  const searchSignature = ignoreBaseIndent
    ? indentationSignature(searchBodies)
    : searchBodies.map(normalizeLine);
  const normalizedContent = ignoreBaseIndent
    ? undefined
    : contentLines.map((line) => normalizeLine(line.body));
  const includeFinalEnding = hasFinalLineEnding(search);
  const matches: Replacement[] = [];

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
    const text = ignoreBaseIndent
      ? reindentReplacement(replacement, baseIndent(bodies))
      : replacement;
    matches.push({
      start: first.start,
      end: includeFinalEnding ? last.end : last.bodyEnd,
      text,
      line: first.number,
    });
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

function baseIndent(lines: string[]): string {
  const candidates = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => leadingWhitespace(line));
  if (candidates.length === 0) return "";
  return candidates.reduce((best, value) =>
    indentationWidth(value) < indentationWidth(best) ? value : best,
  );
}

function reindentReplacement(replacement: string, indent: string): string {
  const lines = splitLines(replacement);
  if (lines.length === 0) return replacement;
  const common = minimumIndentWidth(lines.map((line) => line.body));
  return lines
    .map((line) => {
      if (line.body.trim().length === 0) return line.ending;
      return `${indent}${removeIndentWidth(line.body, common)}${line.ending}`;
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

function removeIndentWidth(line: string, width: number): string {
  let consumed = 0;
  let index = 0;
  while (index < line.length && consumed < width) {
    const char = line[index];
    if (char !== " " && char !== "\t") break;
    const next = char === "\t" ? consumed + (4 - (consumed % 4)) : consumed + 1;
    index++;
    if (next > width) return `${" ".repeat(next - width)}${line.slice(index)}`;
    consumed = next;
  }
  return line.slice(index);
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
  const ordered = [...replacements].sort((left, right) => left.start - right.start);
  return ordered.some((item, index) => index > 0 && item.start < ordered[index - 1]!.end);
}

function applyReplacements(content: string, replacements: Replacement[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of [...replacements].sort((left, right) => left.start - right.start)) {
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
    : "\nRe-read the target area and retry with the current text.";
  return `Could not find edits[${index}].oldText in ${path}.${alreadyPresent}${hint}\nNo changes were written.`;
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

function stripBomCharacter(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
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
    body = new TextDecoder("utf-8", { fatal: true }).decode(content);
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
    ? { addedLines: 0, deletedLines: 0 }
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

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

function displayPathFor(path: string, cwd: string): string {
  const candidate = relative(cwd, path);
  const outside = candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate);
  return (outside ? path : candidate || ".").split(sep).join("/");
}

