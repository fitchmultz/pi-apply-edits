import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ApplyEditsBatchDetails } from "./apply-edits.ts";

/**
 * `details` as Pi hands it to the result renderer. Only a result returned by `execute` carries a
 * receipt. Pi builds every other result itself: `details: {}` when it refuses, blocks, or aborts
 * a call, and no `details` when the model's response failed before the call ran.
 */
type RenderedDetails = ApplyEditsBatchDetails | { readonly files?: undefined } | undefined;

/** What a card shows of a result. A result that Pi built has no file outcomes. */
type CardReceipt = Readonly<Pick<ApplyEditsBatchDetails, "files" | "preview" | "error">>;

type RenderedFile = Readonly<
  Pick<
    ApplyEditsBatchDetails["files"][number],
    "path" | "moveTo" | "operation" | "status" | "diff" | "preview"
  >
>;

function cardReceipt(details: RenderedDetails): CardReceipt {
  return details?.files === undefined ? { files: [] } : details;
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
  if (receipt.files.some((file) => file.warnings.length > 0)) {
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
  for (const line of diff.replace(/\n$/, "").split("\n")) {
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
    lines.push(theme.fg(color, line));
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
  const destination = file.moveTo === undefined ? "" : ` → ${file.moveTo}`;
  const status = renderFileStatus(file, preview);
  let text = `\n${theme.fg("muted", `${file.path}${destination} (${file.operation}; ${status})`)}`;
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

export const editingResultRenderer: NonNullable<
  ToolDefinition<TSchema, RenderedDetails, unknown>["renderResult"]
> = (result, options, theme, context) => {
  const message = result.content.find((item) => item.type === "text")?.text ?? "";
  if (options.isPartial) {
    return new Text(theme.fg("muted", message.length > 0 ? message : "Planning changes…"), 0, 0);
  }
  const receipt = cardReceipt(result.details);
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
