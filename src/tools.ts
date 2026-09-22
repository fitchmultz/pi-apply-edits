import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, truncateHead, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import {
  applyPatchToFiles, replaceTextInFiles, writeFiles, resolveInputPath,
  MAX_BATCH_FILES, MAX_EDITS_PER_FILE,
  type ApplyEditsBatchDetails, type EditingExecution,
} from "./apply-edits.ts";
import { bindPatchPaths, parsePatch, PATCH_GRAMMAR } from "./patch.ts";

export const EDITING_TOOL_NAMES = ["apply_patch", "replace_text", "write_files", "preview_patch"] as const;
const pathSchema = Type.String({ minLength: 1, description: "Literal path, relative to the current working directory or absolute." });
const previewSchema = Type.Optional(Type.Boolean({ description: "Read-only preview. No writes, staging, or publication probes." }));
export const patchSchema = Type.Object({ input: Type.String({ description: "Patch between *** Begin Patch and *** End Patch." }) }, { additionalProperties: false });
export const replaceTextSchema = Type.Object({
  files: Type.Array(Type.Object({
    path: pathSchema,
    edits: Type.Array(Type.Object({
      oldText: Type.String({ minLength: 1, description: "Unique text to replace, preserved insertion anchor, or inclusive range start." }),
      newText: Type.String({ description: "Replacement/insertion text; empty deletes. Include any separators." }),
      endText: Type.Optional(Type.String({ minLength: 1, description: "Unique inclusive range end after oldText. Cannot combine with all:true or insert." })),
      all: Type.Optional(Type.Boolean({ description: "Replace every non-overlapping match. Default false." })),
      insert: Type.Optional(StringEnum(["before", "after"] as const, { description: "Keep the anchor and insert newText with no implicit separator." })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_EDITS_PER_FILE }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_BATCH_FILES }),
  preview: previewSchema,
}, { additionalProperties: false });
export const writeFilesSchema = Type.Object({
  files: Type.Array(Type.Object({
    path: pathSchema,
    content: Type.String({ description: "Complete UTF-8 file content." }),
    mode: StringEnum(["create", "replace"] as const, { description: "create refuses existing entries; replace requires an existing file." }),
    preserveFormatting: Type.Optional(Type.Boolean({ description: "Replacement defaults to preserving BOM and dominant line ending. false writes exact bytes; creates are always exact." })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_BATCH_FILES }),
  preview: previewSchema,
}, { additionalProperties: false });

export type PatchParameters = Static<typeof patchSchema>;
export type ReplaceTextParameters = Static<typeof replaceTextSchema>;
export type WriteFilesParameters = Static<typeof writeFilesSchema>;
type Details = ApplyEditsBatchDetails | undefined;

export function createEditingTools(getCwd?: () => string) {
  const shared: Pick<ToolDefinition<TSchema, Details>, "executionMode" | "renderResult"> = {
    executionMode: "parallel",
    renderResult(result, options, theme, context) {
      const message = result.content.find((item) => item.type === "text")?.text ?? "";
      if (options.isPartial) return new Text(theme.fg("muted", message || "Planning changes…"), 0, 0);
      const details = result.details;
      const failed = context.isError || !!details?.error;
      const warnings = details?.files.some((file) => file.warnings.length) ?? false;
      const preview = details?.preview === true;
      const color = failed ? "error" : warnings ? "warning" : preview ? "accent" : "success";
      let text = theme.fg(color, `${failed ? "✗" : warnings ? "⚠" : preview ? "◇" : "✓"} ${options.expanded ? message : message.split("\n")[0]}`);
      if (!options.expanded || !details) return new Text(text, 0, 0);
      for (const file of details.files) {
        text += `\n${theme.fg("muted", `${file.path}${file.moveTo ? ` → ${file.moveTo}` : ""} (${file.operation}; ${preview ? "preview" : file.status})`)}`;
        // Failed/unattempted diffs are plans, never proof that those bytes were published.
        if (!preview && file.status !== "applied" && file.status !== "unchanged" && file.diff) {
          text += `\n${theme.fg("warning", "Planned diff (not verified applied):")}`;
        }
        let inHunk = false;
        for (const line of file.diff.replace(/\n$/, "").split("\n")) {
          if (!line) continue;
          if (line.startsWith("@@")) inHunk = true;
          const diffColor = inHunk && line.startsWith("+") ? "toolDiffAdded"
            : inHunk && line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext";
          text += `\n${theme.fg(diffColor, line)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  };
  const patchTool = (preview: boolean) => defineTool({
    ...shared,
    name: preview ? "preview_patch" : "apply_patch",
    label: preview ? "preview patch" : "apply patch",
    description: preview
      ? "Preview a Codex-format patch without writing files or running publication probes. Applying later re-reads and validates files."
      : "Apply a Codex-format patch: Add File, Update File, Delete File, and Move to. Plans all files before publishing. Add/move never overwrite an existing destination. Ambiguous context or missing named anchors fail. Preserves BOM, local line endings, and unchanged bytes; added indentation is literal. Partial publication is reported, never automatically retried.",
    promptSnippet: preview ? "Read-only patch preview." : "Focused multi-file patches, creates, deletes, and moves.",
    promptGuidelines: preview ? undefined : [
      "Use apply_patch for focused edits, replace_text for repeated replacements or large anchored ranges, and write_files for complete files. Preview only when needed.",
      "Inspect partial or uncertain results before retrying; details.modifiedFiles lists verified committed paths. Never replay a whole partially applied batch.",
    ],
    parameters: patchSchema,
    constrainedSampling: { type: "grammar", variants: { openai_lark: PATCH_GRAMMAR } },
    prepareArguments(raw) {
      if (!isRecord(raw) || typeof raw.input !== "string") throw new Error("input must be a patch string");
      const input = getCwd ? bindPatchPaths(raw.input, getCwd()) : raw.input;
      return { ...raw, input };
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      return toolResult(await applyPatchToFiles(params.input, ctx.cwd, preview, signal, (summary) => {
        onUpdate?.({ content: [{ type: "text", text: summary }], details: undefined });
      }));
    },
    renderCall(args, theme) {
      let paths = "patch";
      try { paths = parsePatch(args.input).operations.map((operation) => operation.path).join(", "); } catch { /* Streaming input can be incomplete. */ }
      return new Text(theme.fg("toolTitle", theme.bold(`${preview ? "preview_patch" : "apply_patch"} `)) + theme.fg("accent", paths), 0, 0);
    },
  });
  const replace = defineTool({
    ...shared,
    name: "replace_text", label: "replace text",
    description: "Apply ordered text replacements, inclusive endText ranges, or zero-separator inserts in files. Unique anchors required unless all:true. Exact matching first, then unambiguous complete-line typography/trailing-space or uniform-indentation correction. All files are planned before publication; failures can leave a partial batch. preview:true is read-only.",
    promptSnippet: "Compact repeated replacements, anchored ranges, and inserts.",
    parameters: replaceTextSchema,
    prepareArguments: (raw) => prepareStructuredArguments(raw, getCwd, "replace") as ReplaceTextParameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      return toolResult(await replaceTextInFiles(params, ctx.cwd, signal, (summary) => {
        onUpdate?.({ content: [{ type: "text", text: summary }], details: undefined });
      }));
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("replace_text ")) + theme.fg("accent", structuredCallLabel(args)), 0, 0);
    },
  });
  const write = defineTool({
    ...shared,
    name: "write_files", label: "write files",
    description: "Write complete UTF-8 files in one planned batch. mode:create exclusively creates a missing file; mode:replace requires an existing file. Replacements preserve BOM/dominant line ending unless preserveFormatting:false; creates use exact content. All files are planned before publication; failures can leave a partial batch. preview:true is read-only.",
    promptSnippet: "Complete file writes with explicit create/replace modes.",
    parameters: writeFilesSchema,
    prepareArguments: (raw) => prepareStructuredArguments(raw, getCwd, "write") as WriteFilesParameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      return toolResult(await writeFiles(params, ctx.cwd, signal, (summary) => {
        onUpdate?.({ content: [{ type: "text", text: summary }], details: undefined });
      }));
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("write_files ")) + theme.fg("accent", structuredCallLabel(args)), 0, 0);
    },
  });
  return [patchTool(false), replace, write, patchTool(true)];
}

function prepareStructuredArguments(raw: unknown, getCwd: (() => string) | undefined, kind: "replace" | "write"): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.files)) throw new Error("files must be an array");
  optionalType(raw, "preview", "boolean");
  const cwd = getCwd?.();
  return { ...raw, files: raw.files.map((file: unknown) => {
    if (!isRecord(file) || typeof file.path !== "string") throw new Error("Each file needs a string path");
    if (kind === "write") {
      if (typeof file.content !== "string") throw new Error("content must be a string");
      optionalType(file, "preserveFormatting", "boolean");
    } else {
      if (!Array.isArray(file.edits)) throw new Error("edits must be an array");
      for (const edit of file.edits) {
        if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
          throw new Error("Each edit needs string oldText and newText fields");
        }
        optionalType(edit, "all", "boolean");
        optionalType(edit, "endText", "string");
        optionalType(edit, "insert", "string");
      }
    }
    return { ...file, path: cwd === undefined ? file.path : resolveInputPath(file.path, cwd) };
  }) };
}

function optionalType(value: Record<string, unknown>, key: string, type: "string" | "boolean"): void {
  // Pi normalizes optional nulls, then coerces primitives. Keep our text/control types literal.
  if (value[key] != null && typeof value[key] !== type) throw new Error(`${key} must be a ${type}`);
}

function structuredCallLabel(args: { files?: Array<{ path?: string }>; preview?: boolean }): string {
  const files = Array.isArray(args.files) ? args.files : [];
  return `${args.preview ? "preview; " : ""}${files.slice(0, 3).map((file) => file?.path ?? "…").join(", ")}${files.length > 3 ? `, … ${files.length - 3} more` : ""}`;
}

function toolResult(result: EditingExecution) {
  const content = [{ type: "text" as const, text: result.summary }];
  if (result.details.preview) {
    const diffs = result.details.files.filter((file) => file.diff).map((file) => `${file.path}\n${file.diff}`).join("\n");
    if (diffs) {
      const preview = truncateHead(diffs);
      content.push({ type: "text", text: preview.content + (preview.truncated
        ? "\n[Preview truncated. Full generated diffs remain in tool details and the expanded TUI result.]" : "") });
    }
  }
  return { content, details: result.details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
