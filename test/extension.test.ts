import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SourceInfo, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import editingExtension from "../extensions/apply-edits.ts";
import { createEditingTools, EDITING_TOOL_NAMES } from "../src/tools.ts";
import { supportsExistingFileReplacement } from "../src/file-system.ts";

function harness(active = ["read", "edit", "write", ...EDITING_TOOL_NAMES] as string[], flag = false) {
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>();
  const sources = new Map<string, SourceInfo>();
  const ctx = { cwd: "/fixture", sessionManager: {} } as ExtensionContext;
  const state = { active, flag };
  const api = {
    registerFlag() {}, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
    getActiveTools: () => state.active,
    getAllTools: () => [...new Set([...tools.keys(), "read", "edit", "write"])].map((name) => ({
      name, ...tools.get(name), sourceInfo: sources.get(name) ?? {
        path: "test", source: tools.has(name) ? "test" : "builtin", scope: "temporary", origin: "top-level",
      },
    })),
    getCommands: () => [],
    setActiveTools(value: string[]) { state.active = value; }, getFlag: () => state.flag,
    events: { emit() {} },
  } as unknown as ExtensionAPI;
  editingExtension(api);
  return { state, tools, sources, emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx) };
}

const patch = (path: string, before = "before", after = "after") => `*** Begin Patch\n*** Update File: ${path}\n@@\n-${before}\n+${after}\n*** End Patch`;

test("registers exactly four focused tools with native grammar and no legacy alias", () => {
  const { tools } = harness();
  assert.deepEqual([...tools.keys()], EDITING_TOOL_NAMES);
  for (const tool of tools.values()) {
    assert.equal(tool.executionMode, "parallel");
    assert.partialDeepStrictEqual(tool.parameters, { additionalProperties: false });
    assert.equal("freeform" in tool, false);
    assert(!JSON.stringify(tool.parameters).includes('"retry"'));
  }
  for (const name of ["apply_patch", "preview_patch"]) {
    const tool = tools.get(name)!;
    assert.equal(tool.constrainedSampling && tool.constrainedSampling.type, "grammar");
    assert.partialDeepStrictEqual(tool.parameters, { required: ["input"] });
  }
});

test("startup respects active selection, keep-builtins, and custom writer ownership", async () => {
  const normal = harness();
  await normal.emit("session_start");
  const supported = await supportsExistingFileReplacement();
  assert.deepEqual(normal.state.active, supported ? ["read", ...EDITING_TOOL_NAMES] : ["read", "edit", "write", ...EDITING_TOOL_NAMES]);
  for (const active of [["edit", "write"], ["edit", "write", "preview_patch"]]) {
    const selected = harness(active);
    await selected.emit("session_start");
    assert.deepEqual(selected.state.active, active);
  }
  const flagged = harness(undefined, true);
  await flagged.emit("session_start");
  assert(flagged.state.active.includes("write"));
  const custom = harness();
  custom.sources.set("write", { path: "remote", source: "remote", scope: "temporary", origin: "top-level" });
  await custom.emit("session_start");
  assert(custom.state.active.includes("write"));
  const wrapped = harness();
  wrapped.sources.set("write", { path: "cwd", source: "git:github.com/fitchmultz/pi-change-working-dir@v0.5.0", scope: "user", origin: "top-level" });
  await wrapped.emit("session_start");
  assert.equal(wrapped.state.active.includes("write"), !supported);
  const collision = harness(["edit", "write", "apply_patch"]);
  collision.tools.set("apply_patch", { ...collision.tools.get("apply_patch")!, parameters: {} as never });
  await collision.emit("session_start");
  assert.deepEqual(collision.state.active, ["edit", "write", "apply_patch"]);
});

test("environment opt-in and later manual selection survive the first turn", async () => {
  const previous = process.env.PI_APPLY_EDITS_KEEP_BUILTINS;
  process.env.PI_APPLY_EDITS_KEEP_BUILTINS = " YES ";
  try {
    const fixture = harness();
    await fixture.emit("session_start");
    assert(fixture.state.active.includes("edit"));
    assert(fixture.state.active.includes("write"));
  } finally {
    if (previous === undefined) delete process.env.PI_APPLY_EDITS_KEEP_BUILTINS;
    else process.env.PI_APPLY_EDITS_KEEP_BUILTINS = previous;
  }
  const fixture = harness();
  await fixture.emit("before_agent_start");
  fixture.state.active = ["read", "write"];
  await fixture.emit("before_agent_start");
  assert.deepEqual(fixture.state.active, ["read", "write"]);
});

