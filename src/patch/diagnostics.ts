import { MIN_SIMILARITY, diceSimilarityTo, normalizeForSimilarity } from "../editing/similarity.ts";
import { truncateUtf8 } from "../editing/text.ts";

const EXCERPT_LINES = 8;

interface DiagnosticScope {
  readonly start: number;
  readonly eof: boolean;
  readonly kind: "anchor" | "context";
  readonly chunk: number;
}

interface NearestWindow {
  readonly start: number;
  readonly end: number;
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly score: number;
}

const scopeLabel = (scope: DiagnosticScope): string => `${scope.kind} in chunk ${scope.chunk}`;

function renderExcerpt(
  lines: readonly string[],
  start: number,
  end: number,
): { readonly text: string; readonly truncated: boolean } {
  const selected = lines.slice(start, Math.min(end, start + EXCERPT_LINES));
  const pieces = selected.map((line) => truncateUtf8(line, 1_200));
  const excerpt = truncateUtf8(pieces.map((piece) => piece.text).join("\n"), 1_200);
  const truncated =
    end - start > selected.length || pieces.some((piece) => piece.truncated) || excerpt.truncated;
  return {
    text: `${excerpt.text}${truncated ? "\n[Excerpt truncated.]" : ""}`,
    truncated,
  };
}

function boundedExcerpt(lines: readonly string[], start: number, end: number): string {
  return renderExcerpt(lines, start, end).text;
}

function trimTrailingEmpty(lines: readonly string[]): readonly string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return end === lines.length ? lines : lines.slice(0, end);
}

function bestWindowInScope(
  source: readonly string[],
  scopeStart: number,
  windowLen: number,
  wanted: string,
): { readonly start: number; readonly score: number } | undefined {
  const similarity = diceSimilarityTo(wanted);
  let best: { start: number; score: number } | undefined;
  for (let start = scopeStart; start <= source.length - windowLen; start++) {
    const score = similarity(
      normalizeForSimilarity(source.slice(start, start + windowLen).join("\n")),
    );
    if (best === undefined || score > best.score) {
      best = { start, score };
    }
  }
  return best !== undefined && best.score >= MIN_SIMILARITY ? best : undefined;
}

function firstDifferingOffset(
  source: readonly string[],
  pattern: readonly string[],
  matchStart: number,
  windowLen: number,
): number {
  for (let offset = 0; offset < windowLen; offset++) {
    if (
      normalizeForSimilarity(source[matchStart + offset] ?? "") !==
      normalizeForSimilarity(pattern[offset] ?? "")
    ) {
      return offset;
    }
  }
  return 0;
}

function findNearestScopeWindow(
  source: readonly string[],
  pattern: readonly string[],
  scope: DiagnosticScope,
  fuzzyAllowed: boolean,
): NearestWindow | undefined {
  const scopeLen = source.length - scope.start;
  if (!fuzzyAllowed || scope.eof || scopeLen <= EXCERPT_LINES) {
    return undefined;
  }
  const effective = trimTrailingEmpty(pattern);
  const wanted = normalizeForSimilarity(effective.join("\n"));
  if (wanted.length === 0) {
    return undefined;
  }
  const windowLen = Math.min(effective.length, scopeLen);
  const best = bestWindowInScope(source, scope.start, windowLen, wanted);
  if (best === undefined) {
    return undefined;
  }
  const matchStart = best.start;
  const matchEnd = matchStart + windowLen;
  if (windowLen <= EXCERPT_LINES) {
    return { start: matchStart, end: matchEnd, matchStart, matchEnd, score: best.score };
  }
  const diff = firstDifferingOffset(source, effective, matchStart, windowLen);
  const start = matchStart + Math.max(0, Math.min(diff - 2, windowLen - EXCERPT_LINES));
  return { start, end: start + EXCERPT_LINES, matchStart, matchEnd, score: best.score };
}

function currentScope(
  source: readonly string[],
  pattern: readonly string[],
  scope: DiagnosticScope,
  fuzzyAllowed: boolean,
): string {
  const start = scope.eof ? Math.max(scope.start, source.length - pattern.length) : scope.start;
  if (start >= source.length) {
    return "\nThe original-source search scope is empty after the preceding chunk/anchor.";
  }
  const header = `\nSearch scope: original source lines ${start + 1}-${source.length}.`;
  const nearest = findNearestScopeWindow(source, pattern, scope, fuzzyAllowed);
  if (nearest !== undefined) {
    const excerpt = renderExcerpt(source, nearest.start, nearest.end);
    const partial =
      !excerpt.truncated && nearest.matchEnd - nearest.matchStart > nearest.end - nearest.start
        ? `\n[Showing lines ${nearest.start + 1}-${nearest.end} of matched lines ${nearest.matchStart + 1}-${nearest.matchEnd}.]`
        : "";
    return (
      header +
      `\nClosest match in scope (lines ${nearest.start + 1}-${nearest.end}, ${Math.round(nearest.score * 100)}% similar):\n` +
      excerpt.text +
      partial
    );
  }
  const location = scope.eof ? "at the tail" : "first lines";
  return (
    header +
    `\nCurrent scoped context (${location}):\n${boundedExcerpt(source, start, source.length)}`
  );
}

