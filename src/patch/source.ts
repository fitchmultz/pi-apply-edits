export interface PatchChunk {
  readonly anchors: readonly string[];
  readonly lines: readonly { readonly kind: "context" | "add" | "delete"; readonly text: string }[];
  readonly endOfFile: boolean;
}

export type PatchOperation =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly moveTo?: string;
      readonly chunks: readonly PatchChunk[];
    };

export type PatchUpdate = Extract<PatchOperation, { kind: "update" }>;
export type MatchStrategy = "exact" | "whitespace" | "typography";
export interface PatchMatch {
  readonly line: number;
  readonly strategy: MatchStrategy;
}

export interface SourceLine {
  readonly text: string;
  readonly ending: string;
  readonly start: number;
  readonly end: number;
}

export const MAX_FILES = 64;
export const MAX_CHUNKS = 100;

export function validateText(text: string, label: string): void {
  if (typeof text !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (text.includes("\0")) {
    throw new Error(`${label} cannot contain NUL bytes`);
  }
  if (!text.isWellFormed()) {
    throw new Error(`${label} must contain valid Unicode text`);
  }
}

export function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    const end = match.index + match[0].length;
    lines.push({ text: text.slice(start, match.index), ending: match[0], start, end });
    start = end;
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), ending: "", start, end: text.length });
  }
  return lines;
}