test("preparation binds literal paths and leaves optional-null validation to the host", () => {
  const tools = createEditingTools(() => "/root");
  const apply = tools.find((tool) => tool.name === "apply_patch")!;
  const input = patch("@ literal file", "*** Update File: body", "*** Move to: body");
  assert.deepEqual(apply.prepareArguments!({ input }), { input: input.replace("File: @ literal file", "File: /root/@ literal file") });
  const write = tools.find((tool) => tool.name === "write_files")!;
  const raw = { files: [{ path: "~", content: String.raw`C:\new\file\n`, mode: "create", preserveFormatting: null }], preview: null };
  assert.deepEqual(write.prepareArguments!(raw), { ...raw, files: [{ ...raw.files[0], path: "/root/~" }] });
  assert.equal(raw.files[0]?.path, "~");
  assert.throws(() => write.prepareArguments!({ path: "x", content: "y" }), /files must be an array/);
  assert.throws(() => apply.prepareArguments!({ input: "not a patch" }), /patch/i);
});

test("compaction includes partial commits while ignoring previews and uncertain paths", async () => {
  const fixture = harness();
  const edited = new Set<string>();
  await fixture.emit("session_before_compact", { preparation: {
    fileOps: { edited }, turnPrefixMessages: [], messagesToSummarize: [
      { role: "toolResult", toolName: "apply_patch", isError: true, details: { modifiedFiles: ["/committed"], error: "later file failed" } },
      { role: "toolResult", toolName: "replace_text", details: { modifiedFiles: ["/preview"], preview: true } },
      { role: "toolResult", toolName: "write_files", details: { modifiedFiles: [], files: [{ path: "/uncertain", status: "uncertain" }] } },
      { role: "toolResult", toolName: "unrelated", details: { modifiedFiles: ["/unrelated"] } },
    ],
  } });
  assert.deepEqual([...edited], ["/committed"]);
  assert.deepEqual(await fixture.emit("tool_result", { toolName: "apply_patch", details: { error: "failed", modifiedFiles: ["/committed"] } }), { isError: true });
});

test("tools return bounded preview text, full expanded diffs, and truthful receipts", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-edit-tools-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = createEditingTools();
  const write = tools.find((tool) => tool.name === "write_files")!;
  const body = `${"line\n".repeat(3_000)}FINAL-LINE\n`;
  const preview = await write.execute("preview", { files: [{ path: "new", content: body, mode: "create" }], preview: true }, undefined, undefined, { cwd: directory } as never);
  assert(preview.details?.preview);
  assert.deepEqual(preview.details.modifiedFiles, []);
  assert.deepEqual(await readdir(directory), []);
  assert.match(preview.content[1]?.type === "text" ? preview.content[1].text : "", /Preview truncated/);
  assert.match(preview.details.files[0]!.diff, /FINAL-LINE/);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
  const expanded = write.renderResult!(preview, { expanded: true, isPartial: false }, theme, { isError: false } as never).render(80);
  assert(expanded.some((line) => line.includes("FINAL-LINE")));
  for (const line of expanded) assert(visibleWidth(line) <= 80);
  const collapsed = write.renderResult!(preview, { expanded: false, isPartial: false }, theme, { isError: false } as never).render(80);
  assert(!collapsed.some((line) => line.includes("FINAL-LINE")));

  await writeFile(join(directory, "file"), "before\n");
  const apply = tools.find((tool) => tool.name === "apply_patch")!;
  const result = await apply.execute("apply", { input: patch("file") }, undefined, undefined, { cwd: directory } as never);
  assert.equal(await readFile(join(directory, "file"), "utf8"), "after\n");
  assert.deepEqual(result.details?.modifiedFiles, [join(directory, "file")]);
  assert.equal(result.details?.files[0]?.status, "applied");
  const failed = await apply.execute("fail", { input: patch("file", "missing") }, undefined, undefined, { cwd: directory } as never);
  assert(failed.details?.error);
  assert.deepEqual(failed.details.modifiedFiles, []);
  const failureView = apply.renderResult!(failed, { expanded: false, isPartial: false }, theme, { isError: true } as never).render(100).join("\n");
  assert.match(failureView, /✗/);
  assert.doesNotMatch(failureView, /✓/);
});
