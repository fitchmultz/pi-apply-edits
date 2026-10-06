import { MAX_EDIT_EXPANSION_CHARS, type Replacement } from "./contracts.ts";

export function hasOverlaps(replacements: readonly Replacement[]): boolean {
  const ordered = [...replacements].sort((left, right) => left.matchStart - right.matchStart);
  return ordered.some(
    (item, index) => index > 0 && item.matchStart < (ordered[index - 1]?.matchEnd ?? 0),
  );
}
export function throwExpansionError(): never {
  throw new Error(
    `Ordered edits would expand the result by more than ${MAX_EDIT_EXPANSION_CHARS.toLocaleString()} characters. Use write_files or smaller edits. No changes were written.`,
  );
}
export function applyReplacements(
  content: string,
  replacements: readonly Replacement[],
  maxResultLength: number,
): string {
  const ordered = [...replacements].sort((left, right) => left.start - right.start);
  const projectedLength = ordered.reduce(
    (length, replacement) =>
      length + replacement.text.length - (replacement.end - replacement.start),
    content.length,
  );
  if (projectedLength > maxResultLength) {
    throwExpansionError();
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
