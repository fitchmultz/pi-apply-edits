import {
  findOccurrences,
  lineNumbersAt,
  splitLines,
  truncateUtf8,
  countTextLines,
  normalizeTypography,
  type TextLine,
} from "./text.ts";

interface MissingEdit {
  readonly oldText: string;
  readonly newText: string;
  readonly path: string;
  readonly index: number;
  readonly field?: "oldText" | "endText";
}
export function missingEditMessage(content: string, edit: MissingEdit): string {
  const offsets = edit.newText.length > 0 ? findOccurrences(content, edit.newText, 7) : [];
  const lines = lineNumbersAt(content, offsets.slice(0, 6));
  const suffix = offsets.length > lines.length ? ", …" : "";
  const alreadyPresent =
    offsets.length > 0
      ? ` The replacement text already appears at line${offsets.length === 1 ? "" : "s"} ${lines.join(", ")}${suffix}; the edit may already be applied.`
      : "";
  const closest = findClosestBlock(content, edit.oldText);
  const field = edit.field ?? "oldText";
  const label = closest?.sampled === true ? "Similar sampled block" : "Closest block";
  const hint =
    closest === undefined
      ? fileHeadHint(content)
      : `\n${label} is lines ${closest.startLine}-${closest.endLine} (${Math.round(closest.score * 100)}% similar):\n${closest.excerpt}\nUse the actual block above as ${field} and retry.`;
  return `Could not find edits[${edit.index}].${field} in ${edit.path}.${alreadyPresent}${hint}\nNo changes were written.`;
}
function fileHeadHint(content: string): string {
  if (content.length === 0) {
    return "\nFile is empty. Re-read the target area and retry with the current text.";
  }
  let end = 0;
  let lines = 1;
  const scanLimit = Math.min(content.length, 1_200);
  while (end < scanLimit && lines <= 8) {
    const char = content[end++];
    if (char === "\n" || (char === "\r" && content[end] !== "\n")) {
      lines++;
    }
  }
  const excerpt = truncateUtf8(content.slice(0, end).replace(/\r\n|\r/g, "\n"), 1_200).text;
  return `\nFile starts with:\n${excerpt}${end < content.length ? "\n..." : ""}\nRe-read the target area and retry with the current text.`;
}
interface SimilarBlock {
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly excerpt: string;
  readonly sampled: boolean;
}
function diagnosticLines(
  content: string,
  search: string,
): { readonly content: readonly TextLine[]; readonly search: readonly TextLine[] } | undefined {
  if (Buffer.byteLength(search) > 8 * 1024) {
    return;
  }
  const searchLines = splitLines(search);
  if (searchLines.length === 0 || searchLines.length > 40) {
    return;
  }
  if (content.length > 500_000 || countTextLines(content) > 20_000) {
    return;
  }
  const contentLines = splitLines(content);
  if (contentLines.length > 0 && contentLines.length >= searchLines.length) {
    return { content: contentLines, search: searchLines };
  }
  return;
}
function findClosestBlock(content: string, search: string): SimilarBlock | undefined {
  const lines = diagnosticLines(content, search);
  if (lines === undefined) {
    return;
  }
  const wanted = normalizeForSimilarity(lines.search.map((line) => line.body).join("\n"));
  if (wanted.length === 0) {
    return;
  }
  const totalWindows = lines.content.length - lines.search.length + 1;
  const windows = Math.min(totalWindows, Math.max(1, Math.floor(2_000_000 / wanted.length)));
  let best: { start: number; score: number; text: string } | undefined;
  let previousStart = -1;
  for (let sample = 0; sample < windows; sample++) {
    const start =
      windows === totalWindows
        ? sample
        : Math.floor((sample * (totalWindows - 1)) / Math.max(1, windows - 1));
    if (start === previousStart) {
      continue;
    }
    previousStart = start;
    const text = lines.content
      .slice(start, start + lines.search.length)
      .map((line) => line.body)
      .join("\n");
    const score = diceSimilarity(wanted, normalizeForSimilarity(text));
    if (best === undefined || score > best.score) {
      best = { start, score, text };
    }
  }
  if (best === undefined || best.score < 0.35) {
    return;
  }
  return {
    startLine: best.start + 1,
    endLine: best.start + lines.search.length,
    score: best.score,
    excerpt: truncateUtf8(best.text, 1_200).text,
    sampled: windows < totalWindows,
  };
}
function normalizeForSimilarity(value: string): string {
  return normalizeTypography(value).replace(/\s+/g, " ").trim();
}
function diceSimilarity(left: string, right: string): number {
  if (left === right) {
    return 1;
  }
  if (left.length < 2 || right.length < 2) {
    return 0;
  }
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
