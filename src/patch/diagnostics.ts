import { truncateUtf8 } from "../editing/text.ts";

interface DiagnosticScope {
  readonly start: number;
  readonly eof: boolean;
  readonly label: string;
}

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
    !scope.label.startsWith("anchor") ||
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
    `Could not find ${scope.label}${location}.${budget}` +
    `\nRequested text:\n${boundedExcerpt(pattern, 0, pattern.length)}` +
    currentScope(source, pattern, scope) +
    numericHeaderHint(pattern, scope) +
    "\nRe-read the scoped source and retry with current, unique context."
  );
}
