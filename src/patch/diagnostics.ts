import { truncateUtf8 } from "../editing/text.ts";

interface DiagnosticScope {
  readonly start: number;
  readonly eof: boolean;
  readonly kind: "anchor" | "context";
  readonly chunk: number;
}

const scopeLabel = (scope: DiagnosticScope): string => `${scope.kind} in chunk ${scope.chunk}`;

function boundedExcerpt(lines: readonly string[], start: number, end: number): string {
  const selected = lines.slice(start, Math.min(end, start + 8));
  const pieces = selected.map((line) => truncateUtf8(line, 1_200));
  const excerpt = truncateUtf8(pieces.map((piece) => piece.text).join("\n"), 1_200);
  const truncated =
    end - start > selected.length || pieces.some((piece) => piece.truncated) || excerpt.truncated;
  return `${excerpt.text}${truncated ? "\n[Excerpt truncated.]" : ""}`;
}

function currentScope(
  source: readonly string[],
  pattern: readonly string[],
  scope: DiagnosticScope,
): string {
  const start = scope.eof ? Math.max(scope.start, source.length - pattern.length) : scope.start;
  if (start >= source.length) {
    return "\nThe original-source search scope is empty after the preceding chunk/anchor.";
  }
  const location = scope.eof ? "at the tail" : "first lines";
  return (
    `\nSearch scope: original source lines ${start + 1}-${source.length}.` +
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
// first two matches differ within three lines above them.
const LISTED_MATCHES = 4;
const LINES_ABOVE = 3;

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
  if (shared === LINES_ABOVE || first < matches.start) {
    return `Line ${candidate + 1}: nothing unique directly above it.`;
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
    currentScope(source, pattern, scope) +
    numericHeaderHint(pattern, scope) +
    "\nRe-read the scoped source and retry with current, unique context."
  );
}
