import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  applyEditsToFile,
  type ApplyEditsBatchDetails,
  type ApplyEditsRequest,
  type ApplyEditsToolDetails,
} from "../src/apply-edits.ts";

const editSchema = Type.Object({
  oldText: Type.String({
    description:
      "Anchor text to find. For replace, this is the text to remove. " +
      "For insert, this is the unique nearby text to insert before/after.",
  }),
  newText: Type.String({
    description:
      "Replacement text, or the text to insert when insert is set. May be empty only for replace (delete).",
  }),
  all: Type.Optional(
    Type.Boolean({
      description: "Apply at every non-overlapping match. Default false; unique match required.",
    }),
  ),
  insert: Type.Optional(
    StringEnum(["before", "after"] as const, {
      description:
        'Insert newText before or after the matched oldText instead of replacing it. ' +
        'Example: insert an import after "import fs from \\"node:fs\\";".',
    }),
  ),
});

const fileSchema = Type.Object({
  path: Type.String({ description: "File path, relative to the session working directory or absolute." }),
  edits: Type.Optional(
    Type.Array(editSchema, {
      minItems: 1,
      description:
        "Ordered replacements/inserts. Each edit sees the result of prior edits. " +
        "The file is committed only if all succeed.",
    }),
  ),
  rewrite: Type.Optional(
    Type.String({
      description: "Complete file content. Use instead of edits. Preserves an existing file's BOM and line endings.",
    }),
  ),
  onMissing: Type.Optional(
    StringEnum(["error", "create"] as const, {
      description: 'Missing-file behavior for rewrite. Use "create" only when creating a file. Default "error".',
    }),
  ),
});

export const applyEditsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Single-file path. Omit when using files for a multi-file batch." }),
  ),
  edits: Type.Optional(
    Type.Array(editSchema, {
      minItems: 1,
      description:
        "Single-file ordered replacements/inserts. Each edit sees the result of prior edits. " +
        "The file is committed only if all succeed.",
    }),
  ),
  rewrite: Type.Optional(
    Type.String({
      description: "Single-file complete content. Use instead of edits. Preserves BOM and line endings.",
    }),
  ),
  onMissing: Type.Optional(
    StringEnum(["error", "create"] as const, {
      description: 'Missing-file behavior for single-file rewrite. Use "create" only when creating. Default "error".',
    }),
  ),
  files: Type.Optional(
    Type.Array(fileSchema, {
      minItems: 1,
      description:
        "Multi-file batch. Every file is planned first; nothing is written unless every file " +
        "mutation can be computed. Prefer this when changing several files together. " +
        "A rare mid-publish filesystem failure can leave earlier files already written.",
    }),
  ),
});

export type ApplyEditsParameters = Static<typeof applyEditsSchema>;

export function prepareApplyEditsArguments(raw: unknown): ApplyEditsParameters {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("apply_edits arguments must be a JSON object");
    }
  }
  if (!isRecord(value)) return value as ApplyEditsParameters;

  if (value.files !== undefined) {
    if (
      value.path !== undefined ||
      value.edits !== undefined ||
      value.rewrite !== undefined ||
      value.content !== undefined ||
      value.onMissing !== undefined ||
      value.on_missing !== undefined
    ) {
      throw new Error("files cannot be combined with top-level path, edits, rewrite, content, or onMissing");
    }
    let files = value.files;
    if (typeof files === "string") {
      try {
        files = JSON.parse(files);
      } catch {
        throw new Error("files must be a JSON array, not malformed JSON text");
      }
    }
    if (!Array.isArray(files)) throw new Error("files must be an array");
    return {
      files: files.map((file, index) => {
        try {
          return prepareSingleFileArguments(file);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`files[${index}]: ${reason}`);
        }
      }),
    } as ApplyEditsParameters;
  }

  return prepareSingleFileArguments(value) as ApplyEditsParameters;
}

export function createApplyEditsTool(): ToolDefinition<
  typeof applyEditsSchema,
  ApplyEditsToolDetails
