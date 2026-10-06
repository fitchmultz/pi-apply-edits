import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import { truncateHead, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import {
  applyPatchToFiles,
  replaceTextInFiles,
  writeFiles,
  resolveInputPath,
  MAX_BATCH_FILES,
  MAX_EDITS_PER_FILE,
  type ApplyEditsBatchDetails,
} from "./apply-edits.ts";
import { bindPatchPaths, parsePatch, PATCH_GRAMMAR } from "./patch.ts";
import { editingResultRenderer } from "./tool-rendering.ts";
import type { ReadonlyEditingExecution } from "./editing/contracts.ts";
import { mutableDetails } from "./editing/receipts.ts";

export const EDITING_TOOL_NAMES = [
  "apply_patch",
  "replace_text",
  "write_files",
  "preview_patch",
] as const;
const pathSchema = Type.String({
  minLength: 1,
  description: "Literal path, relative to the current working directory or absolute.",
});
const previewSchema = Type.Optional(
  Type.Boolean({ description: "Read-only preview. No writes, staging, or publication probes." }),
);
export const patchSchema = Type.Object(
  {
    input: Type.String({
      description:
        "Patch between *** Begin Patch and *** End Patch. Headers: *** Add File:, *** Update File: (optional *** Move to:), *** Delete File:. Prefix context with one space, removals with -, additions with +; @@ starts a chunk.",
    }),
  },
  { additionalProperties: false },
);
export const replaceTextSchema = Type.Object(
  {
    files: Type.Array(
      Type.Object(
        {
          path: pathSchema,
          edits: Type.Array(
            Type.Object(
              {
                oldText: Type.String({
                  minLength: 1,
                  description:
                    "Unique text to replace, preserved insertion anchor, or inclusive range start.",
                }),
                newText: Type.String({
                  description: "Replacement/insertion text; empty deletes. Include any separators.",
                }),
                endText: Type.Optional(
                  Type.String({
                    minLength: 1,
                    description:
                      "Unique inclusive range end after oldText. Cannot combine with all:true or insert.",
                  }),
                ),
                all: Type.Optional(
                  Type.Boolean({
                    description: "Replace every non-overlapping match. Default false.",
                  }),
                ),
                insert: Type.Optional(
                  StringEnum(["before", "after"] as const, {
                    description: "Keep the anchor and insert newText with no implicit separator.",
                  }),
                ),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: MAX_EDITS_PER_FILE },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_BATCH_FILES },
    ),
    preview: previewSchema,
  },
  { additionalProperties: false },
);
export const writeFilesSchema = Type.Object(
  {
    files: Type.Array(
      Type.Object(
        {
          path: pathSchema,
          content: Type.String({ description: "Complete UTF-8 file content." }),
          mode: StringEnum(["create", "replace"] as const, {
            description: "create refuses existing entries; replace requires an existing file.",
          }),
          preserveFormatting: Type.Optional(
            Type.Boolean({
              description:
                "Replacement defaults to preserving BOM and dominant line ending. false writes exact bytes; creates are always exact.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_BATCH_FILES },
    ),
    preview: previewSchema,
  },
  { additionalProperties: false },
);

export type PatchParameters = Static<typeof patchSchema>;
export type ReplaceTextParameters = Static<typeof replaceTextSchema>;
export type WriteFilesParameters = Static<typeof writeFilesSchema>;
type Details = ApplyEditsBatchDetails | undefined;

// The existing receipt, not a second machine-only outcome. Additional diff/match
// fields remain available alongside the publication facts required by callers.
const receiptSchema = Type.Object({
  modifiedFiles: Type.Array(Type.String()),
  files: Type.Array(
    Type.Object({
      path: Type.String(),
      operation: StringEnum(["edit", "rewrite", "create", "patch", "delete", "move", "no_change"]),
      status: StringEnum(["applied", "unchanged", "failed", "unattempted", "uncertain"]),
      moveTo: Type.Optional(Type.String()),
      warnings: Type.Array(Type.String()),
    }),
  ),
  preview: Type.Optional(Type.Literal(true)),
  error: Type.Optional(Type.String()),
});

type PatchTool = ToolDefinition<typeof patchSchema, Details, unknown>;
type ReplaceTool = ToolDefinition<typeof replaceTextSchema, Details, unknown>;
type WriteTool = ToolDefinition<typeof writeFilesSchema, Details, unknown>;
export type EditingTools = [PatchTool, ReplaceTool, WriteTool, PatchTool];

const shared: Pick<
  ToolDefinition<TSchema, Details, unknown>,
  "executionMode" | "outputSchema" | "renderResult"
> = {
  executionMode: "parallel",
  outputSchema: receiptSchema,
  renderResult: editingResultRenderer,
};

export function createEditingTools(getCwd?: () => string): EditingTools {
  return [
    createPatchTool(false, getCwd),
    createReplaceTool(getCwd),
    createWriteTool(getCwd),
    createPatchTool(true, getCwd),
  ];
}

function createPatchTool(preview: boolean, getCwd: (() => string) | undefined): PatchTool {
  return {
    ...shared,
    name: preview ? "preview_patch" : "apply_patch",
    label: preview ? "preview patch" : "apply patch",
    description: preview
      ? "Preview a Codex-format patch without writing files or running publication probes. Applying later re-reads and validates files."
      : "Apply a Codex-format patch: Add File, Update File, Delete File, and Move to. Plans all files before publishing. Add/move never overwrite an existing destination. Ambiguous context or missing named anchors fail. Preserves BOM, local line endings, and unchanged bytes; added indentation is literal. Partial publication is reported, never automatically retried.",
    promptSnippet: preview
      ? "Read-only patch preview."
      : "Focused multi-file patches, creates, deletes, and moves.",
    promptGuidelines: preview
      ? undefined
      : [
          "Use apply_patch for focused edits, replace_text for repeated replacements or large anchored ranges, and write_files for complete files. Preview only when needed.",
          "Inspect the verified, failed, uncertain, and unattempted paths in an error result before retrying. Never replay a whole partially applied batch.",
        ],
    parameters: patchSchema,
    constrainedSampling: { type: "grammar", variants: { openai_lark: PATCH_GRAMMAR } },
    prepareArguments(raw) {
      if (!isRecord(raw) || typeof raw.input !== "string") {
        throw new Error("input must be a patch string");
      }
      const input = getCwd === undefined ? raw.input : bindPatchPaths(raw.input, getCwd());
      return { ...raw, input };
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      return toolResult(
        await applyPatchToFiles(params.input, ctx.cwd, preview, signal, (summary) => {
          onUpdate?.({ content: [{ type: "text", text: summary }], details: undefined });
        }),
      );
    },
    renderCall(args, theme) {
      let paths = "patch";
      try {
        paths = parsePatch(args.input)
          .operations.map((operation) => operation.path)
          .join(", ");
      } catch {
        // Streaming input can be incomplete.
      }
      return new Text(
        theme.fg("toolTitle", theme.bold(`${preview ? "preview_patch" : "apply_patch"} `)) +
          theme.fg("accent", paths),
        0,
        0,
      );
    },
  };
}

function createReplaceTool(getCwd: (() => string) | undefined): ReplaceTool {
  return {
    ...shared,
    name: "replace_text",
    label: "replace text",
    description:
      "Apply ordered text replacements, inclusive endText ranges, or zero-separator inserts in files. Unique anchors required unless all:true. Exact matching first, then unambiguous complete-line typography/trailing-space or uniform-indentation correction. All files are planned before publication; failures can leave a partial batch. preview:true is read-only.",
    promptSnippet: "Compact repeated replacements, anchored ranges, and inserts.",
    parameters: replaceTextSchema,
    prepareArguments(raw) {
      const input = structuredInput(raw);
      const cwd = getCwd?.();
      return { ...input, files: input.files.map((file: unknown) => prepareReplaceFile(file, cwd)) };
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      return toolResult(
        await replaceTextInFiles(params, ctx.cwd, signal, (summary) => {
          onUpdate?.({ content: [{ type: "text", text: summary }], details: undefined });
        }),
      );
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("replace_text ")) +
          theme.fg("accent", structuredCallLabel(args)),
        0,
        0,
      );
    },
  };
}

function createWriteTool(getCwd: (() => string) | undefined): WriteTool {
  return {
    ...shared,
    name: "write_files",
    label: "write files",
    description:
      "Write complete UTF-8 files in one planned batch. mode:create exclusively creates a missing file; mode:replace requires an existing file. Replacements preserve BOM/dominant line ending unless preserveFormatting:false; creates use exact content. All files are planned before publication; failures can leave a partial batch. preview:true is read-only.",
    promptSnippet: "Complete file writes with explicit create/replace modes.",
    parameters: writeFilesSchema,
    prepareArguments(raw) {
      const input = structuredInput(raw);
      const cwd = getCwd?.();
      return { ...input, files: input.files.map((file: unknown) => prepareWriteFile(file, cwd)) };
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      return toolResult(
        await writeFiles(params, ctx.cwd, signal, (summary) => {
          onUpdate?.({ content: [{ type: "text", text: summary }], details: undefined });
        }),
      );
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("write_files ")) +
          theme.fg("accent", structuredCallLabel(args)),
        0,
        0,
      );
    },
  };
}

function structuredInput(
  raw: unknown,
): Readonly<Record<string, unknown>> & { readonly files: readonly unknown[] } {
  if (!isRecord(raw) || !Array.isArray(raw.files)) {
    throw new Error("files must be an array");
  }
  optionalType(raw, "preview", "boolean");
  return { ...raw, files: raw.files };
}

function preparePath(
  file: unknown,
  cwd: string | undefined,
): Readonly<Record<string, unknown>> & { readonly path: string } {
  if (!isRecord(file) || typeof file.path !== "string") {
    throw new Error("Each file needs a string path");
  }
  return { ...file, path: cwd === undefined ? file.path : resolveInputPath(file.path, cwd) };
}

function prepareWriteFile(
  raw: unknown,
  cwd: string | undefined,
): WriteFilesParameters["files"][number] {
  const file = preparePath(raw, cwd);
  if (typeof file.content !== "string") {
    throw new Error("content must be a string");
  }
  if (file.mode !== "create" && file.mode !== "replace") {
    throw new Error('mode must be "create" or "replace"');
  }
  optionalType(file, "preserveFormatting", "boolean");
  return { ...file, content: file.content, mode: file.mode };
}

function prepareReplaceFile(
  raw: unknown,
  cwd: string | undefined,
): ReplaceTextParameters["files"][number] {
  const file = preparePath(raw, cwd);
  if (!Array.isArray(file.edits)) {
    throw new Error("edits must be an array");
  }
  return { ...file, edits: file.edits.map((edit: unknown) => prepareEdit(edit)) };
}

function prepareEdit(edit: unknown): ReplaceTextParameters["files"][number]["edits"][number] {
  if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
    throw new Error("Each edit needs string oldText and newText fields");
  }
  optionalType(edit, "all", "boolean");
  optionalType(edit, "endText", "string");
  optionalType(edit, "insert", "string");
  return { ...edit, oldText: edit.oldText, newText: edit.newText };
}

function optionalType(
  value: Readonly<Record<string, unknown>>,
  key: string,
  type: "string" | "boolean",
): void {
  // Pi normalizes optional nulls, then coerces primitives. Keep our text/control types literal.
  if (value[key] !== null && value[key] !== undefined && typeof value[key] !== type) {
    throw new Error(`${key} must be a ${type}`);
  }
}

function structuredCallLabel(args: {
  readonly files?: readonly { readonly path?: string }[];
  readonly preview?: boolean;
}): string {
  const files = args.files ?? [];
  return `${args.preview === true ? "preview; " : ""}${files
    .slice(0, 3)
    .map((file) => file.path ?? "…")
    .join(", ")}${files.length > 3 ? `, … ${files.length - 3} more` : ""}`;
}

function toolResult(result: ReadonlyEditingExecution): {
  content: { type: "text"; text: string }[];
  details: ApplyEditsBatchDetails;
  structuredContent: JsonValue;
  isError: boolean;
} {
  const content: { type: "text"; text: string }[] = [{ type: "text", text: result.summary }];
  if (result.details.preview === true) {
    const diffs = result.details.files
      .filter((file) => file.diff.length > 0)
      .map((file) => `${file.path}\n${file.diff}`)
      .join("\n");
    if (diffs.length > 0) {
      const preview = truncateHead(diffs);
      content.push({
        type: "text",
        text:
          preview.content +
          (preview.truncated
            ? "\n[Preview truncated. Full generated diffs remain in tool details and the expanded TUI result.]"
            : ""),
      });
    }
  }
  // The adapter consumes a read view and returns independently owned mutable SDK details.
  const details = mutableDetails(result.details);
  const structuredContent: unknown = JSON.parse(JSON.stringify(details));
  if (!isJsonValue(structuredContent)) {
    throw new Error("Editing receipt is not JSON-compatible");
  }
  return {
    content,
    details,
    structuredContent,
    isError: result.details.error !== undefined,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item: unknown) => isJsonValue(item));
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
