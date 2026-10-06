// Adapted from OpenAI Codex's apply-patch parser, seek_sequence and file_update.
// Copyright 2025 OpenAI. Apache-2.0; see LICENSE-codex.
// Source: rust-v0.155.1, 4e21628f9ec9ee656650cd2b62ef92225725b5ac.
// This port retains strict envelopes, literal paths and byte-preserving reconstruction.
import { isAbsolute } from "node:path";
import { operationPath } from "../native-path.ts";
import {
  MAX_CHUNKS,
  MAX_FILES,
  splitLines,
  validateText,
  type PatchChunk,
  type PatchOperation,
  type SourceLine,
} from "./source.ts";

export const PATCH_GRAMMAR = String.raw`start: "*** Begin Patch" NL operation+ "*** End Patch" NL?
operation: add | delete | update
add: "*** Add File: " PATH NL add_line*
delete: "*** Delete File: " PATH NL
update: "*** Update File: " PATH NL (move change? | change)
move: "*** Move to: " PATH NL
change: (change_line+ chunk* | chunk+) eof?
chunk: anchor+ change_line+
anchor: ("@@" | "@@ " PATH) NL
add_line: "+" TEXT? NL
change_line: ("+" | "-" | " ") TEXT? NL
eof: "*** End of File" NL
PATH: /[^\r\n\x00]+/
TEXT: /[^\r\n\x00]+/
NL: /\r\n|\n|\r/
`;

interface PathSpan {
  readonly start: number;
  readonly end: number;
  readonly path: string;
}
export interface ParsedPatch {
  readonly operations: readonly PatchOperation[];
  readonly paths: readonly PathSpan[];
}

/** Owns the cursor and header spans; operation readers consume exactly their body. */
class PatchParser {
  readonly #lines: readonly SourceLine[];
  readonly #paths: PathSpan[] = [];
  #index = 1;

  constructor(input: string) {
    validateText(input, "Patch");
    this.#lines = splitLines(input);
    if (
      this.#lines[0]?.text !== "*** Begin Patch" ||
      this.#lines.at(-1)?.text !== "*** End Patch"
    ) {
      throw new Error("Patch must start with '*** Begin Patch' and end with '*** End Patch'");
    }
  }