> {
  return {
    name: "apply_edits",
    label: "apply edits",
    description:
      "Apply ordered text replacements/inserts, rewrite a UTF-8 text file, create one file, or apply " +
      "a multi-file batch. Provide either files: [...] or a single-file path with exactly one of " +
      "edits or rewrite. rewrite is the easy whole-file path: pass the full new contents " +
      '(onMissing: "create" only when creating). edits is for small unique patches; set insert to ' +
      '"before" or "after" to insert newText at an anchor without replacing it. Ordered edits run ' +
      "sequentially in memory; nothing is written unless every edit (and every file in a batch) can be " +
      "planned successfully. oldText matches exactly first, then tolerates only an unambiguous full-line " +
      "typography, trailing-whitespace, or uniform-indentation difference. A repeated match is an error " +
      "unless all is true.",
    promptSnippet:
      "File writes: rewrite whole files, edits/inserts for small patches, files:[] for plan-first multi-file batches.",
    promptGuidelines: [
      "Use apply_edits for file mutations when available; it replaces built-in edit and write by default.",
      'Whole-file replace or new file: rewrite with the full contents (onMissing: "create" only when ' +
        "creating). One call, no oldText matching; ideal for large prompt/markdown/config rewrites.",
      'Small surgical change: edits with a short unique oldText. Use insert: "before"|"after" to add ' +
        "text at an anchor (imports, cases, list items) without restating surrounding code. Ordered " +
        "edits apply in memory and commit together only after all succeed.",
      "Multi-file change: pass files: [{path, edits|rewrite}, ...] so the whole batch is planned before " +
        "any write. Prefer this over several separate apply_edits calls when the edits belong together.",
    ],
    parameters: applyEditsSchema,
    prepareArguments: prepareApplyEditsArguments,
    executionMode: "parallel",

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const result = await applyEditsToFile(params as ApplyEditsRequest, context.cwd, signal);
      return {
        content: [{ type: "text", text: result.summary }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      const label = callLabel(args);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("apply_edits "))}${theme.fg("accent", label.path)}` +
          theme.fg("dim", ` (${label.mode})`),
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      const content = result.content.find((item) => item.type === "text");
      const message = content?.type === "text" ? content.text : "";
      if (options.isPartial) return new Text(theme.fg("warning", "Applying edits..."), 0, 0);
      if (context.isError) {
        const lines = (message || "apply_edits failed").split("\n");
        const visible = options.expanded ? lines : lines.slice(0, 1);
        return new Text(visible.map((line) => theme.fg("error", line)).join("\n"), 0, 0);
      }

      let text = theme.fg("success", `✓ ${message || "Applied"}`);
      const diffs = collectDiffs(result.details);
      if (diffs.length === 0 || !options.expanded) return new Text(text, 0, 0);

      const limit = 200;
      let shown = 0;
      for (const { path, diff } of diffs) {
        if (shown >= limit) break;
        if (diffs.length > 1) {
          text += `\n${theme.fg("muted", `--- ${path}`)}`;
          shown += 1;
        }
        let inHunk = false;
        for (const line of diff.split("\n")) {
          if (shown >= limit) break;
          if (line.startsWith("@@")) inHunk = true;
          const color = inHunk && line.startsWith("+")
            ? "toolDiffAdded"
            : inHunk && line.startsWith("-")
              ? "toolDiffRemoved"
              : "toolDiffContext";
          text += `\n${theme.fg(color, line)}`;
          shown += 1;
        }
      }
      if (shown >= limit) {
        text += `\n${theme.fg("muted", "... more diff lines")}`;
      }
      return new Text(text, 0, 0);
    },
  };
}

export default function applyEditsExtension(pi: ExtensionAPI): void {
  pi.registerFlag("apply-edits-with-builtins", {
    type: "boolean",
    default: false,
    description: "Keep Pi's built-in edit and write tools active alongside apply_edits",
  });
  pi.registerTool(createApplyEditsTool());

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes("apply_edits") || keepBuiltins(pi)) return;
    pi.setActiveTools(active.filter((name) => name !== "edit" && name !== "write"));
  });
}

function prepareSingleFileArguments(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error("file entry must be an object");

  const path = readAlias(raw, ["path", "file_path", "filePath"], "path");
  let edits = raw.edits;
  const rewrite = readAlias(raw, ["rewrite", "content"], "rewrite content");
  const onMissing = readAlias(raw, ["onMissing", "on_missing"], "onMissing");

  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      throw new Error("edits must be a JSON array, not malformed JSON text");
    }
  }

  const oldText = readAlias(raw, ["oldText", "old_string"], "top-level oldText");
  const newText = readAlias(raw, ["newText", "new_string"], "top-level newText");
  const all = readAlias(raw, ["all", "replace_all"], "top-level all");
  const insert = readAlias(raw, ["insert"], "top-level insert");
  const hasTopLevelEdit =
    oldText !== undefined || newText !== undefined || all !== undefined || insert !== undefined;
  if (hasTopLevelEdit) {
    if (edits !== undefined || rewrite !== undefined) {
      throw new Error("Top-level edit fields cannot be combined with edits, rewrite, or content");
    }
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new Error("Top-level edit repair requires both string oldText and newText fields");
    }
    edits = [{ oldText, newText, all, insert }];
  }
  if (Array.isArray(edits)) edits = edits.map(normalizeEditAliases);

  return { path, edits, rewrite, onMissing };
}

function normalizeEditAliases(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    oldText: readAlias(value, ["oldText", "old_string"], "edit oldText"),
    newText: readAlias(value, ["newText", "new_string"], "edit newText"),
    all: readAlias(value, ["all", "replace_all"], "edit all"),
    insert: readAlias(value, ["insert"], "edit insert"),
  };
}

function callLabel(args: ApplyEditsParameters): { path: string; mode: string } {
  if (Array.isArray(args.files)) {
    const count = args.files.length;
    return {
      path: `${count} file${count === 1 ? "" : "s"}`,
      mode: "batch",
    };
  }
  const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
  const inserts = Array.isArray(args.edits)
    ? args.edits.filter((edit) => edit && typeof edit === "object" && "insert" in edit && edit.insert).length
    : 0;
  const mode = editCount > 0
    ? inserts === editCount
      ? `${editCount} insert${editCount === 1 ? "" : "s"}`
      : inserts > 0
        ? `${editCount} edit${editCount === 1 ? "" : "s"}/${inserts} insert${inserts === 1 ? "" : "s"}`
        : `${editCount} edit${editCount === 1 ? "" : "s"}`
    : args.onMissing === "create"
      ? "create"
      : "rewrite";
  return { path: String(args.path ?? ""), mode };
}

function collectDiffs(
  details: ApplyEditsToolDetails | undefined,
): Array<{ path: string; diff: string }> {
  if (!details) return [];
  if (isBatchDetails(details)) {
    return details.files
      .filter((file) => file.diff)
      .map((file) => ({ path: file.path, diff: file.diff }));
  }
  return details.diff ? [{ path: details.path, diff: details.diff }] : [];
}

function isBatchDetails(details: ApplyEditsToolDetails): details is ApplyEditsBatchDetails {
  return "files" in details && Array.isArray(details.files);
}

function readAlias(
  value: Record<string, unknown>,
  names: string[],
  label: string,
): unknown {
  const present = names.filter((name) => value[name] !== undefined);
  if (present.length === 0) return undefined;
  const first = value[present[0]!];
  for (const name of present.slice(1)) {
    if (!Object.is(first, value[name])) {
      throw new Error(`Conflicting ${label} fields: ${present.join(", ")}`);
    }
  }
  return first;
}

function keepBuiltins(pi: ExtensionAPI): boolean {
  if (pi.getFlag("apply-edits-with-builtins") === true) return true;
  return ["1", "true", "yes", "on"].includes(
    (process.env.PI_APPLY_EDITS_KEEP_BUILTINS ?? "").toLowerCase(),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
