// Adapted from OpenAI Codex's apply-patch parser, seek_sequence and file_update.
// Copyright 2025 OpenAI. Apache-2.0; see LICENSE-codex.
// Source: rust-v0.155.1, 4e21628f9ec9ee656650cd2b62ef92225725b5ac.
// This TypeScript port uses strict envelopes, literal paths, stacked anchors,
// unique suffix matches, anchored insertion, and byte-preserving reconstruction.
import { isAbsolute, resolve } from "node:path";

export const PATCH_GRAMMAR = String.raw`start: "*** Begin Patch" NL operation+ "*** End Patch" NL?
operation: add | delete | update
add: "*** Add File: " PATH NL add_line*
delete: "*** Delete File: " PATH NL
update: "*** Update File: " PATH NL (move change? | change)
move: "*** Move to: " PATH NL
change: (change_line+ chunk* | chunk+) eof?
chunk: anchor+ change_line+
anchor: ("@@" | "@@ " PATH) NL
add_line: "+" TEXT? NL
change_line: ("+" | "-" | " ") TEXT? NL
eof: "*** End of File" NL
PATH: /[^\r\n\x00]+/
TEXT: /[^\r\n\x00]+/
NL: /\r\n|\n|\r/
`;

export interface PatchChunk {
  anchors: string[];
  lines: Array<{ kind: "context" | "add" | "delete"; text: string }>;
  endOfFile: boolean;
}

export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: PatchChunk[] };

type MatchStrategy = "exact" | "whitespace" | "typography";
type PatchMatch = { line: number; strategy: MatchStrategy };
type SourceLine = { text: string; ending: string; start: number; end: number };

const MAX_FILES = 64;
const MAX_CHUNKS = 100;
const MAX_EXPANSION = 8 * 1024 * 1024;
// Same corrected-match limits as targeted edits; exact matching has no size ceiling.
const FUZZY_PATTERN_BYTES = 64 * 1024;
const FUZZY_PATTERN_LINES = 200;
const FUZZY_CONTENT_CHARS = 1_000_000;
const FUZZY_CONTENT_LINES = 50_000;
const FUZZY_WORK = 2_000_000;

function validateText(text: string, label: string): void {
  if (typeof text !== "string") throw new Error(`${label} must be a string`);
  if (text.includes("\0")) throw new Error(`${label} cannot contain NUL bytes`);
  if (!text.isWellFormed()) throw new Error(`${label} must contain valid Unicode text`);
}

function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    const end = match.index + match[0].length;
    lines.push({ text: text.slice(start, match.index), ending: match[0], start, end });
    start = end;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: "", start, end: text.length });
  return lines;
}

