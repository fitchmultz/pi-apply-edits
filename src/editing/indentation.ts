import { normalizeTypography, splitLines, type TextLine } from "./text.ts";

function leadingWhitespace(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? "";
}
function indentationWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += char === "\t" ? 4 - (width % 4) : 1;
  }
  return width;
}
function minimumIndentWidth(lines: readonly string[]): number {
  const widths = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => indentationWidth(leadingWhitespace(line)));
  return widths.length > 0 ? Math.min(...widths) : 0;
}
export function indentationSignature(lines: readonly string[]): string[] {
  const common = minimumIndentWidth(lines);
  return lines.map((line) => {
    if (line.trim().length === 0) {
      return "";
    }
    const leading = leadingWhitespace(line);
    const body = line.slice(leading.length);
    return `${Math.max(0, indentationWidth(leading) - common)}:${normalizeTypography(body).trimEnd()}`;
  });
}
function targetIndentation(lines: readonly string[]): ReadonlyMap<number, string | null> {
  const indents = new Map<number, string | null>();
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const indent = leadingWhitespace(line);
    const width = indentationWidth(indent);
    const prior = indents.get(width);
    indents.set(width, prior === undefined || prior === indent ? indent : null);
  }
  return indents;
}
interface Indentation {
  readonly delta: number;
  readonly usesTabs: boolean;
}
function shiftLine(
  line: TextLine,
  target: Indentation,
  indentAt: (width: number) => string | null | undefined,
): string {
  if (line.body.trim().length === 0) {
    return line.body + line.ending;
  }
  const indent = leadingWhitespace(line.body);
  const width = Math.max(0, indentationWidth(indent) + target.delta);
  const callerUsesTabs = indent.includes("\t");
  if (callerUsesTabs && width < 4) {
    throw new Error(
      "Cannot preserve tab indentation after this correction. Use exact oldText or write_files. No changes were written.",
    );
  }
  const targetIndent = callerUsesTabs ? undefined : indentAt(width);
  if (targetIndent === null) {
    throw new Error(
      "Matched lines mix tabs and spaces at the same depth. Use exact oldText or write_files. No changes were written.",
    );
  }
  // Recipe tabs are syntax. Otherwise reuse the target's known indentation.
  const fallback =
    target.usesTabs || callerUsesTabs
      ? "\t".repeat(Math.floor(width / 4)) + " ".repeat(width % 4)
      : " ".repeat(width);
  return `${targetIndent ?? fallback}${line.body.slice(indent.length)}${line.ending}`;
}
export function reindentReplacement(
  replacement: string,
  searchLines: readonly string[],
  candidateLines: readonly string[],
): string {
  const indents = targetIndentation(candidateLines);
  const target = {
    delta: minimumIndentWidth(candidateLines) - minimumIndentWidth(searchLines),
    usesTabs: [...indents.values()].some((indent) => indent?.includes("\t") === true),
  };
  return splitLines(replacement)
    .map((line) => shiftLine(line, target, (width) => indents.get(width)))
    .join("");
}
