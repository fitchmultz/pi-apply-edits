import { StringEnum } from "@earendil-works/pi-ai";
import { truncateHead, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  applyEditsToFile,
  MAX_BATCH_FILES,
  MAX_EDITS_PER_FILE,
  type ApplyEditsBatchDetails,
  type ApplyEditsInput,
  type ApplyEditsRequest,
  type ApplyEditsRetry,
  type ApplyEditsToolDetails,
  RetryableApplyEditsError,
  resolveInputPath,
} from "../src/apply-edits.ts";
import { supportsExistingFileReplacement } from "../src/file-system.ts";

const editSchema = Type.Object({
  oldText: Type.String({
    description:
      "Text to replace, inclusive range start with endText, or preserved anchor with insert.",
  }),
  newText: Type.String({
    description:
      "Replacement or inserted text. Include any needed separator: no newline or space is inferred. " +
      "Empty text deletes a replacement/range; inserts must be non-empty.",
  }),
  endText: Type.Optional(
    Type.String({
      description:
        "Inclusive range end. Both anchors must be unique and ordered. Incompatible with all: true or insert.",
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description: "Apply at every non-overlapping match. Default false; unique match required.",
    }),
  ),
  insert: Type.Optional(
    StringEnum(["before", "after"] as const, {
      description:
        "Keep oldText and splice newText before/after it. Zero separator: include any newline or space in newText.",
    }),
  ),
}, { additionalProperties: false });

const retrySchema = Type.Object(
  {
    from: Type.String({
      minLength: 1,
      maxLength: 512,
      description: "Tool-call ID from the compact retry hint.",
    }),
    oldText: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Corrected unique anchor when the hint requests one.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Single-use compact retry exactly as returned by a retryable apply_edits error.",
  },
);

const requireMissingSchema = Type.Optional(
  Type.Boolean({
    description: 'Create-only guard: refuse an existing target. Requires onMissing: "create".',
  }),
);

const fileSchema = Type.Object({
  path: Type.String({ minLength: 1, description: "File path, relative to the session working directory or absolute." }),
  edits: Type.Optional(
    Type.Array(editSchema, {
      minItems: 1,
      maxItems: MAX_EDITS_PER_FILE,
      description:
        "Ordered replacements, ranges, and inserts. Each edit sees the result of prior edits. " +
        "The file is committed only if all succeed.",
    }),
  ),
  rewrite: Type.Optional(
    Type.String({
      description: "Complete file content instead of edits. See preserveFormatting for exact BOM/line-ending control.",
    }),
  ),
  onMissing: Type.Optional(
    StringEnum(["error", "create"] as const, {
      description: 'Missing-file behavior for rewrite. Use "create" only when creating a file. Default "error".',
    }),
  ),
  requireMissing: requireMissingSchema,
  preserveFormatting: Type.Optional(
    Type.Boolean({
      description: "Rewrite only. Default true preserves existing BOM/EOL. Set false to write exact UTF-8 content; creates are always exact.",
    }),
  ),
}, { additionalProperties: false });

export const applyEditsSchema = Type.Object({
  ...fileSchema.properties,
  path: Type.Optional(fileSchema.properties.path),
  preview: Type.Optional(
    Type.Boolean({
      description: "Read-only content preview for a single file, batch, or retry. No writes or retry consumption. Applying later re-reads and checks publication safety.",
    }),
  ),
  files: Type.Optional(
    Type.Array(fileSchema, {
      minItems: 1,
      maxItems: MAX_BATCH_FILES,
      description:
        "Plan all files before writing. A publication failure can leave a partial batch; inspect the reported paths.",
    }),
  ),
  retry: Type.Optional(retrySchema),
}, { additionalProperties: false });

export type ApplyEditsParameters = Static<typeof applyEditsSchema>;
type RetryParameters = Static<typeof retrySchema>;

interface StoredRetry {
  request: ApplyEditsRequest;
  retry: ApplyEditsRetry;
}

type RetryStore = Map<string, StoredRetry>;