function numericHeaderHint(pattern: readonly string[], scope: DiagnosticScope): string {
  const anchor = pattern[0] ?? "";
  if (
    scope.kind !== "anchor" ||
    pattern.length !== 1 ||
    anchor.length > 1_200 ||
    !/^-\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.test(anchor)
  ) {
    return "";
  }
  return (
    "\nThis looks like a unified-diff numeric @@ header. Numeric hunk headers are not supported: " +
    "use bare @@ or @@ followed by a literal source line."
  );
}

// Measured on 278 real ambiguous refusals: 80% match at most four places, and in 93% the
// first two matches differ within three lines above them. Repeated fixtures can share more,
// so the hint reaches as far as one excerpt can show.
const LISTED_MATCHES = 4;
const LINES_ABOVE = 8;

interface AmbiguousMatches {
  readonly source: readonly string[];
  /** Zero-based first lines of every match, ascending. */
  readonly candidates: readonly number[];
  readonly start: number;
  readonly normalize: (line: string) => string;
}

/** Counts the in-scope lines directly above two matches that are the same, up to the limit. */
function sharedLinesAbove(matches: AmbiguousMatches, first: number, second: number): number {
  const { source, start, normalize } = matches;
  let shared = 0;
  while (shared < LINES_ABOVE) {
    const above = first - shared - 1;
    const otherAbove = second - shared - 1;
    if (
      above < start ||
      otherAbove < start ||
      normalize(source[above] ?? "") !== normalize(source[otherAbove] ?? "")
    ) {
      break;
    }
    shared++;
  }
  return shared;
}

/** The fewest lines above a match that, added to the context, leave it as the only match. */
function uniqueLinesAbove(matches: AmbiguousMatches, candidate: number): string {
  let shared = 0;
  for (const other of matches.candidates) {
    if (shared === LINES_ABOVE) {
      break;
    }
    if (other !== candidate) {
      shared = Math.max(shared, sharedLinesAbove(matches, candidate, other));
    }
  }
  const first = candidate - shared - 1;
  if (first < matches.start) {
    return `Line ${candidate + 1}: nothing unique above it inside the search scope (original source lines ${matches.start + 1}-${matches.source.length}).`;
  }
  if (shared === LINES_ABOVE) {
    return `Line ${candidate + 1}: nothing unique within ${LINES_ABOVE} lines above it.`;
  }
  const range = shared === 0 ? `line ${candidate}` : `lines ${first + 1}-${candidate}`;
  return `Above line ${candidate + 1} (${range}):\n${boundedExcerpt(matches.source, first, candidate)}`;
}

/** Failure evidence only: names the matches and never selects one. */
export function ambiguousPatchMessage(
  source: readonly string[],
  candidates: readonly number[],
  scope: DiagnosticScope,
  normalize: (line: string) => string,
): string {
  const listed = candidates.slice(0, LISTED_MATCHES);
  const more = candidates.length - listed.length;
  const header = `Ambiguous ${scopeLabel(scope)}: matches at lines ${listed.map((line) => line + 1).join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
  if (scope.kind === "anchor") {
    return `${header} Add unique anchors or surrounding context.`;
  }
  const matches = { source, candidates, start: scope.start, normalize };
  return (
    `${header} It must match exactly one place in the rest of the file. ` +
    `Lines above each match that make it unique:\n` +
    `${listed.map((candidate) => uniqueLinesAbove(matches, candidate)).join("\n")}\n` +
    "Add the lines shown for the place you mean as context at the start of the chunk, " +
    "or add context below it. No changes were written."
  );
}

/** Failure evidence only: never selects a replacement or widens the original-source scope. */
export function missingPatchMessage(
  source: readonly string[],
  pattern: readonly string[],
  scope: DiagnosticScope,
  fuzzyAllowed: boolean,
): string {
  const location = scope.eof ? " at end of file" : " after the preceding chunk/anchor";
  const budget = fuzzyAllowed
    ? ""
    : " Corrected matching exceeded its work budget; use exact context.";
  return (
    `Could not find ${scopeLabel(scope)}${location}.${budget}` +
    `\nRequested text:\n${boundedExcerpt(pattern, 0, pattern.length)}` +
    currentScope(source, pattern, scope, fuzzyAllowed) +
    numericHeaderHint(pattern, scope) +
    "\nRe-read the scoped source and retry with current, unique context."
  );
}
