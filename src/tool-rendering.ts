import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ApplyEditsBatchDetails } from "./apply-edits.ts";

interface RenderedFile {
  readonly path: string;
  readonly moveTo?: string;
  readonly operation: string;
  readonly status: string;
  readonly diff: string;
}

function outcomeStyle(
  failed: boolean,
  warnings: boolean,
  preview: boolean,
): {
  readonly color: "error" | "warning" | "accent" | "success";
  readonly symbol: string;
} {
  if (failed) {
    return { color: "error", symbol: "✗" };
  }
  if (warnings) {
    return { color: "warning", symbol: "⚠" };
  }
  if (preview) {
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

function renderFile(file: RenderedFile, preview: boolean, theme: Theme): string {
  const destination = file.moveTo === undefined ? "" : ` → ${file.moveTo}`;
  const status = preview ? "preview" : file.status;
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

function renderSummary(
  message: string,
  flags: {
    readonly expanded: boolean;
    readonly failed: boolean;
    readonly warnings: boolean;
    readonly preview: boolean;
  },
  theme: Theme,
): string {
  const style = outcomeStyle(flags.failed, flags.warnings, flags.preview);
  const summary = flags.expanded ? message : (message.split("\n")[0] ?? "");
  return theme.fg(style.color, `${style.symbol} ${summary}`);
}

export const editingResultRenderer: NonNullable<
  ToolDefinition<TSchema, ApplyEditsBatchDetails | undefined, unknown>["renderResult"]
> = (result, options, theme, context) => {
  const message = result.content.find((item) => item.type === "text")?.text ?? "";
  if (options.isPartial) {
    return new Text(theme.fg("muted", message.length > 0 ? message : "Planning changes…"), 0, 0);
  }
  const details = result.details;
  if (details === undefined) {
    return new Text(
      renderSummary(
        message,
        { expanded: options.expanded, failed: context.isError, warnings: false, preview: false },
        theme,
      ),
      0,
      0,
    );
  }
  const failed = context.isError || details.error !== undefined;
  const warnings = details.files.some((file) => file.warnings.length > 0);
  const preview = details.preview === true;
  let text = renderSummary(
    message,
    { expanded: options.expanded, failed, warnings, preview },
    theme,
  );
  if (options.expanded) {
    for (const file of details.files) {
      text += renderFile(file, preview, theme);
    }
  }
  return new Text(text, 0, 0);
};
