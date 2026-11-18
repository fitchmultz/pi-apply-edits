import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { replaceControlCharacters, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ApplyEditsBatchDetails } from "./apply-edits.ts";
import { isRecord } from "./editing/contracts.ts";

/**
 * `details` as Pi hands it to the result renderer. Only a result returned by `execute` carries a
 * receipt. Pi builds every other result itself: `details: {}` when it refuses, blocks, or aborts
 * a call, and no `details` when the model's response failed before the call ran.
 */
type RenderedDetails = ApplyEditsBatchDetails | { readonly files?: undefined } | undefined;

/** What a card shows of a result. A result that Pi built has no file outcomes. */
interface RenderedFile {
  readonly path: string;
  readonly moveTo: string | undefined;
  readonly operation: string;
  readonly status: string;
  readonly diff: string;
  readonly preview: true | undefined;
  readonly hasWarnings: boolean;
}

interface CardReceipt {
  readonly files: readonly RenderedFile[];
  readonly preview: true | undefined;
  readonly error: string | undefined;
}

function normalizeRenderedFile(file: Readonly<Record<string, unknown>>): RenderedFile {
  return {
    path: typeof file.path === "string" ? file.path : "unknown path",
    moveTo: typeof file.moveTo === "string" ? file.moveTo : undefined,
    operation: typeof file.operation === "string" ? file.operation : "edit",
    status: typeof file.status === "string" ? file.status : "unknown",
    diff: typeof file.diff === "string" ? file.diff : "",
    preview: file.preview === true ? true : undefined,
    hasWarnings: Array.isArray(file.warnings) && file.warnings.length > 0,
  };
}

function cardReceipt(details: unknown): CardReceipt {
  if (!isRecord(details)) {
    return { files: [], preview: undefined, error: undefined };
  }
  const files = Array.isArray(details.files)
    ? details.files.filter(isRecord).map(normalizeRenderedFile)
    : [];
  return {
    files,
    preview: details.preview === true ? true : undefined,
    error: typeof details.error === "string" ? details.error : undefined,
  };
}

function outcomeStyle(
  receipt: CardReceipt,
  isError: boolean,
): {
  readonly color: "error" | "warning" | "accent" | "success";
  readonly symbol: string;
} {
  if (isError || receipt.error !== undefined) {
    return { color: "error", symbol: "✗" };
  }
  if (receipt.files.some((file) => file.hasWarnings)) {
    return { color: "warning", symbol: "⚠" };
  }
  if (receipt.preview === true) {
    return { color: "accent", symbol: "◇" };
  }
  return { color: "success", symbol: "✓" };
}

function renderDiff(diff: string, theme: Theme): string {
  let inHunk = false;
  const lines: string[] = [];
  for (const line of diff.replace(/\r?\n$/, "").split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
    }
    let color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" = "toolDiffContext";
    if (inHunk && line.startsWith("+")) {
      color = "toolDiffAdded";
    } else if (inHunk && line.startsWith("-")) {
      color = "toolDiffRemoved";
    }
    lines.push(theme.fg(color, replaceControlCharacters(line.replaceAll("\t", "   "))));
  }
  return lines.length === 0 ? "" : `\n${lines.join("\n")}`;
}

function renderFileStatus(file: RenderedFile, preview: boolean): string {
  if (!preview || file.status === "unchanged") {
    return file.status;
  }
  if (file.status === "unattempted" && file.preview === true) {
    return "planned preview";
  }
  return `${file.status} preview`;
}

function renderFile(file: RenderedFile, preview: boolean, theme: Theme): string {
  const path = replaceControlCharacters(file.path);
  const destination =
    file.moveTo === undefined ? "" : ` → ${replaceControlCharacters(file.moveTo)}`;
  const operation = replaceControlCharacters(file.operation);
  const status = replaceControlCharacters(renderFileStatus(file, preview));
  let text = `\n${theme.fg("muted", `${path}${destination} (${operation}; ${status})`)}`;
  // Failed/unattempted diffs are plans, never evidence that those bytes were published.
  if (
    !preview &&
    file.status !== "applied" &&
    file.status !== "unchanged" &&
    file.diff.length > 0
  ) {
    text += `\n${theme.fg("warning", "Planned diff (not verified applied):")}`;
  }
  return text + renderDiff(file.diff, theme);
}

function sanitizeMultiline(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map(replaceControlCharacters)
    .join("\n");
}

function extractTextMessage(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return sanitizeMultiline(item.text);
    }
  }
  return "";
}

export const editingResultRenderer: NonNullable<
  ToolDefinition<TSchema, RenderedDetails, unknown>["renderResult"]
> = (result, options, theme, context) => {
  const rawContent: unknown = result.content;
  const message = extractTextMessage(rawContent);
  if (options.isPartial) {
    return new Text(theme.fg("muted", message.length > 0 ? message : "Planning changes…"), 0, 0);
  }
  const rawDetails: unknown = result.details;
  const receipt = cardReceipt(rawDetails);
  const style = outcomeStyle(receipt, context.isError);
  const summary = (text: string): string => theme.fg(style.color, `${style.symbol} ${text}`);
  if (options.expanded) {
    const preview = receipt.preview === true;
    return new Text(
      summary(message) + receipt.files.map((file) => renderFile(file, preview, theme)).join(""),
      0,
      0,
    );
  }
  const [firstLine = "", ...laterLines] = message.split("\n");
  if (laterLines.length === 0 && receipt.files.length === 0) {
    return new Text(summary(firstLine), 0, 0);
  }
  // The expanded card adds the rest of the message and every file's outcome and diff. The hint
  // has its own row, as in Pi's own cards: appended to a long summary, it breaks across rows.
  const hint = context.keyHint("app.tools.expand", "to expand");
  return new Text(
    `${summary(firstLine)}\n${theme.fg("muted", "(")}${hint}${theme.fg("muted", ")")}`,
    0,
    0,
  );
};
