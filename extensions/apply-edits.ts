import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  applyEditsToFile,
  type ApplyEditsDetails,
  type ApplyEditsInput,
} from "../src/apply-edits.ts";

const editSchema = Type.Object({
  oldText: Type.String({
    description: "Current text to replace. Include enough surrounding text to identify one location.",
  }),
  newText: Type.String({ description: "Replacement text. May be empty to delete oldText." }),
  all: Type.Optional(
    Type.Boolean({ description: "Replace every non-overlapping match. Default false; unique match required." }),
  ),
});

export const applyEditsSchema = Type.Object({
  path: Type.String({ description: "File path, relative to the session working directory or absolute." }),
  edits: Type.Optional(
    Type.Array(editSchema, {
      minItems: 1,
      description:
        "Ordered replacements. Each edit sees the result of prior edits. " +
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

  const path = readAlias(value, ["path", "file_path", "filePath"], "path");
  let edits = value.edits;
  const rewrite = readAlias(value, ["rewrite", "content"], "rewrite content");
  const onMissing = readAlias(value, ["onMissing", "on_missing"], "onMissing");

  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      throw new Error("edits must be a JSON array, not malformed JSON text");
    }
  }

  const oldText = readAlias(value, ["oldText", "old_string"], "top-level oldText");
  const newText = readAlias(value, ["newText", "new_string"], "top-level newText");
  const all = readAlias(value, ["all", "replace_all"], "top-level all");
  const hasTopLevelEdit = oldText !== undefined || newText !== undefined || all !== undefined;
  if (hasTopLevelEdit) {
    if (edits !== undefined || rewrite !== undefined) {
      throw new Error("Top-level edit fields cannot be combined with edits, rewrite, or content");
    }
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new Error("Top-level edit repair requires both string oldText and newText fields");
    }
    edits = [{ oldText, newText, all }];
  }
  if (Array.isArray(edits)) edits = edits.map(normalizeEditAliases);

  return { path, edits, rewrite, onMissing } as ApplyEditsParameters;
}

export function createApplyEditsTool(): ToolDefinition<
  typeof applyEditsSchema,
  ApplyEditsDetails
> {
  return {
    name: "apply_edits",
    label: "apply edits",
    description:
      "Apply ordered text replacements, rewrite an existing UTF-8 text file, or create one file. " +
      "Provide exactly one of edits or rewrite. rewrite is the easy whole-file path: pass the full " +
      "new contents (onMissing: \"create\" only when creating). edits is for small unique patches. " +
      "Ordered edits run sequentially in memory; nothing is written unless every edit succeeds. " +
      "oldText matches exactly first, then tolerates only an unambiguous full-line typography, " +
      "trailing-whitespace, or uniform-indentation difference. A repeated match is an error " +
      "unless all is true.",
    promptSnippet:
      "File writes: rewrite for whole-file replace/create, edits for small unique patches; atomic and cheap.",
    promptGuidelines: [
      "Use apply_edits for file mutations when available; it replaces built-in edit and write by default.",
      'Whole-file replace or new file: rewrite with the full contents (onMissing: "create" only when ' +
        "creating). One call, no oldText matching; ideal for large prompt/markdown/config rewrites.",
      "Small surgical change: edits with a short unique oldText. Ordered edits apply in memory and " +
        "commit together only after all succeed. On mismatch, retry with the nearby block from the " +
        "error, or switch that file to rewrite.",
    ],
    parameters: applyEditsSchema,
    prepareArguments: prepareApplyEditsArguments,
    executionMode: "parallel",

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const result = await applyEditsToFile(params as ApplyEditsInput, context.cwd, signal);
      return {
        content: [{ type: "text", text: result.summary }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
      const mode = editCount > 0
        ? `${editCount} edit${editCount === 1 ? "" : "s"}`
        : args.onMissing === "create"
          ? "create"
          : "rewrite";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("apply_edits "))}${theme.fg("accent", String(args.path ?? ""))}` +
          theme.fg("dim", ` (${mode})`),
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
      const diff = result.details?.diff;
      if (!diff || !options.expanded) return new Text(text, 0, 0);

      const lines = diff.split("\n");
      const limit = 200;
      let inHunk = false;
      for (const line of lines.slice(0, limit)) {
        if (line.startsWith("@@")) inHunk = true;
        const color = inHunk && line.startsWith("+")
          ? "toolDiffAdded"
          : inHunk && line.startsWith("-")
            ? "toolDiffRemoved"
            : "toolDiffContext";
        text += `\n${theme.fg(color, line)}`;
      }
      if (lines.length > limit) {
        text += `\n${theme.fg("muted", `... ${lines.length - limit} more diff lines`)}`;
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

function normalizeEditAliases(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    oldText: readAlias(value, ["oldText", "old_string"], "edit oldText"),
    newText: readAlias(value, ["newText", "new_string"], "edit newText"),
    all: readAlias(value, ["all", "replace_all"], "edit all"),
  };
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
