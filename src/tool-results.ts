import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ApplyEditsBatchDetails } from "./apply-edits.ts";
import type { ReadonlyEditingExecution } from "./editing/contracts.ts";
import { mutableDetails } from "./editing/receipts.ts";

const matchSchema = Type.Object({
  index: Type.Number(),
  strategy: StringEnum([
    "exact",
    "normalized",
    "indent-normalized",
    "whitespace",
    "typography",
  ] as const),
  replacements: Type.Number(),
  lines: Type.Array(Type.Number()),
  linesTruncated: Type.Optional(Type.Boolean()),
});

const fileReceiptSchema = Type.Object({
  path: Type.String(),
  operation: StringEnum([
    "edit",
    "rewrite",
    "create",
    "patch",
    "delete",
    "move",
    "no_change",
  ] as const),
  status: StringEnum(["applied", "unchanged", "failed", "unattempted", "uncertain"] as const, {
    description: "Per-file outcome. Preview changes remain unattempted, never applied.",
  }),
  preview: Type.Optional(Type.Literal(true)),
  moveTo: Type.Optional(Type.String()),
  editsRequested: Type.Number(),
  editsApplied: Type.Number(),
  matches: Type.Array(matchSchema),
  bytesBefore: Type.Number(),
  bytesAfter: Type.Number(),
  addedLines: Type.Optional(Type.Number()),
  deletedLines: Type.Optional(Type.Number()),
  diff: Type.String(),
  diffTruncated: Type.Boolean(),
  warnings: Type.Array(Type.String()),
});

export const receiptSchema = Type.Object({
  summary: Type.String({
    description:
      "Compact outcome. For compact output, emit this and the publication facts you need; files hold complete generated diffs. Detailed failure guidance is in error.",
  }),
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
        ? "\n[Preview truncated. Inspect per-file generated diffs in direct details or nested receipts; diffTruncated marks omitted diffs.]"
        : ""),
    truncated: preview.truncated || result.details.files.some((file) => file.diffTruncated),
  };
}

function structuredDetails(result: ReadonlyEditingExecution): ApplyEditsBatchDetails {
  const details = mutableDetails(result.details);
  for (const file of details.files) {
    if (file.preview === undefined) {
      delete file.preview;
    }
    if (file.moveTo === undefined) {
      delete file.moveTo;
    }
    if (file.addedLines === undefined) {
      delete file.addedLines;
    }
    if (file.deletedLines === undefined) {
      delete file.deletedLines;
    }
    for (const match of file.matches) {
      if (match.linesTruncated === undefined) {
        delete match.linesTruncated;
      }
    }
  }
  return details;
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
  // Separate copies keep details and structuredContent independently mutable by hooks and callers.
  const receipt = structuredDetails(result);
  const structuredContent: Static<typeof receiptSchema> = {
    summary:
      result.details.error === undefined
        ? result.summary
        : `Editing failed (${result.details.modifiedFiles.length} verified committed paths). Inspect error and per-file outcomes before retrying.`,
    modifiedFiles: receipt.modifiedFiles,
    ...(receipt.preview === true ? { preview: true } : {}),
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
    ...(preview === undefined ? {} : { previewDiff: preview.text }),
    ...(preview?.truncated === true ? { previewDiffTruncated: true } : {}),
    files: receipt.files,
  };
  return {
    content,
    details: mutableDetails(result.details),
    structuredContent,
    isError: result.details.error !== undefined,
  };
}