const MAX_PENDING_RETRIES = 4;
const SINGLE_FILE_ARGUMENT_KEYS = [
  "path", "file_path", "filePath", "edits", "rewrite", "content", "onMissing", "on_missing",
  "requireMissing", "preserveFormatting", "preserve_formatting", "oldText", "old_string", "newText", "new_string",
  "endText", "all", "replace_all", "insert",
] as const;
const RETRY_UNAVAILABLE =
  "Compact retry is unavailable or does not match this failure. Send a normal apply_edits request.";

export function prepareApplyEditsArguments(raw: unknown): ApplyEditsParameters {
  const value = parseArguments(raw);
  if (!isRecord(value)) return value as ApplyEditsParameters;
  if (value.retry !== undefined) throw new Error(RETRY_UNAVAILABLE);
  if (value.preview !== undefined && typeof value.preview !== "boolean") {
    throw new Error("preview must be a boolean");
  }
  const { preview, ...mutation } = value;

  if (value.files !== undefined) {
    const strayTopLevel = SINGLE_FILE_ARGUMENT_KEYS.filter((name) => value[name] !== undefined);
    if (strayTopLevel.length > 0) {
      throw new Error(
        `files cannot be combined with top-level ${strayTopLevel.join(", ")}`,
      );
    }
    assertSupportedFields(mutation, ["files"], "apply_edits input");
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
      ...(preview === undefined ? {} : { preview }),
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

  return {
    ...prepareSingleFileArguments(mutation),
    ...(preview === undefined ? {} : { preview }),
  } as ApplyEditsParameters;
}

function prepareToolArguments(raw: unknown, retries: RetryStore): ApplyEditsParameters {
  const value = parseArguments(raw);
  if (!isRecord(value) || value.retry === undefined) return prepareApplyEditsArguments(value);
  const extra = Object.keys(value).filter((key) => key !== "retry" && key !== "preview");
  if (extra.length > 0) {
    throw new Error(`retry cannot be combined with ${extra.join(", ")}`);
  }
  if (value.preview !== undefined && typeof value.preview !== "boolean") {
    throw new Error("preview must be a boolean");
  }
  return {
    ...expandRetry(value.retry, retries),
    ...(value.preview === undefined ? {} : { preview: value.preview }),
  };
}

function expandRetry(raw: unknown, retries: RetryStore): ApplyEditsParameters {
  const retry = parseRetry(raw);
  const stored = retries.get(retry.from);
  if (!stored) throw new Error(RETRY_UNAVAILABLE);
  if (stored.retry.kind === "create") {
    if (retry.oldText !== undefined) throw new Error(RETRY_UNAVAILABLE);
    const request = structuredClone(stored.request);
    const allInputs = request.files ?? [request as ApplyEditsInput];
    if (
      allInputs.length === 0 ||
      allInputs.some((input) => typeof input.rewrite !== "string" || input.edits !== undefined)
    ) {
      throw new Error(RETRY_UNAVAILABLE);
    }
    let inputs: Array<ApplyEditsInput | undefined>;
    if (request.files) {
      if (!stored.retry.files) throw new Error(RETRY_UNAVAILABLE);
      inputs = stored.retry.files.map((file) => request.files?.[file]);
    } else {
      if (stored.retry.files !== undefined) throw new Error(RETRY_UNAVAILABLE);
      inputs = allInputs;
    }
    if (inputs.length === 0) throw new Error(RETRY_UNAVAILABLE);
    for (const input of inputs) {
      if (!input) throw new Error(RETRY_UNAVAILABLE);
      input.onMissing = "create";
      input.requireMissing = true;
    }
    return { ...request, retry } as ApplyEditsParameters;
  }

  if (retry.oldText === undefined) throw new Error(RETRY_UNAVAILABLE);
  const request = structuredClone(stored.request);
  const input = stored.retry.file === undefined
    ? request as ApplyEditsInput
    : request.files?.[stored.retry.file];
  const edit = input?.edits?.[stored.retry.edit];
  if (!edit) throw new Error(RETRY_UNAVAILABLE);
  edit.oldText = retry.oldText;
  return { ...request, retry } as ApplyEditsParameters;
}

function parseRetry(raw: unknown): RetryParameters {
  if (!isRecord(raw)) throw new Error("retry must be an object");
  const extra = Object.keys(raw).filter((key) => key !== "from" && key !== "oldText");
  if (extra.length > 0) throw new Error(`retry has unsupported fields: ${extra.join(", ")}`);
  if (typeof raw.from !== "string" || raw.from.length === 0 || raw.from.length > 512) {
    throw new Error("retry.from must be a non-empty tool-call ID");
  }
  if (raw.oldText !== undefined && (typeof raw.oldText !== "string" || raw.oldText.length === 0)) {
    throw new Error("retry.oldText must be a non-empty string");
  }
  return { from: raw.from, oldText: raw.oldText };
}

function rememberRetry(
  retries: RetryStore,
  toolCallId: string,
  request: ApplyEditsRequest,
  retry: ApplyEditsRetry,
  cwd: string,
): boolean {
  if (
    toolCallId.length === 0 ||
    toolCallId.length > 512 ||
    retries.has(toolCallId) ||
    retries.size >= MAX_PENDING_RETRIES
  ) {
    return false;
  }
  const stored = structuredClone(request);
  for (const input of stored.files ?? [stored as ApplyEditsInput]) {
    input.path = resolveInputPath(input.path, cwd);
  }
  retries.set(toolCallId, { request: stored, retry });
  return true;
}

function retryPayload(toolCallId: string, retry: ApplyEditsRetry): string {
  const value = retry.kind === "create"
    ? { from: toolCallId }
    : { from: toolCallId, oldText: "<corrected unique oldText>" };
  return JSON.stringify({ retry: value });
}

export function createApplyEditsTool(): ToolDefinition<
  typeof applyEditsSchema,
  ApplyEditsToolDetails | undefined
> {
  return createApplyEditsToolWithStore(new Map());
}

function createApplyEditsToolWithStore(
  retries: RetryStore,
): ToolDefinition<typeof applyEditsSchema, ApplyEditsToolDetails | undefined> {
  return {
    name: "apply_edits",
    label: "apply edits",
    description:
      "Apply ordered text replacements, inclusive endText ranges, zero-separator inserts, whole-file rewrites, or a " +
      'multi-file batch. Use rewrite for full content (onMissing: "create" to allow creation), edits for targeted ' +
      "changes, and files for multiple paths. Set preview: true for a read-only diff. " +
      "Nothing is written until every edit/file can be planned; publication failures can still leave partial batches. " +
      "Anchors try exact text, then unambiguous complete-line typography/Unicode, trailing-whitespace, or " +
      "uniform-indentation correction. Repeated anchors require all: true; ranges always require unique anchors. " +
      "Eligible no-write failures include a single-use compact retry.",
    promptSnippet:
      "File mutations: rewrite, ordered edits, ranges, inserts, plan-first files:[] batches, and read-only previews.",
    promptGuidelines: [
      "Use apply_edits for file mutations: rewrite for full files, edits with short unique anchors for patches, " +
        'endText for inclusive ranges, insert: "before"|"after" for zero-separator inserts (include newlines/spaces).',
      "Use apply_edits files: [...] for multi-file changes. Set preview: true to inspect without writing. " +
        "Use preserveFormatting: false on rewrites only when exact BOM/EOL changes are intended. " +
        "Reuse compact retries when offered; inspect partial-publication errors before retrying.",
    ],
    parameters: applyEditsSchema,
    prepareArguments: (raw) => prepareToolArguments(raw, retries),
    executionMode: "parallel",

    async execute(toolCallId, params, signal, onUpdate, { cwd }) {
      const { retry, ...request } = params;
      if (retry) {
        const { from } = parseRetry(retry);
        if (!retries.has(from)) throw new Error(RETRY_UNAVAILABLE);
        if (params.preview !== true) retries.delete(from);
      }
      try {
        const result = await applyEditsToFile(request, cwd, signal, (summary) => {
          onUpdate?.({ content: [{ type: "text", text: summary }], details: undefined });
        });
        const content = [{ type: "text" as const, text: result.summary }];
        if (request.preview) {
          const patches = collectDiffs(result.details).map(({ path, diff }) => `${path}\n${diff}`).join("\n");
          if (patches) {
            const preview = truncateHead(patches);
            const note = preview.truncated
              ? `\n[Preview truncated: ${preview.outputLines}/${preview.totalLines} lines, ${preview.outputBytes}/${preview.totalBytes} bytes. Full generated diffs remain in tool details; expand the TUI result or inspect via SDK/RPC.]`
              : "";
            content.push({ type: "text", text: preview.content + note });
          }
        }
        return { content, details: result.details };
      } catch (error) {
        if (request.preview || !(error instanceof RetryableApplyEditsError)) throw error;
        if (!rememberRetry(retries, toolCallId, request, error.retry, cwd)) {
          throw new Error(`${error.message}\nCompact retry unavailable because too many retries are pending.`);
        }
        throw new Error(`${error.message}\nCompact retry: ${retryPayload(toolCallId, error.retry)}`);
      }
    },

    renderCall(args, theme) {
      const label = callLabel(args);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("apply_edits "))}${theme.fg("accent", label.path)}` +
          theme.fg("dim", ` (${args.preview ? "preview; " : ""}${label.mode})`),
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      const content = result.content.find((item) => item.type === "text");
      const message = content?.type === "text" ? content.text : "";
      if (options.isPartial) return new Text(theme.fg("muted", message || "Planning edits..."), 0, 0);
      if (context.isError) {
        const lines = (message || "apply_edits failed").split("\n");
        const visible = options.expanded ? lines : lines.slice(0, 1);
        return new Text(visible.map((line) => theme.fg("error", line)).join("\n"), 0, 0);
      }

      const hasWarnings = collectWarnings(result.details).length > 0;
      const preview = result.details?.preview === true;
      let text = theme.fg(
        hasWarnings ? "warning" : preview ? "accent" : "success",
        `${hasWarnings ? "⚠" : preview ? "◇" : "✓"} ${message || (preview ? "Preview" : "Applied")}`,
      );
      const diffs = collectDiffs(result.details);
      if (diffs.length === 0 || !options.expanded) return new Text(text, 0, 0);

      for (const { path, diff } of diffs) {
        if (diffs.length > 1) text += `\n${theme.fg("muted", path)}`;
        let inHunk = false;
        const lines = (diff.endsWith("\n") ? diff.slice(0, -1) : diff).split("\n");
        for (const line of lines) {
          if (line.startsWith("@@")) inHunk = true;
          const color = inHunk && line.startsWith("+")
            ? "toolDiffAdded"
            : inHunk && line.startsWith("-")
              ? "toolDiffRemoved"
              : "toolDiffContext";
          text += `\n${theme.fg(color, line)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  };
}

export default function applyEditsExtension(pi: ExtensionAPI): void {
  const retries: RetryStore = new Map();
  const clearRetries = () => retries.clear();

  pi.registerFlag("apply-edits-with-builtins", {
    type: "boolean",
    default: false,
    description: "Keep Pi's built-in edit and write tools active alongside apply_edits",
  });
  const tool = createApplyEditsToolWithStore(retries);
  pi.registerTool(tool);

  pi.on("session_start", async () => {
    clearRetries();
    const active = pi.getActiveTools();
    const registered = pi.getAllTools().find((item) => item.name === "apply_edits");
    const ownsActiveTool = registered?.parameters === tool.parameters;
    if (
      !active.includes("apply_edits") ||
      !ownsActiveTool ||
      keepBuiltins(pi) ||
      !(await supportsExistingFileReplacement())
    ) return;
    pi.setActiveTools(active.filter((name) => name !== "edit" && name !== "write"));
  });
  pi.on("agent_settled", clearRetries);
  pi.on("session_tree", clearRetries);
  pi.on("session_shutdown", clearRetries);
}

function prepareSingleFileArguments(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error("file entry must be an object");
  assertSupportedFields(raw, SINGLE_FILE_ARGUMENT_KEYS, "file entry");

  const path = readAlias(raw, ["path", "file_path", "filePath"], "path");
  let edits = raw.edits;
  const rewrite = readAlias(raw, ["rewrite", "content"], "rewrite content");
  const onMissing = readAlias(raw, ["onMissing", "on_missing"], "onMissing");
  const requireMissing = raw.requireMissing;
  const preserveFormatting = readAlias(raw, ["preserveFormatting", "preserve_formatting"], "preserveFormatting");

  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      throw new Error("edits must be a JSON array, not malformed JSON text");
    }
  }

  const oldText = readAlias(raw, ["oldText", "old_string"], "top-level oldText");
  const newText = readAlias(raw, ["newText", "new_string"], "top-level newText");
  const endText = readAlias(raw, ["endText"], "top-level endText");
  const all = readAlias(raw, ["all", "replace_all"], "top-level all");
  const insert = readAlias(raw, ["insert"], "top-level insert");
  const hasTopLevelEdit =
    oldText !== undefined || newText !== undefined || endText !== undefined || all !== undefined || insert !== undefined;
  if (hasTopLevelEdit) {
    if (edits !== undefined || rewrite !== undefined) {
      throw new Error("Top-level edit fields cannot be combined with edits, rewrite, or content");
    }
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new Error("Top-level edit repair requires both string oldText and newText fields");
    }
    edits = [{ oldText, newText, all, insert, ...(endText === undefined ? {} : { endText }) }];
  }
  if (Array.isArray(edits)) edits = edits.map(normalizeEditAliases);
  if ((edits === undefined) === (rewrite === undefined)) {
    throw new Error("Provide exactly one of edits or rewrite");
  }
  if (edits !== undefined && (onMissing !== undefined || requireMissing !== undefined || preserveFormatting !== undefined)) {
    throw new Error("onMissing, requireMissing, and preserveFormatting are valid only with rewrite");
  }

  return {
    path,
    edits,
    rewrite,
    onMissing,
    ...(requireMissing === undefined ? {} : { requireMissing }),
    ...(preserveFormatting === undefined ? {} : { preserveFormatting }),
  };
}

