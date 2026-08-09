import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
} from "../src/apply-edits.ts";
import { supportsExistingFileReplacement } from "../src/file-system.ts";

const editSchema = Type.Object({
  oldText: Type.String({
    description:
      "Anchor text to find. For replace, this is the text to remove. " +
      "For insert, this is the unique nearby text to insert before/after.",
  }),
  newText: Type.String({
    description:
      "Replacement text, or the exact text to splice when insert is set. For insert, no newline or space is inferred: " +
      'include it in newText, e.g. insert:"after", newText:"\\nimport path from \\"node:path\\";". ' +
      "May be empty only for replace (delete).",
  }),
  all: Type.Optional(
    Type.Boolean({
      description: "Apply at every non-overlapping match. Default false; unique match required.",
    }),
  ),
  insert: Type.Optional(
    StringEnum(["before", "after"] as const, {
      description:
        "Insert newText exactly before or after oldText without replacing the anchor. Zero separator: no newline or " +
        'space is added. Example: oldText:"import fs from \\"node:fs\\";", ' +
        'newText:"\\nimport path from \\"node:path\\";", insert:"after".',
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
    description: "Require the rewrite target to remain missing. Used by compact create retries.",
  }),
);

const fileSchema = Type.Object({
  path: Type.String({ minLength: 1, description: "File path, relative to the session working directory or absolute." }),
  edits: Type.Optional(
    Type.Array(editSchema, {
      minItems: 1,
      maxItems: MAX_EDITS_PER_FILE,
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
  requireMissing: requireMissingSchema,
}, { additionalProperties: false });

export const applyEditsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ minLength: 1, description: "Single-file path. Omit when using files for a multi-file batch." }),
  ),
  edits: Type.Optional(
    Type.Array(editSchema, {
      minItems: 1,
      maxItems: MAX_EDITS_PER_FILE,
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
  requireMissing: requireMissingSchema,
  files: Type.Optional(
    Type.Array(fileSchema, {
      minItems: 1,
      maxItems: MAX_BATCH_FILES,
      description:
        "Multi-file batch. Every file is planned first; nothing is written unless every file " +
        "mutation can be computed. Prefer this when changing several files together. " +
        "A rare mid-publish filesystem failure can leave earlier files already written.",
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
  "requireMissing", "oldText", "old_string", "newText", "new_string", "all", "replace_all", "insert",
] as const;
const RETRY_UNAVAILABLE =
  "Compact retry is unavailable or does not match this failure. Send a normal apply_edits request.";

export function prepareApplyEditsArguments(raw: unknown): ApplyEditsParameters {
  const value = parseArguments(raw);
  if (!isRecord(value)) return value as ApplyEditsParameters;
  if (value.retry !== undefined) throw new Error(RETRY_UNAVAILABLE);

  if (value.files !== undefined) {
    const strayTopLevel = SINGLE_FILE_ARGUMENT_KEYS.filter((name) => value[name] !== undefined);
    if (strayTopLevel.length > 0) {
      throw new Error(
        `files cannot be combined with top-level ${strayTopLevel.join(", ")}`,
      );
    }
    assertSupportedFields(value, ["files"], "apply_edits input");
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

function prepareToolArguments(raw: unknown, retries: RetryStore): ApplyEditsParameters {
  const value = parseArguments(raw);
  if (!isRecord(value) || value.retry === undefined) return prepareApplyEditsArguments(value);
  const extra = Object.keys(value).filter((key) => key !== "retry");
  if (extra.length > 0) {
    throw new Error(`retry cannot be combined with ${extra.join(", ")}`);
  }
  return expandRetry(value.retry, retries);
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

function consumeRetry(
  params: ApplyEditsParameters,
  retries: RetryStore,
): ApplyEditsRequest {
  const retry = parseRetry(params.retry);
  if (!retries.delete(retry.from)) throw new Error(RETRY_UNAVAILABLE);
  const { retry: _retry, ...request } = params;
  return request as ApplyEditsRequest;
}

function rememberRetry(
  retries: RetryStore,
  toolCallId: string,
  request: ApplyEditsRequest,
  retry: ApplyEditsRetry,
): boolean {
  if (
    toolCallId.length === 0 ||
    toolCallId.length > 512 ||
    retries.has(toolCallId) ||
    retries.size >= MAX_PENDING_RETRIES
  ) {
    return false;
  }
  retries.set(toolCallId, { request: structuredClone(request), retry });
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
  ApplyEditsToolDetails
> {
  return createApplyEditsToolWithStore(new Map());
}

function createApplyEditsToolWithStore(
  retries: RetryStore,
): ToolDefinition<typeof applyEditsSchema, ApplyEditsToolDetails> {
  return {
    name: "apply_edits",
    label: "apply edits",
    description:
      "Apply ordered text replacements/inserts, rewrite a UTF-8 text file, create one file, or apply " +
      "a multi-file batch. Provide files: [...], a single-file path with exactly one of edits or " +
      "rewrite, or the exact compact retry payload returned after an eligible failure. rewrite is " +
      "the easy whole-file path: pass the full new contents " +
      '(onMissing: "create" only when creating). edits is for small unique patches; set insert to ' +
      '"before" or "after" to splice newText at an anchor without replacing it; insert adds zero separator, so ' +
      "newText must include any newline or space. Ordered edits run " +
      "sequentially in memory; nothing is written unless every edit (and every file in a batch) can be " +
      "planned successfully. oldText matches exactly first, then tolerates only an unambiguous full-line " +
      "typography, trailing-whitespace, or uniform-indentation difference. A repeated match is an error " +
      "unless all is true. Eligible no-write failures return a single-use compact retry payload.",
    promptSnippet:
      "File writes: rewrite whole files, edits/inserts for small patches, files:[] for plan-first multi-file batches.",
    promptGuidelines: [
      "Use apply_edits for file mutations when available; it replaces built-in edit and write when safe.",
      'Use rewrite for full files or creates; use edits with short unique anchors and insert: "before"|"after" ' +
        "for surgical changes. Insert splices with zero separator; include any newline or space in newText.",
      "Use files: [...] for plan-first batches. Reuse an exact compact retry payload when one is returned.",
    ],
    parameters: applyEditsSchema,
    prepareArguments: (raw) => prepareToolArguments(raw, retries),
    executionMode: "parallel",

    async execute(toolCallId, params, signal, _onUpdate, context) {
      const request = params.retry
        ? consumeRetry(params, retries)
        : params as ApplyEditsRequest;
      try {
        const result = await applyEditsToFile(request, context.cwd, signal);
        return {
          content: [{ type: "text", text: result.summary }],
          details: result.details,
        };
      } catch (error) {
        if (!(error instanceof RetryableApplyEditsError)) throw error;
        if (!rememberRetry(retries, toolCallId, request, error.retry)) {
          throw new Error(`${error.message}\nCompact retry unavailable because too many retries are pending.`);
        }
        throw new Error(`${error.message}\nCompact retry: ${retryPayload(toolCallId, error.retry)}`);
      }
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

      const hasWarnings = collectWarnings(result.details).length > 0;
      let text = theme.fg(
        hasWarnings ? "warning" : "success",
        `${hasWarnings ? "⚠" : "✓"} ${message || "Applied"}`,
      );
      const diffs = collectDiffs(result.details);
      if (diffs.length === 0 || !options.expanded) return new Text(text, 0, 0);

      const limit = 200;
      let shown = 0;
      let hasMore = false;
      const append = (
        color: "muted" | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext",
        line: string,
      ): boolean => {
        if (shown >= limit) {
          hasMore = true;
          return false;
        }
        text += `\n${theme.fg(color, line)}`;
        shown += 1;
        return true;
      };
      outer: for (const { path, diff } of diffs) {
        if (diffs.length > 1 && !append("muted", `--- ${path}`)) break;
        let inHunk = false;
        const lines = (diff.endsWith("\n") ? diff.slice(0, -1) : diff).split("\n");
        for (const line of lines) {
          if (line.startsWith("@@")) inHunk = true;
          const color = inHunk && line.startsWith("+")
            ? "toolDiffAdded"
            : inHunk && line.startsWith("-")
              ? "toolDiffRemoved"
              : "toolDiffContext";
          if (!append(color, line)) break outer;
        }
      }
      if (hasMore) {
        text += `\n${theme.fg("muted", "... more diff lines")}`;
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
  if ((edits === undefined) === (rewrite === undefined)) {
    throw new Error("Provide exactly one of edits or rewrite");
  }
  if (edits !== undefined && (onMissing !== undefined || requireMissing !== undefined)) {
    throw new Error("onMissing and requireMissing are valid only with rewrite");
  }

  return {
    path,
    edits,
    rewrite,
    onMissing,
    ...(requireMissing === undefined ? {} : { requireMissing }),
  };
}

function normalizeEditAliases(value: unknown): unknown {
  if (!isRecord(value)) return value;
  assertSupportedFields(
    value,
    ["oldText", "old_string", "newText", "new_string", "all", "replace_all", "insert"],
    "edit",
  );
  return {
    oldText: readAlias(value, ["oldText", "old_string"], "edit oldText"),
    newText: readAlias(value, ["newText", "new_string"], "edit newText"),
    all: readAlias(value, ["all", "replace_all"], "edit all"),
    insert: readAlias(value, ["insert"], "edit insert"),
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
