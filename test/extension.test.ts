import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import applyEditsExtension, {
  type ApplyEditsParameters,
  createApplyEditsTool,
  prepareApplyEditsArguments,
} from "../extensions/apply-edits.ts";
import type { ApplyEditsDetails } from "../src/apply-edits.ts";

function singleDetails(details: unknown): ApplyEditsDetails {
  if (!details || typeof details !== "object" || "files" in details) {
    throw new Error("expected single-file details");
  }
  return details as ApplyEditsDetails;
}


interface ExtensionHarness {
  active: string[];
  flag: boolean;
  tool?: ToolDefinition;
  sessionStart?: () => void;
  agentSettled?: () => void;
}

function prepare(
  tool: ReturnType<typeof createApplyEditsTool>,
  raw: unknown,
): ApplyEditsParameters {
  if (!tool.prepareArguments) throw new Error("expected prepareArguments");
  return tool.prepareArguments(raw);
}

function createHarness(active: string[], flag = false): { api: ExtensionAPI; state: ExtensionHarness } {
  const state: ExtensionHarness = { active, flag };
  const api = {
    registerFlag: () => undefined,
    registerTool: (tool: ToolDefinition) => {
      state.tool = tool;
    },
    on: (event: string, handler: () => void) => {
      if (event === "session_start") state.sessionStart = handler;
      if (event === "agent_settled") state.agentSettled = handler;
    },
    getActiveTools: () => state.active,
    setActiveTools: (tools: string[]) => {
      state.active = tools;
    },
    getFlag: () => state.flag,
  } as unknown as ExtensionAPI;
  return { api, state };
}

test("argument preparation repairs only common unambiguous edit and write shapes", () => {
  assert.deepEqual(
    prepareApplyEditsArguments({
      file_path: "a.ts",
      old_string: "before",
      new_string: "after",
      replace_all: true,
    }),
    {
      path: "a.ts",
      edits: [{ oldText: "before", newText: "after", all: true, insert: undefined }],
      rewrite: undefined,
      onMissing: undefined,
    },
  );

  assert.deepEqual(prepareApplyEditsArguments({ path: "new.ts", content: "hello\n", on_missing: "create" }), {
    path: "new.ts",
    edits: undefined,
    rewrite: "hello\n",
    onMissing: "create",
  });

  assert.deepEqual(
    prepareApplyEditsArguments({
      path: "a.ts",
      edits: '[{"old_string":"a","new_string":"b","replace_all":false}]',
    }),
    {
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b", all: false, insert: undefined }],
      rewrite: undefined,
      onMissing: undefined,
    },
  );
});

test("argument preparation rejects conflicting aliases instead of choosing one", () => {
  assert.throws(
    () => prepareApplyEditsArguments({ path: "a.ts", file_path: "b.ts", rewrite: "x" }),
    /Conflicting path fields/,
  );
  assert.throws(
    () => prepareApplyEditsArguments({ path: "a.ts", rewrite: "x", content: "y" }),
    /Conflicting rewrite content fields/,
  );
  assert.throws(
    () =>
      prepareApplyEditsArguments({
        path: "a.ts",
        edits: [{ oldText: "a", old_string: "b", newText: "c" }],
      }),
    /Conflicting edit oldText fields/,
  );
  assert.throws(
    () =>
      prepareApplyEditsArguments({
        path: "a.ts",
        edits: [{ oldText: "a", newText: "b" }],
        oldText: "a",
        newText: "b",
      }),
    /cannot be combined/,
  );

  const bothModes = prepareApplyEditsArguments({
    path: "a.ts",
    edits: [{ oldText: "a", newText: "b" }],
    content: "whole file",
  });
  assert.equal(Array.isArray(bothModes.edits), true);
  assert.equal(bothModes.rewrite, "whole file");
});

test("factory registers apply_edits and hides built-ins at session start", () => {
  const { api, state } = createHarness(["read", "bash", "edit", "write", "apply_edits"]);
  applyEditsExtension(api);

  assert.equal(state.tool?.name, "apply_edits");
  state.sessionStart?.();
  assert.deepEqual(state.active, ["read", "bash", "apply_edits"]);

  state.active = ["read", "edit", "write", "apply_edits"];
  state.sessionStart?.();
  assert.deepEqual(state.active, ["read", "apply_edits"]);
});

test("factory respects CLI, environment, and registry availability", () => {
  const withFlag = createHarness(["edit", "write", "apply_edits"], true);
  applyEditsExtension(withFlag.api);
  withFlag.state.sessionStart?.();
  assert.deepEqual(withFlag.state.active, ["edit", "write", "apply_edits"]);

  const prior = process.env.PI_APPLY_EDITS_KEEP_BUILTINS;
  process.env.PI_APPLY_EDITS_KEEP_BUILTINS = "yes";
  try {
    const withEnvironment = createHarness(["edit", "write", "apply_edits"]);
    applyEditsExtension(withEnvironment.api);
    withEnvironment.state.sessionStart?.();
    assert.deepEqual(withEnvironment.state.active, ["edit", "write", "apply_edits"]);
  } finally {
    if (prior === undefined) delete process.env.PI_APPLY_EDITS_KEEP_BUILTINS;
    else process.env.PI_APPLY_EDITS_KEEP_BUILTINS = prior;
  }

  const excluded = createHarness(["edit", "write"]);
  applyEditsExtension(excluded.api);
  excluded.state.sessionStart?.();
  assert.deepEqual(excluded.state.active, ["edit", "write"]);
});

