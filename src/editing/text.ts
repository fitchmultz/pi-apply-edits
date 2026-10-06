export type LineEnding = "\n" | "\r\n" | "\r";
export interface TextLine {
  readonly start: number;
  readonly end: number;
  readonly bodyEnd: number;
  readonly body: string;
  readonly ending: LineEnding | "";
  readonly number: number;
}
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
export function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "\n" && char !== "\r") {
      continue;
    }
    const ending = char === "\r" && text[index + 1] === "\n" ? "\r\n" : char;
    const end = index + ending.length;
    lines.push({ start, end, bodyEnd: index, body: text.slice(start, index), ending, number });
    start = end;
    number++;
    if (ending === "\r\n") {
      index++;
    }
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
export function normalizeTypography(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(UNICODE_SPACES, " ");
}
export function normalizeLine(line: string): string {
  return normalizeTypography(line).trimEnd();
}
export function hasFinalLineEnding(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}
export function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n" || (text[index] === "\r" && text[index + 1] !== "\n")) {
      lines++;
    }
  }
  return lines;
}
export function findOccurrences(
  content: string,
  search: string,
  limit = Number.POSITIVE_INFINITY,
): number[] {
  const offsets: number[] = [];
  if (search.length === 0) {
    return offsets;
  }
  let from = 0;
  while (from <= content.length - search.length && offsets.length < limit) {
    const index = content.indexOf(search, from);
    if (index < 0) {
      break;
    }
    offsets.push(index);
    // Overlapping matches must remain visible to uniqueness and overlap checks.
    from = index + 1;
  }
  return offsets;
}
export function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let cursor = 0;
  for (const offset of offsets) {
    while (cursor < offset) {
      if (content[cursor] === "\n" || (content[cursor] === "\r" && content[cursor + 1] !== "\n")) {
        line++;
      }
      cursor++;
    }
    lines.push(line);
  }
  return lines;
}
export function lineEndingsAt(content: string, offsets: readonly number[]): LineEnding[] {
  const endings: LineEnding[] = [];
  const fallback = detectLineEnding(content);
  let cursor = 0;
  for (const offset of offsets) {
    if (content[offset] === "\n" && content[offset - 1] === "\r") {
      endings.push("\r\n");
      continue;
    }
    cursor = Math.max(cursor, offset);
    while (cursor < content.length && content[cursor] !== "\r" && content[cursor] !== "\n") {
      cursor++;
    }
    const char = content[cursor];
    if (char === "\r") {
      endings.push(content[cursor + 1] === "\n" ? "\r\n" : "\r");
    } else {
      endings.push(char === "\n" ? "\n" : fallback);
    }
  }
  return endings;
}
function endingAt(text: string, index: number): LineEnding | undefined {
  if (text[index] === "\r") {
    return text[index + 1] === "\n" ? "\r\n" : "\r";
  }
  if (text[index] === "\n") {
    return "\n";
  }
  return;
}
export function uniformLineEnding(text: string): LineEnding | undefined {
  let found: LineEnding | undefined;
  for (let index = 0; index < text.length; index++) {
    const ending = endingAt(text, index);
    if (ending === undefined) {
      continue;
    }
    if (found !== undefined && ending !== found) {
      return;
    }
    found = ending;
    if (ending === "\r\n") {
      index++;
    }
  }
  return found;
}
export function detectLineEnding(text: string): LineEnding {
  const counts = { "\r\n": 0, "\n": 0, "\r": 0 };
  for (let index = 0; index < text.length; index++) {
    const ending = endingAt(text, index);
    if (ending === undefined) {
      continue;
    }
    counts[ending]++;
    if (ending === "\r\n") {
      index++;
    }
  }
  if (counts["\r\n"] >= counts["\n"] && counts["\r\n"] >= counts["\r"] && counts["\r\n"] > 0) {
    return "\r\n";
  }
  return counts["\r"] > counts["\n"] && counts["\r"] > 0 ? "\r" : "\n";
}
export function convertLineEndings(text: string, ending: LineEnding): string {
  return text.replace(/\r\n|\r|\n/g, ending);
}
export function countLeadingBomCharacters(text: string): number {
  let count = 0;
  while (text[count] === "\uFEFF") {
    count++;
  }
  return count;
}
export function decodeText(
  bytes: Buffer,
  path: string,
): { readonly text: string; readonly body: string; readonly hadBom: boolean } {
  const hadBom = bytes.subarray(0, 3).equals(UTF8_BOM);
  const content = hadBom ? bytes.subarray(3) : bytes;
  let body: string;
  try {
    // Only the encoding BOM is removed; a second U+FEFF is ordinary content.
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch (cause) {
    throw new Error(`Cannot edit non-UTF-8 file: ${path}`, { cause });
  }
  if (body.includes("\0")) {
    throw new Error(`Cannot edit file containing NUL bytes: ${path}`);
  }
  return { text: `${hadBom ? "\uFEFF" : ""}${body}`, body, hadBom };
}
export function truncateUtf8(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) {
    return { text: value, truncated: false };
  }
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end--;
    }
  }
  return { text: "", truncated: true };
}