/** Path spans are UTF-16 offsets into the untouched input, excluding header syntax/EOL. */
export function parsePatch(input: string): {
  operations: PatchOperation[];
  paths: Array<{ start: number; end: number; path: string }>;
} {
  validateText(input, "Patch");
  const lines = splitLines(input);
  if (lines[0]?.text !== "*** Begin Patch" || lines.at(-1)?.text !== "*** End Patch") {
    throw new Error("Patch must start with '*** Begin Patch' and end with '*** End Patch'");
  }
  const operations: PatchOperation[] = [];
  const paths: Array<{ start: number; end: number; path: string }> = [];
  let index = 1;
  const fail = (message: string): never => { throw new Error(`Invalid patch at line ${index + 1}: ${message}`); };
  const readPath = (prefix: string): string => {
    const line = lines[index]!;
    const path = line.text.slice(prefix.length);
    if (!path) fail("path must be non-empty");
    paths.push({ start: line.start + prefix.length, end: line.end - line.ending.length, path });
    index++;
    return path;
  };
  const isBoundary = () => lines[index]?.text.startsWith("*** ") && lines[index]?.text !== "*** End of File";

  while (index < lines.length - 1) {
    if (operations.length >= MAX_FILES) fail(`patch cannot contain more than ${MAX_FILES} file operations`);
    const header = lines[index]!.text;
    if (header.startsWith("*** Add File: ")) {
      const path = readPath("*** Add File: ");
      const content: string[] = [];
      while (index < lines.length - 1 && !isBoundary()) {
        const line = lines[index]!;
        if (!line.text.startsWith("+")) fail("Add File lines must start with '+'");
        content.push(line.text.slice(1), line.ending);
        index++;
      }
      operations.push({ kind: "add", path, content: content.join("") });
    } else if (header.startsWith("*** Delete File: ")) {
      operations.push({ kind: "delete", path: readPath("*** Delete File: ") });
    } else if (header.startsWith("*** Update File: ")) {
      const operation: Extract<PatchOperation, { kind: "update" }> = {
        kind: "update", path: readPath("*** Update File: "), chunks: [],
      };
      if (lines[index]?.text.startsWith("*** Move to: ")) operation.moveTo = readPath("*** Move to: ");
      let chunk: PatchChunk | undefined;
      while (index < lines.length - 1 && !isBoundary()) {
        const text = lines[index]!.text;
        if (chunk?.endOfFile) fail("End of File must be the last line of an update");
        if (text === "*** End of File") {
          if (!chunk?.lines.length) fail("End of File requires a non-empty chunk");
          chunk!.endOfFile = true;
        } else {
          const anchor = text === "@@" || text.startsWith("@@ ");
          if (!chunk || (anchor && chunk.lines.length > 0)) {
            if (operation.chunks.length >= MAX_CHUNKS) fail(`update cannot contain more than ${MAX_CHUNKS} chunks`);
            chunk = { anchors: [], lines: [], endOfFile: false };
            operation.chunks.push(chunk);
          }
          if (anchor) {
            if (text !== "@@") {
              if (text.length === 3) fail("named @@ anchor must be non-empty");
              chunk.anchors.push(text.slice(3));
            }
          } else {
            const kind = text[0] === "+" ? "add" : text[0] === "-" ? "delete" : text[0] === " " ? "context" : undefined;
            if (!kind) fail("update lines must start with ' ', '+', '-', or '@@'");
            chunk.lines.push({ kind: kind!, text: text.slice(1) });
          }
        }
        index++;
      }
      if (chunk && chunk.lines.length === 0) fail("update chunk must contain lines after its anchors");
      if (!operation.chunks.length && operation.moveTo === undefined) fail("Update File requires changes or Move to");
      operations.push(operation);
    } else {
      fail("expected Add File, Delete File, or Update File header");
    }
  }
  if (!operations.length) throw new Error("Patch must contain at least one file operation");
  return { operations, paths };
}

/** Bind only parsed header values; body text and absolute path spellings are unchanged. */
export function bindPatchPaths(input: string, cwd: string): string {
  const { paths } = parsePatch(input);
  validateText(cwd, "cwd");
  if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
  let result = input;
  for (let index = paths.length - 1; index >= 0; index--) {
    const span = paths[index]!;
    if (!isAbsolute(span.path)) {
      result = result.slice(0, span.start) + resolve(cwd, span.path) + result.slice(span.end);
    }
  }
  return result;
}

const trimEnd = (text: string) => text.replace(/\p{White_Space}+$/u, "");
const trim = (text: string) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
function typography(text: string): string {
  return trim(text)
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

/** KMP keeps even repeated, long exact context linear; collect only enough to prove ambiguity. */
function occurrences(source: string[], pattern: string[], start: number, eof: boolean): number[] {
  const prefix = new Uint32Array(pattern.length);
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j > 0 && pattern[i] !== pattern[j]) j = prefix[j - 1]!;
    if (pattern[i] === pattern[j]) j++;
    prefix[i] = j;
  }
  const found: number[] = [];
  for (let i = eof ? Math.max(start, source.length - pattern.length) : start, j = 0; i < source.length; i++) {
    while (j > 0 && source[i] !== pattern[j]) j = prefix[j - 1]!;
    if (source[i] === pattern[j]) j++;
    if (j === pattern.length) {
      found.push(i - pattern.length + 1);
      if (found.length === 2) break;
      j = prefix[j - 1]!;
    }
  }
  return found;
}

function findMatch(
  source: string[], pattern: string[], start: number, eof: boolean, scopedChars: number, label: string,
): PatchMatch {
  const passes: Array<{ normalize: (text: string) => string; strategy: MatchStrategy }> = [
    { normalize: (text) => text, strategy: "exact" },
    { normalize: trimEnd, strategy: "whitespace" },
    { normalize: trim, strategy: "whitespace" },
    { normalize: typography, strategy: "typography" },
  ];
  const fuzzyAllowed = pattern.length <= FUZZY_PATTERN_LINES &&
    Buffer.byteLength(pattern.join("\n")) <= FUZZY_PATTERN_BYTES &&
    source.length - start <= FUZZY_CONTENT_LINES && scopedChars <= FUZZY_CONTENT_CHARS &&
    scopedChars * pattern.length <= FUZZY_WORK;
  for (const { normalize, strategy } of passes) {
    if (strategy !== "exact" && !fuzzyAllowed) break;
    const candidates = strategy === "exact"
      ? occurrences(source, pattern, start, eof)
      : occurrences(source.slice(start).map(normalize), pattern.map(normalize), 0, eof).map((line) => line + start);
    if (candidates.length > 1) {
      throw new Error(`Ambiguous ${label}: matches at lines ${candidates.map((line) => line + 1).join(", ")}. Add unique anchors or surrounding context.`);
    }
    if (candidates.length === 1) return { line: candidates[0]! + 1, strategy };
  }
  throw new Error(`Could not find ${label}${eof ? " at end of file" : " after the preceding chunk/anchor"}.${fuzzyAllowed ? "" : " Corrected matching exceeded its work budget; use exact context."}`);
}