test("factory clears unused compact retries when the agent settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-apply-edits-settled-retry-"));
  try {
    const { api, state } = createHarness(["apply_edits"]);
    applyEditsExtension(api);
    const tool = state.tool as ReturnType<typeof createApplyEditsTool>;
    const original = prepare(tool, { path: "new.txt", rewrite: "content\n" });

    await assert.rejects(
      tool.execute(
        "call-settled",
        original,
        undefined,
        undefined,
        { cwd: directory } as never,
      ),
      /Compact retry/,
    );
    state.agentSettled?.();
    assert.throws(
      () => prepare(tool, { retry: { from: "call-settled" } }),
      /Compact retry is unavailable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool execution uses the session cwd and returns compact evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-apply-edits-extension-test-"));
  try {
    const path = join(directory, "file.txt");
    await writeFile(path, "before\n");
    const tool = createApplyEditsTool();
    const result = await tool.execute(
      "call-1",
      { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
      undefined,
      undefined,
      { cwd: directory } as never,
    );

    assert.equal(await readFile(path, "utf8"), "after\n");
    assert.equal(result.content[0]?.type, "text");
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Edited file\.txt/);
    assert.equal(singleDetails(result.details).operation, "edit");
    assert.match(singleDetails(result.details).diff ?? "", /-before[\s\S]*\+after/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renderer keeps collapsed output compact and exposes the diff when expanded", () => {
  const tool = createApplyEditsTool();
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as never;
  const result = {
    content: [{ type: "text" as const, text: "Edited file.txt: 1 ordered edit (+1/-1)." }],
    details: {
      path: "file.txt",
      operation: "edit" as const,
      editsRequested: 1,
      editsApplied: 1,
      matches: [],
      bytesBefore: 7,
      bytesAfter: 6,
      addedLines: 1,
      deletedLines: 1,
      diff: "--- file.txt\n+++ file.txt\n@@ -1 +1 @@\n-before\n+after\n",
      diffTruncated: false,
      warnings: [],
    },
  };
  const context = { isError: false } as never;
  const collapsed = tool.renderResult?.(result, { expanded: false, isPartial: false }, theme, context);
  const expanded = tool.renderResult?.(result, { expanded: true, isPartial: false }, theme, context);

  const collapsedLines = collapsed?.render(80) ?? [];
  const expandedLines = expanded?.render(80) ?? [];
  assert.equal(collapsedLines.some((line) => line.includes("-before")), false);
  assert.equal(expandedLines.some((line) => line.includes("-before")), true);
  for (const line of [...collapsedLines, ...expandedLines]) assert(visibleWidth(line) <= 80);
});

test("tool contract covers rewrite, insert, and multi-file batch", () => {
  const tool = createApplyEditsTool();
  assert.match(tool.description, /multi-file batch/);
  assert.match(tool.description, /insert/);
  assert.match(tool.description, /onMissing: "create"/);
  assert.match(tool.description, /easy whole-file path/);
  assert.match(tool.description, /compact retry/);
  assert.match(tool.promptSnippet ?? "", /files:\[\]/);
  assert(tool.promptGuidelines?.some((g) => /no oldText matching/.test(g)));
  assert(tool.promptGuidelines?.some((g) => /insert: "before"\|\"after"/.test(g)));
  assert(tool.promptGuidelines?.some((g) => /files: \[\{path/.test(g)));
});

test("argument preparation accepts multi-file batches and insert", () => {
  assert.deepEqual(
    prepareApplyEditsArguments({
      files: [
        { path: "a.ts", old_string: "a", new_string: "b" },
        { file_path: "b.ts", edits: [{ oldText: "x", newText: "\ny", insert: "after" }] },
      ],
    }),
    {
      files: [
        { path: "a.ts", edits: [{ oldText: "a", newText: "b", all: undefined, insert: undefined }], rewrite: undefined, onMissing: undefined },
        { path: "b.ts", edits: [{ oldText: "x", newText: "\ny", all: undefined, insert: "after" }], rewrite: undefined, onMissing: undefined },
      ],
    },
  );
  assert.throws(
    () => prepareApplyEditsArguments({ path: "a.ts", files: [{ path: "b.ts", rewrite: "x" }] }),
    /files cannot be combined/,
  );
  assert.throws(
    () =>
      prepareApplyEditsArguments({
        files: [{ path: "b.ts", rewrite: "x" }],
        old_string: "a",
        new_string: "b",
      }),
    /files cannot be combined with top-level old_string, new_string/,
  );
});

test("tool execution applies a multi-file batch from the session cwd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-apply-edits-batch-extension-"));
  try {
    await writeFile(join(directory, "a.txt"), "a\n");
    await writeFile(join(directory, "b.txt"), "b\n");
    const tool = createApplyEditsTool();
    const result = await tool.execute(
      "call-batch",
      {
        files: [
          { path: "a.txt", edits: [{ oldText: "a", newText: "A" }] },
          { path: "b.txt", edits: [{ oldText: "b", newText: "!", insert: "after" }] },
        ],
      },
      undefined,
      undefined,
      { cwd: directory } as never,
    );
    assert.equal(await readFile(join(directory, "a.txt"), "utf8"), "A\n");
    assert.equal(await readFile(join(directory, "b.txt"), "utf8"), "b!\n");
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Updated 2 files/);
    assert.equal("files" in (result.details ?? {}), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compact create retry reuses full bodies and is single-use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-apply-edits-create-retry-"));
  try {
    const tool = createApplyEditsTool();
    await writeFile(join(directory, "existing.txt"), "before\n");
    const original = {
      files: [
        { path: "a.txt", rewrite: "A body\n" },
        { path: "existing.txt", rewrite: "after\n" },
        { path: "b.txt", rewrite: "B body\n" },
      ],
    };
    await assert.rejects(
      tool.execute(
        "call-create",
        prepare(tool, original),
        undefined,
        undefined,
        { cwd: directory } as never,
      ),
      /Compact retry:.*"from":"call-create"/s,
    );
    await assert.rejects(readFile(join(directory, "a.txt")), /ENOENT/);

    const retry = { retry: { from: "call-create" } };
    const expanded = prepare(tool, retry);
    assert.equal(expanded.retry, undefined);
    assert.equal(expanded.files?.[0]?.rewrite, "A body\n");
    assert.equal(expanded.files?.[1]?.rewrite, "after\n");
    assert.equal(expanded.files?.[2]?.rewrite, "B body\n");
    assert.equal(expanded.files?.[0]?.onMissing, "create");
    assert.equal(expanded.files?.[0]?.requireMissing, true);
    assert.equal(expanded.files?.[1]?.onMissing, undefined);
    assert.equal(expanded.files?.[1]?.requireMissing, undefined);
    assert.equal(expanded.files?.[2]?.onMissing, "create");
    assert.equal(expanded.files?.[2]?.requireMissing, true);
    assert.throws(() => prepare(tool, retry), /Compact retry is unavailable/);

    await tool.execute(
      "call-create-retry",
      expanded,
      undefined,
      undefined,
      { cwd: directory } as never,
    );
    assert.equal(await readFile(join(directory, "a.txt"), "utf8"), "A body\n");
    assert.equal(await readFile(join(directory, "existing.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(directory, "b.txt"), "utf8"), "B body\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compact oldText retry changes only the failed anchor in a five-file batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-apply-edits-old-text-retry-"));
  try {
    const tool = createApplyEditsTool();
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: `${index}.txt`,
      edits: [{
        oldText: index === 4 ? "target" : `value-${index}`,
        newText: index === 4 ? "changed" : `VALUE-${index}`,
      }],
    }));
    for (let index = 0; index < 4; index++) {
      await writeFile(join(directory, `${index}.txt`), `value-${index}\n`);
    }
    await writeFile(join(directory, "4.txt"), "target one\ntarget two\n");

    await assert.rejects(
      tool.execute(
        "call-old-text",
        prepare(tool, { files }),
        undefined,
        undefined,
        { cwd: directory } as never,
      ),
      /files\[4\].*Compact retry:.*"from":"call-old-text".*"oldText"/s,
    );
    assert.equal(await readFile(join(directory, "0.txt"), "utf8"), "value-0\n");

    const expanded = prepare(tool, {
      retry: {
        from: "call-old-text",
        oldText: "target one",
      },
    });
    assert.equal(expanded.files?.length, 5);
    assert.equal(expanded.files?.[0]?.edits?.[0]?.oldText, "value-0");
    assert.equal(expanded.files?.[4]?.edits?.[0]?.oldText, "target one");

    await tool.execute(
      "call-old-text-retry",
      expanded,
      undefined,
      undefined,
      { cwd: directory } as never,
    );
    assert.equal(await readFile(join(directory, "0.txt"), "utf8"), "VALUE-0\n");
    assert.equal(await readFile(join(directory, "4.txt"), "utf8"), "changed\ntarget two\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("argument preparation preserves canonical string content exactly", () => {
  assert.equal(
    prepareApplyEditsArguments({
      path: "a.ts",
      rewrite: "line1\\nline2\\n",
      onMissing: "create",
    }).rewrite,
    "line1\\nline2\\n",
  );

  assert.equal(
    prepareApplyEditsArguments({
      path: "a.ts",
      rewrite: String.raw`Use \n for newline.\nNext line.\n`,
    }).rewrite,
    String.raw`Use \n for newline.\nNext line.\n`,
  );

  assert.equal(
    prepareApplyEditsArguments({
      path: "a.ts",
      rewrite: 'const p = "C:\\new\\file";',
    }).rewrite,
    'const p = "C:\\new\\file";',
  );
});