function normalizeEditAliases(value: unknown): unknown {
  if (!isRecord(value)) return value;
  assertSupportedFields(
    value,
    ["oldText", "old_string", "newText", "new_string", "endText", "all", "replace_all", "insert"],
    "edit",
  );
  const endText = readAlias(value, ["endText"], "edit endText");
  return {
    oldText: readAlias(value, ["oldText", "old_string"], "edit oldText"),
    newText: readAlias(value, ["newText", "new_string"], "edit newText"),
    all: readAlias(value, ["all", "replace_all"], "edit all"),
    insert: readAlias(value, ["insert"], "edit insert"),
    ...(endText === undefined ? {} : { endText }),
  };
}

function assertSupportedFields(
  value: Record<string, unknown>,
  supported: readonly string[],
  label: string,
): void {
  const extra = Object.keys(value).filter((key) => !supported.includes(key));
  if (extra.length > 0) throw new Error(`${label} has unsupported fields: ${extra.join(", ")}`);
}

function callLabel(args: ApplyEditsParameters): { path: string; mode: string } {
  if (args.retry) {
    return { path: "previous call", mode: args.retry.oldText === undefined ? "retry create" : "retry oldText" };
  }
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

function collectWarnings(details: ApplyEditsToolDetails | undefined): string[] {
  if (!details) return [];
  return isBatchDetails(details)
    ? details.files.flatMap((file) => file.warnings)
    : details.warnings;
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
    (process.env.PI_APPLY_EDITS_KEEP_BUILTINS ?? "").trim().toLowerCase(),
  );
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("apply_edits arguments must be a JSON object");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