  parse(): ParsedPatch {
    const operations: PatchOperation[] = [];
    while (this.#index < this.#lines.length - 1) {
      if (operations.length >= MAX_FILES) {
        this.fail(`patch cannot contain more than ${MAX_FILES} file operations`);
      }
      operations.push(this.readOperation());
    }
    if (operations.length === 0) {
      throw new Error("Patch must contain at least one file operation");
    }
    return { operations, paths: this.#paths };
  }

  private fail(message: string): never {
    throw new Error(`Invalid patch at line ${this.#index + 1}: ${message}`);
  }

  private current(): SourceLine {
    const line = this.#lines.at(this.#index);
    if (!line) {
      return this.fail("unexpected end of patch");
    }
    return line;
  }

  private readPath(prefix: string): string {
    const line = this.current();
    const path = line.text.slice(prefix.length);
    if (path.length === 0) {
      this.fail("path must be non-empty");
    }
    this.#paths.push({
      start: line.start + prefix.length,
      end: line.end - line.ending.length,
      path,
    });
    this.#index++;
    return path;
  }

  private hasBody(): boolean {
    const text = this.#lines.at(this.#index)?.text;
    return (
      this.#index < this.#lines.length - 1 &&
      text !== undefined &&
      (!text.startsWith("*** ") || text === "*** End of File")
    );
  }

  private readOperation(): PatchOperation {
    const header = this.current().text;
    if (header.startsWith("*** Add File: ")) {
      return this.readAdd();
    }
    if (header.startsWith("*** Delete File: ")) {
      return { kind: "delete", path: this.readPath("*** Delete File: ") };
    }
    if (header.startsWith("*** Update File: ")) {
      return this.readUpdate();
    }
    return this.fail("expected Add File, Delete File, or Update File header");
  }

  private readAdd(): PatchOperation {
    const path = this.readPath("*** Add File: ");
    const content: string[] = [];
    while (this.hasBody()) {
      const line = this.current();
      if (!line.text.startsWith("+")) {
        this.fail("Add File lines must start with '+'");
      }
      content.push(line.text.slice(1), line.ending);
      this.#index++;
    }
    return { kind: "add", path, content: content.join("") };
  }

  private readUpdate(): PatchOperation {
    const path = this.readPath("*** Update File: ");
    const moveTo =
      this.#lines.at(this.#index)?.text.startsWith("*** Move to: ") === true
        ? this.readPath("*** Move to: ")
        : undefined;
    const chunks: PatchChunk[] = [];
    while (this.hasBody()) {
      if (chunks.length >= MAX_CHUNKS) {
        this.fail(`update cannot contain more than ${MAX_CHUNKS} chunks`);
      }
      const chunk = this.readChunk();
      chunks.push(chunk);
      if (chunk.endOfFile && this.hasBody()) {
        this.fail("End of File must be the last line of an update");
      }
    }
    if (chunks.length === 0 && moveTo === undefined) {
      this.fail("Update File requires changes or Move to");
    }
    return { kind: "update", path, chunks, ...(moveTo === undefined ? {} : { moveTo }) };
  }

  private readChunk(): PatchChunk {
    const anchors: string[] = [];
    const lines: Array<PatchChunk["lines"][number]> = [];
    let endOfFile = false;
    while (this.hasBody()) {
      const text = this.current().text;
      const anchor = text === "@@" || text.startsWith("@@ ");
      if (anchor && lines.length > 0) {
        break;
      }
      if (text === "*** End of File") {
        if (lines.length === 0) {
          this.fail("End of File requires a non-empty chunk");
        }
        endOfFile = true;
        this.#index++;
        break;
      }
      if (anchor) {
        const named = this.readAnchor(text);
        if (named !== undefined) {
          anchors.push(named);
        }
      } else {
        lines.push(this.readChangeLine(text));
      }
      this.#index++;
    }
    if (lines.length === 0) {
      this.fail("update chunk must contain lines after its anchors");
    }
    return { anchors, lines, endOfFile };
  }

  private readAnchor(text: string): string | undefined {
    if (text === "@@") {
      return;
    }
    if (text.length === 3) {
      this.fail("named @@ anchor must be non-empty");
    }
    return text.slice(3);
  }

  private readChangeLine(text: string): PatchChunk["lines"][number] {
    if (text.startsWith("+")) {
      return { kind: "add", text: text.slice(1) };
    }
    if (text.startsWith("-")) {
      return { kind: "delete", text: text.slice(1) };
    }
    if (text.startsWith(" ")) {
      return { kind: "context", text: text.slice(1) };
    }
    return this.fail("update lines must start with ' ', '+', '-', or '@@'");
  }
}

/** Path spans are UTF-16 offsets into untouched input, excluding header syntax/EOL. */
export function parsePatch(input: string): ParsedPatch {
  return new PatchParser(input).parse();
}

/** Bind only parsed headers; body text and absolute path spellings are unchanged. */
export function bindPatchPaths(input: string, cwd: string): string {
  const { paths } = parsePatch(input);
  validateText(cwd, "cwd");
  if (!isAbsolute(cwd)) {
    throw new Error("cwd must be absolute");
  }
  let result = input;
  for (const span of paths.toReversed()) {
    if (!isAbsolute(span.path)) {
      const bound = operationPath(span.path, cwd);
      if (/[\r\n]/.test(bound)) {
        throw new Error("Patch path contains a line break after working-directory binding");
      }
      result = result.slice(0, span.start) + bound + result.slice(span.end);
    }
  }
  return result;
}
