import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ApplyEditsBatchDetails } from "./apply-edits.ts";
import type { ReadonlyEditingExecution, ReadonlyFileReceipt } from "./editing/contracts.ts";
import { mutableDetails } from "./editing/receipts.ts";

const fileReceiptSchema = Type.Object({
  path: Type.String(),
  operation: StringEnum(["edit", "rewrite", "create", "patch", "delete", "move", "no_change"]),
  status: StringEnum(["applied", "unchanged", "failed", "unattempted", "uncertain"], {
    description: "Per-file outcome. Preview changes remain unattempted, never applied.",
  }),
  moveTo: Type.Optional(Type.String()),
  addedLines: Type.Optional(Type.Number()),
  deletedLines: Type.Optional(Type.Number()),
  warnings: Type.Array(Type.String()),
});

export const receiptSchema = Type.Object({
  summary: Type.String({ description: "Compact outcome. Detailed failure guidance is in error." }),
  modifiedFiles: Type.Array(Type.String(), {
    description:
      "Verified committed absolute paths, including partial-error commits and both paths of completed moves. Excludes preview, unchanged, and uncertain paths.",
  }),
  files: Type.Array(fileReceiptSchema),
  preview: Type.Optional(Type.Literal(true)),
  error: Type.Optional(Type.String()),
  previewDiff: Type.Optional(Type.String()),
  previewDiffTruncated: Type.Optional(Type.Literal(true)),
});

function compactFile(file: ReadonlyFileReceipt): Static<typeof fileReceiptSchema> {
  return {
    path: file.path,
    operation: file.operation,
    status: file.status,
    warnings: [...file.warnings],
    ...(file.moveTo === undefined ? {} : { moveTo: file.moveTo }),
    ...(file.addedLines === undefined ? {} : { addedLines: file.addedLines }),
    ...(file.deletedLines === undefined ? {} : { deletedLines: file.deletedLines }),
  };
}

function previewDiff(
  result: ReadonlyEditingExecution,
): { readonly text: string; readonly truncated: boolean } | undefined {
  if (result.details.preview !== true) {
    return;
  }
  const diffs = result.details.files
    .filter((file) => file.diff.length > 0)
    .map((file) => `${file.path}\n${file.diff}`)
    .join("\n");
  if (diffs.length === 0) {
    return;
  }
  const preview = truncateHead(diffs);
  return {
    text:
      preview.content +
      (preview.truncated
        ? "\n[Preview truncated. Narrow the preview for more detail. Full generated diffs are retained only in direct tool results, not nested calls.]"
        : ""),
    truncated: preview.truncated || result.details.files.some((file) => file.diffTruncated),
  };
}

export function toolResult(result: ReadonlyEditingExecution): {
  content: { type: "text"; text: string }[];
  details: ApplyEditsBatchDetails;
  structuredContent: JsonValue;
  isError: boolean;
} {
  const preview = previewDiff(result);
  const content: { type: "text"; text: string }[] = [{ type: "text", text: result.summary }];
  if (preview !== undefined) {
    content.push({ type: "text", text: preview.text });
  }
  const structuredContent: Static<typeof receiptSchema> = {
    summary:
      result.details.error === undefined
        ? result.summary
        : `Editing failed (${result.details.modifiedFiles.length} verified committed paths). Inspect error and per-file outcomes before retrying.`,
    modifiedFiles: [...result.details.modifiedFiles],
    files: result.details.files.map(compactFile),
    ...(result.details.preview === true ? { preview: true } : {}),
    ...(result.details.error === undefined ? {} : { error: result.details.error }),
    ...(preview === undefined ? {} : { previewDiff: preview.text }),
    ...(preview?.truncated === true ? { previewDiffTruncated: true } : {}),
  };
  return {
    content,
    details: mutableDetails(result.details),
    structuredContent,
    isError: result.details.error !== undefined,
  };
}