/**
 * Each anchor must be unique in the remaining source suffix, and advances the
 * scope strictly past its line. The old/context block must then be unique in
 * that suffix. EOF restricts it to the actual tail. No language scopes are inferred.
 * Chunks refer to the original source in order; their consumed blocks cannot overlap.
 * Matches include each named anchor and each chunk (1-based original source lines).
 */
export function applyPatchUpdate(
  original: string, operation: Extract<PatchOperation, { kind: "update" }>,
): { text: string; matches: PatchMatch[] } {
  validateText(original, "Original text");
  if (operation.chunks.length > MAX_CHUNKS) throw new Error(`update cannot contain more than ${MAX_CHUNKS} chunks`);
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = original.slice(bom.length);
  const lines = splitLines(body);
  const source = lines.map((line) => line.text);
  const matches: PatchMatch[] = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  let projectedLength = body.length;
  const offsetAt = (line: number) => lines[line]?.start ?? body.length;
  const match = (pattern: string[], eof: boolean, label: string) =>
    findMatch(source, pattern, cursor, eof, body.length - offsetAt(cursor), label);
  const replace = (start: number, end: number, added: string[]) => {
    if (start === end && added.length === 0) return;
    // Replacements use the removed line's EOL; insertions prefer the preceding
    // line. Only the final source line can lack an ending.
    const ending = (end > start ? lines[start]?.ending : "") || lines[start - 1]?.ending ||
      lines[start]?.ending || lines[start - 2]?.ending || "\n";
    const parts: string[] = [];
    // Appending to an unterminated line needs a separator, never a text concatenation.
    if (start === lines.length && start > 0 && !lines[start - 1]!.ending && added.length &&
      replacements.at(-1)?.end !== body.length) parts.push(ending);
    for (let i = 0; i < added.length; i++) {
      parts.push(added[i]!, i < end - start ? lines[start + i]!.ending || ending : ending);
    }
    const text = parts.join("");
    const startOffset = offsetAt(start);
    const endOffset = offsetAt(end);
    projectedLength += text.length - (endOffset - startOffset);
    if (projectedLength > body.length + MAX_EXPANSION) throw new Error("Patch would expand the file by more than 8 MiB; use a whole-file write or smaller patches");
    replacements.push({ start: startOffset, end: endOffset, text });
  };

  for (const [index, chunk] of operation.chunks.entries()) {
    for (const anchor of chunk.anchors) {
      const found = match([anchor], false, `anchor in chunk ${index + 1}`);
      matches.push(found);
      cursor = found.line;
    }
    const old = chunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    let start: number;
    if (old.length) {
      const found = match(old, chunk.endOfFile, `context in chunk ${index + 1}`);
      matches.push(found);
      start = found.line - 1;
    } else {
      start = chunk.anchors.length > 0 && !chunk.endOfFile ? cursor : lines.length;
      matches.push({ line: start + 1, strategy: "exact" });
    }
    let position = start;
    let runStart = start;
    let added: string[] = [];
    for (const line of chunk.lines) {
      if (line.kind === "context") {
        replace(runStart, position, added);
        position++;
        runStart = position;
        added = [];
      } else if (line.kind === "delete") {
        position++;
      } else {
        added.push(line.text);
      }
    }
    replace(runStart, position, added);
    cursor = position;
  }

  const result: string[] = [];
  let offset = 0;
  for (const replacement of replacements) {
    result.push(body.slice(offset, replacement.start), replacement.text);
    offset = replacement.end;
  }
  result.push(body.slice(offset));
  let text = result.join("");
  // Preserve the terminal-newline state, including tail deletion and append.
  // The terminal separator is the only retained line ending this may remove.
  if (body.length > 0 && lines.at(-1)?.ending === "") text = text.replace(/(?:\r\n|\n|\r)$/, "");
  return { text: bom + text, matches };
}
