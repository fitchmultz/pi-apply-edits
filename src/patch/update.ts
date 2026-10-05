// Adapted from OpenAI Codex's file_update; provenance and license in parser.ts.
import { PatchMatcher, type ContextMatch } from "./matching.ts";
import {
  MAX_CHUNKS,
  splitLines,
  validateText,
  type PatchChunk,
  type PatchMatch,
  type PatchUpdate,
  type SourceLine,
} from "./source.ts";

const MAX_EXPANSION = 8 * 1024 * 1024;
interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
interface ReplacementRun {
  readonly start: number;
  readonly end: number;
  readonly added: readonly string[];
  readonly includesBom: boolean;
}
export interface PatchUpdateResult {
  readonly text: string;
  readonly matches: readonly PatchMatch[];
}

/** Plans against original bytes; only this owner advances scope and expansion accounting. */
class PatchUpdater {
  readonly #bom: string;
  readonly #body: string;
  readonly #lines: readonly SourceLine[];
  readonly #matcher: PatchMatcher;
  readonly #matches: PatchMatch[] = [];
  readonly #replacements: Replacement[] = [];
  #cursor = 0;
  #projectedLength: number;

  constructor(original: string) {
    validateText(original, "Original text");
    this.#bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
    this.#body = original.slice(this.#bom.length);
    this.#lines = splitLines(this.#body);
    this.#matcher = new PatchMatcher(
      this.#lines.map((line) => line.text),
      this.#bom.length > 0,
    );
    this.#projectedLength = this.#body.length;
  }

  apply(operation: PatchUpdate): PatchUpdateResult {
    if (operation.chunks.length > MAX_CHUNKS) {
      throw new Error(`update cannot contain more than ${MAX_CHUNKS} chunks`);
    }
    for (const [index, chunk] of operation.chunks.entries()) {
      this.applyChunk(chunk, index);
    }
    return { text: this.reconstruct(), matches: this.#matches };
  }

  private offsetAt(line: number): number {
    return this.#lines[line]?.start ?? this.#body.length;
  }

  private lineAt(index: number): SourceLine | undefined {
    return index < 0 ? undefined : this.#lines.at(index);
  }

  private match(pattern: readonly string[], eof: boolean, label: string): ContextMatch {
    return this.#matcher.find(pattern, {
      start: this.#cursor,
      eof,
      scopedChars: this.#body.length - this.offsetAt(this.#cursor),
      label,
    });
  }

  private applyChunk(chunk: PatchChunk, index: number): void {
    for (const anchor of chunk.anchors) {
      const found = this.match([anchor], false, `anchor in chunk ${index + 1}`);
      this.#matches.push({ line: found.line, strategy: found.strategy });
      this.#cursor = found.line;
    }
    const context = chunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const start = this.chunkStart(chunk, context, index);
    let position = start.line - 1;
    let runStart = position;
    let added: string[] = [];
    for (const line of chunk.lines) {
      if (line.kind === "context") {
        this.replace({ start: runStart, end: position, added, includesBom: start.includesBom });
        position++;
        runStart = position;
        added = [];
      } else if (line.kind === "delete") {
        position++;
      } else {
        added.push(line.text);
      }
    }
    this.replace({ start: runStart, end: position, added, includesBom: start.includesBom });
    this.#cursor = position;
  }

  private chunkStart(chunk: PatchChunk, context: readonly string[], index: number): ContextMatch {
    if (context.length > 0) {
      const found = this.match(context, chunk.endOfFile, `context in chunk ${index + 1}`);
      this.#matches.push({ line: found.line, strategy: found.strategy });
      return found;
    }
    const start = chunk.anchors.length > 0 && !chunk.endOfFile ? this.#cursor : this.#lines.length;
    const found: ContextMatch = { line: start + 1, strategy: "exact", includesBom: false };
    this.#matches.push({ line: found.line, strategy: found.strategy });
    return found;
  }

  private replacementEnding(start: number, end: number): string {
    const removed = end > start ? this.lineAt(start)?.ending : "";
    return (
      [
        removed,
        this.lineAt(start - 1)?.ending,
        this.lineAt(start)?.ending,
        this.lineAt(start - 2)?.ending,
      ].find((ending) => ending !== undefined && ending.length > 0) ?? "\n"
    );
  }

  private needsAppendSeparator(run: ReplacementRun): boolean {
    return (
      run.start === this.#lines.length &&
      run.start > 0 &&
      this.#lines[run.start - 1].ending.length === 0 &&
      run.added.length > 0 &&
      this.#replacements.at(-1)?.end !== this.#body.length
    );
  }

  private renderRun(run: ReplacementRun): string {
    const ending = this.replacementEnding(run.start, run.end);
    const parts: string[] = this.needsAppendSeparator(run) ? [ending] : [];
    for (const [index, line] of run.added.entries()) {
      // Restore the encoding BOM once; any further U+FEFF remains content.
      const text =
        run.includesBom && run.start === 0 && index === 0 && line.startsWith("\uFEFF")
          ? line.slice(1)
          : line;
      const originalEnding =
        index < run.end - run.start ? this.#lines[run.start + index].ending : "";
      parts.push(text, originalEnding.length > 0 ? originalEnding : ending);
    }
    return parts.join("");
  }

  private replace(run: ReplacementRun): void {
    if (run.start === run.end && run.added.length === 0) {
      return;
    }
    const text = this.renderRun(run);
    const start = this.offsetAt(run.start);
    const end = this.offsetAt(run.end);
    this.#projectedLength += text.length - (end - start);
    if (this.#projectedLength > this.#body.length + MAX_EXPANSION) {
      throw new Error(
        "Patch would expand the file by more than 8 MiB; use a whole-file write or smaller patches",
      );
    }
    this.#replacements.push({ start, end, text });
  }

  private reconstruct(): string {
    const parts: string[] = [];
    let offset = 0;
    for (const replacement of this.#replacements) {
      parts.push(this.#body.slice(offset, replacement.start), replacement.text);
      offset = replacement.end;
    }
    parts.push(this.#body.slice(offset));
    let text = parts.join("");
    // Preserve terminal-newline state even for tail deletion and append.
    if (this.#body.length > 0 && this.#lines.at(-1)?.ending === "") {
      text = text.replace(/(?:\r\n|\n|\r)$/, "");
    }
    if (this.#bom.length === 0 && text.startsWith("\uFEFF")) {
      throw new Error(
        "Patch would move or add U+FEFF to the start of a file without a BOM. " +
          "Use write_files with preserveFormatting: false for an exact encoding change. No changes were written.",
      );
    }
    return this.#bom + text;
  }
}

/** Anchors advance the original-source suffix; chunks cannot overlap consumed blocks. */
export function applyPatchUpdate(original: string, operation: PatchUpdate): PatchUpdateResult {
  return new PatchUpdater(original).apply(operation);
}
