import {
  MAX_REPLACEMENTS,
  type EditSearch,
  type MatchResult,
  type Replacement,
  type InsertPosition,
  required,
} from "./contracts.ts";
import { indentationSignature, reindentReplacement } from "./indentation.ts";
import {
  countTextLines,
  findOccurrences,
  splitLines,
  uniformLineEnding,
  convertLineEndings,
  lineNumbersAt,
  lineEndingsAt,
  normalizeLine,
  hasFinalLineEnding,
  detectLineEnding,
  type LineEnding,
  type TextLine,
} from "./text.ts";
import { throwExpansionError } from "./replacements.ts";

export function toReplacement(
  range: {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly line: number;
  },
  insert?: InsertPosition,
): Replacement {
  const { start, end, text, line } = range;
  if (insert === "before") {
    return { start, end: start, matchStart: start, matchEnd: end, text, line };
  }
  if (insert === "after") {
    return { start: end, end, matchStart: start, matchEnd: end, text, line };
  }
  return { start, end, matchStart: start, matchEnd: end, text, line };
}
function convertedReplacements(text: string): (ending: LineEnding) => string {
  const cache = new Map<LineEnding, string>();
  return (ending) => {
    const prior = cache.get(ending);
    if (prior !== undefined) {
      return prior;
    }
    const converted = convertLineEndings(text, ending);
    cache.set(ending, converted);
    return converted;
  };
}
function assertMatchCount(count: number, field: string, corrected = false): void {
  if (count > MAX_REPLACEMENTS) {
    throw new Error(
      `${corrected ? "Corrected " : ""}${field} matched more than ${MAX_REPLACEMENTS.toLocaleString()} locations. Add surrounding context instead. No changes were written.`,
    );
  }
}
function exactMatches(content: string, search: EditSearch): Replacement[] {
  let matched = search.oldText;
  let offsets = findOccurrences(content, matched, MAX_REPLACEMENTS + 1);
  if (offsets.length === 0) {
    const ending = uniformLineEnding(content);
    const converted = ending === undefined ? matched : convertLineEndings(matched, ending);
    if (converted !== matched) {
      matched = converted;
      offsets = findOccurrences(content, matched, MAX_REPLACEMENTS + 1);
    }
  }
  assertMatchCount(offsets.length, search.field ?? "oldText");
  const lines = lineNumbersAt(content, offsets);
  const endings = lineEndingsAt(content, offsets);
  const replacement = convertedReplacements(search.newText);
  return offsets.map((start, index) =>
    toReplacement(
      {
        start,
        end: start + matched.length,
        text: replacement(endings[index] ?? "\n"),
        line: lines[index] ?? 1,
      },
      search.insert,
    ),
  );
}
export function findMatch(content: string, search: EditSearch): MatchResult | undefined {
  const exact = exactMatches(content, search);
  if (exact.length > 0) {
    return { strategy: "exact", replacements: exact };
  }
  const normalized = lineBlockMatches(content, search, false);
  if (normalized.length > 0) {
    return { strategy: "normalized", replacements: normalized };
  }
  const indentation = lineBlockMatches(content, search, true);
  if (indentation.length > 0) {
    return { strategy: "indent-normalized", replacements: indentation };
  }
  return;
}
function searchableLines(
  content: string,
  search: string,
): { readonly content: readonly TextLine[]; readonly search: readonly TextLine[] } | undefined {
  if (Buffer.byteLength(search) > 64 * 1024) {
    return;
  }
  const searchLines = splitLines(search);
  if (searchLines.length === 0 || searchLines.length > 200) {
    return;
  }
  if (
    content.length > 1_000_000 ||
    countTextLines(content) > 50_000 ||
    content.length * searchLines.length > 2_000_000
  ) {
    return;
  }
  const contentLines = splitLines(content);
  if (contentLines.length >= searchLines.length) {
    return { content: contentLines, search: searchLines };
  }
  return;
}
interface BlockSearch {
  readonly lines: readonly TextLine[];
  readonly size: number;
  readonly signature: readonly string[];
  readonly normalized?: readonly string[];
  readonly bodies: readonly string[];
  readonly includeFinalEnding: boolean;
  readonly fallbackEnding: LineEnding;
  readonly search: EditSearch;
  readonly replacement: (ending: LineEnding) => string;
}
function matchWindow(block: BlockSearch, start: number): Replacement | undefined {
  const window = block.lines.slice(start, start + block.size);
  if (block.includeFinalEnding && window.at(-1)?.ending === "") {
    return;
  }
  const bodies = window.map((line) => line.body);
  const signature =
    block.normalized === undefined
      ? indentationSignature(bodies)
      : block.normalized.slice(start, start + block.size);
  if (!block.signature.every((value, index) => value === signature[index])) {
    return;
  }
  return windowReplacement(block, window);
}
function windowReplacement(block: BlockSearch, window: readonly TextLine[]): Replacement {
  const first = required(window[0]);
  const last = required(window.at(-1));
  const ending = window.find((line) => line.ending !== "")?.ending;
  const local = block.replacement(
    ending === undefined || ending === "" ? block.fallbackEnding : ending,
  );
  const text =
    block.search.insert !== undefined || block.normalized !== undefined
      ? local
      : reindentReplacement(
          local,
          block.bodies,
          window.map((line) => line.body),
        );
  return toReplacement(
    {
      start: first.start,
      end: block.includeFinalEnding ? last.end : last.bodyEnd,
      text,
      line: first.number,
    },
    block.search.insert,
  );
}
function lineBlockMatches(
  content: string,
  search: EditSearch,
  ignoreBaseIndent: boolean,
): Replacement[] {
  const lines = searchableLines(content, search.oldText);
  if (lines === undefined) {
    return [];
  }
  const block = prepareBlockSearch(content, search, ignoreBaseIndent, lines);
  return collectBlockMatches(content, search, block);
}
function prepareBlockSearch(
  content: string,
  search: EditSearch,
  ignoreBaseIndent: boolean,
  lines: { readonly content: readonly TextLine[]; readonly search: readonly TextLine[] },
): BlockSearch {
  const bodies = lines.search.map((line) => line.body);
  const block: BlockSearch = {
    lines: lines.content,
    size: lines.search.length,
    bodies,
    signature: ignoreBaseIndent ? indentationSignature(bodies) : bodies.map(normalizeLine),
    normalized: ignoreBaseIndent
      ? undefined
      : lines.content.map((line) => normalizeLine(line.body)),
    includeFinalEnding: hasFinalLineEnding(search.oldText),
    fallbackEnding: detectLineEnding(content),
    search,
    replacement: convertedReplacements(search.newText),
  };
  return block;
}
function projectedSize(
  contentLength: number,
  projectedLength: number,
  match: Replacement,
  search: EditSearch,
): number {
  const next =
    projectedLength +
    match.text.length -
    (search.insert === undefined ? match.matchEnd - match.matchStart : 0);
  const remainingShrink =
    search.applyAll && search.insert === undefined ? contentLength - match.matchEnd : 0;
  if (next - remainingShrink > search.maxResultLength) {
    throwExpansionError();
  }
  return next;
}
function collectBlockMatches(
  content: string,
  search: EditSearch,
  block: BlockSearch,
): Replacement[] {
  const matches: Replacement[] = [];
  let projectedLength = content.length;
  for (let start = 0; start <= block.lines.length - block.size; start++) {
    const match = matchWindow(block, start);
    if (match === undefined) {
      continue;
    }
    if (search.applyAll || matches.length === 0) {
      projectedLength = projectedSize(content.length, projectedLength, match, search);
    }
    matches.push(match);
    assertMatchCount(matches.length, search.field ?? "oldText", true);
  }
  return matches;
}
