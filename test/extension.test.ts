import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createAgentSession,
  initTheme,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type SourceInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import editingExtension from "../extensions/apply-edits.ts";
import { createEditingTools, EDITING_TOOL_NAMES } from "../src/tools.ts";
import { supportsExistingFileReplacement } from "../src/file-system.ts";

async function harness(
  t: TestContext,
  active: readonly string[] = ["read", "edit", "write", ...EDITING_TOOL_NAMES],
  flag = false,
  cwd?: string,
) {
  const root = cwd ?? (await realpath(await mkdtemp(join(tmpdir(), "pi-edit-extension-"))));
  const sources = new Map<string, SourceInfo>();
  const tools = new Map<string, ToolDefinition<TSchema, unknown, unknown>>();
  const state = { active: [...active] };
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        // Mock selection/provenance only. Contexts, registration, dispatch and SDK shapes are real.
        const getAllTools = pi.getAllTools.bind(pi);
        t.mock.method(pi, "getAllTools", () =>
          getAllTools().map((item) =>
            Object.assign({}, item, {
              parameters: tools.get(item.name)?.parameters ?? item.parameters,
              sourceInfo: sources.get(item.name) ?? item.sourceInfo,
            }),
          ),
        );
        t.mock.method(pi, "getActiveTools", () => state.active);
        t.mock.method(pi, "setActiveTools", (value: readonly string[]) => {
          state.active = [...value];
        });
        t.mock.method(pi, "getFlag", () => flag);
        editingExtension(pi);
      },
    ],
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: loader,
    modelRuntime: runtime,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(root),
  });
  t.after(async () => {
    session.dispose();
    if (cwd === undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });
  for (const registered of session.extensionRunner.getAllRegisteredTools()) {
    tools.set(registered.definition.name, registered.definition);
  }
  return { state, tools, sources, session };
}

function renderContext(cwd: string, isError = false) {
  return {
    args: { files: [], input: "" },
    toolCallId: "render-fixture",
    cwd,
    state: undefined,
    lastComponent: undefined,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError,
    durationMs: undefined,
    outputPad: 1,
    invalidate() {
      // There is no live TUI to invalidate in this rendered-output fixture.
    },
  };
}

const patch = (path: string, before = "before", after = "after") =>
  `*** Begin Patch\n*** Update File: ${path}\n@@\n-${before}\n+${after}\n*** End Patch`;

test("registers exactly four focused tools with native grammar and no legacy alias", async (t) => {
  const { tools } = await harness(t);
  assert.deepEqual([...tools.keys()], EDITING_TOOL_NAMES);
  for (const tool of tools.values()) {
    assert.equal(tool.executionMode, "parallel");
    assert.partialDeepStrictEqual(tool.parameters, { additionalProperties: false });
    assert.equal("freeform" in tool, false);
    assert(!JSON.stringify(tool.parameters).includes('"retry"'));
  }
  for (const name of ["apply_patch", "preview_patch"]) {
    const tool = tools.get(name);
    assert(tool);
    assert.equal(
      tool.constrainedSampling === false ? false : tool.constrainedSampling?.type,
      "grammar",
    );
    assert.partialDeepStrictEqual(tool.parameters, { required: ["input"] });
  }
});

test("startup respects active selection, keep-builtins, and custom writer ownership", async (t) => {
  const normal = await harness(t);
  await normal.session.extensionRunner.emit({ type: "session_start", reason: "new" });
  const supported = await supportsExistingFileReplacement();
  assert.deepEqual(
    normal.state.active,
    supported ? ["read", ...EDITING_TOOL_NAMES] : ["read", "edit", "write", ...EDITING_TOOL_NAMES],
  );
  await Promise.all(
    [
      ["edit", "write"],
      ["edit", "write", "preview_patch"],
    ].map(async (active) => {
      const selected = await harness(t, active);
      await selected.session.extensionRunner.emit({ type: "session_start", reason: "new" });
      assert.deepEqual(selected.state.active, active);
    }),
  );
  const flagged = await harness(t, undefined, true);
  await flagged.session.extensionRunner.emit({ type: "session_start", reason: "new" });
  assert(flagged.state.active.includes("write"));
  const custom = await harness(t);
  custom.sources.set("write", {
    path: "remote",
    source: "remote",
    scope: "temporary",
    origin: "top-level",
  });
  await custom.session.extensionRunner.emit({ type: "session_start", reason: "new" });
  assert(custom.state.active.includes("write"));
  const wrapped = await harness(t);
  wrapped.sources.set("write", {
    path: "cwd",
    source: "git:github.com/fitchmultz/pi-change-working-dir@v0.5.0",
    scope: "user",
    origin: "top-level",
  });
  await wrapped.session.extensionRunner.emit({ type: "session_start", reason: "new" });
  assert.equal(wrapped.state.active.includes("write"), !supported);
  const collision = await harness(t, ["edit", "write", "apply_patch"]);
  const registered = collision.tools.get("apply_patch");
  assert(registered);
  collision.tools.set("apply_patch", { ...registered, parameters: {} });
  await collision.session.extensionRunner.emit({ type: "session_start", reason: "new" });
  assert.deepEqual(collision.state.active, ["edit", "write", "apply_patch"]);
});

test("environment opt-in and later manual selection survive the first turn", async (t) => {
  const previous = process.env.PI_APPLY_EDITS_KEEP_BUILTINS;
  process.env.PI_APPLY_EDITS_KEEP_BUILTINS = " YES ";
  try {
    const fixture = await harness(t);
    await fixture.session.extensionRunner.emit({ type: "session_start", reason: "new" });
    assert(fixture.state.active.includes("edit"));
    assert(fixture.state.active.includes("write"));
  } finally {
    if (previous === undefined) {
      delete process.env.PI_APPLY_EDITS_KEEP_BUILTINS;
    } else {
      process.env.PI_APPLY_EDITS_KEEP_BUILTINS = previous;
    }
  }
  const fixture = await harness(t);
  await fixture.session.extensionRunner.emitBeforeAgentStart("fixture", undefined, {
    cwd: fixture.session.extensionRunner.createContext().cwd,
    selectedTools: [],
  });
  fixture.state.active = ["read", "write"];
  await fixture.session.extensionRunner.emitBeforeAgentStart("fixture", undefined, {
    cwd: fixture.session.extensionRunner.createContext().cwd,
    selectedTools: [],
  });
  assert.deepEqual(fixture.state.active, ["read", "write"]);
});

test("preparation binds literal paths and leaves optional-null validation to the host", () => {
  const [apply, , write] = createEditingTools(() => "/root");
  const prepareApply = apply.prepareArguments;
  const prepareWrite = write.prepareArguments;
  assert(prepareApply);
  assert(prepareWrite);
  const input = patch("@ literal file", "*** Update File: body", "*** Move to: body");
  assert.deepEqual(prepareApply({ input }), {
    input: input.replace("File: @ literal file", "File: /root/@ literal file"),
  });
  const raw = {
    files: [
      { path: "~", content: String.raw`C:\new\file\n`, mode: "create", preserveFormatting: null },
    ],
    preview: null,
  };
  assert.deepEqual(prepareWrite(raw), { ...raw, files: [{ ...raw.files[0], path: "/root/~" }] });
  assert.equal(raw.files[0]?.path, "~");
  assert.throws(() => prepareWrite({ path: "x", content: "y" }), /files must be an array/);
  assert.throws(() => prepareApply({ input: "not a patch" }), /patch/i);
});

test("compaction includes partial commits while ignoring previews and uncertain paths", async (t) => {
  const fixture = await harness(t);
  const edited = new Set<string>();
  await fixture.session.extensionRunner.emit({
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    branchEntries: [],
    signal: new AbortController().signal,
    preparation: {
      firstKeptEntryId: "fixture",
      isSplitTurn: false,
      tokensBefore: 0,
      settings: { enabled: true, keepRecentTokens: 0, reserveTokens: 0 },
      fileOps: { edited, read: new Set<string>(), written: new Set<string>() },
      turnPrefixMessages: [],
      messagesToSummarize: [
        {
          role: "toolResult",
          toolCallId: "fixture",
          content: [],
          timestamp: 0,
          toolName: "apply_patch",
          isError: true,
          details: { modifiedFiles: ["/committed"], error: "later file failed" },
        },
        {
          role: "toolResult",
          toolCallId: "fixture",
          content: [],
          timestamp: 0,
          toolName: "replace_text",
          isError: false,
          details: { modifiedFiles: ["/preview"], preview: true },
        },
        {
          role: "toolResult",
          toolCallId: "fixture",
          content: [],
          timestamp: 0,
          toolName: "write_files",
          isError: false,
          details: { modifiedFiles: [], files: [{ path: "/uncertain", status: "uncertain" }] },
        },
        {
          role: "toolResult",
          toolCallId: "fixture",
          content: [],
          timestamp: 0,
          toolName: "unrelated",
          isError: false,
          details: { modifiedFiles: ["/unrelated"] },
        },
      ],
    },
  });
  assert.deepEqual([...edited], ["/committed"]);
});

test("tools return bounded preview text, full expanded diffs, and truthful receipts", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-edit-tools-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [apply, , write] = createEditingTools();
  const fixture = await harness(
    t,
    ["read", "edit", "write", ...EDITING_TOOL_NAMES],
    false,
    directory,
  );
  const ctx = fixture.session.extensionRunner.createToolContext(
    "fixture",
    fixture.session.extensionRunner.createContext().signal,
  );
  const renderWrite = write.renderResult;
  const renderApply = apply.renderResult;
  assert(renderWrite);
  assert(renderApply);
  const body = `${"line\n".repeat(3_000)}FINAL-LINE\n`;
  const preview = await write.execute(
    "preview",
    { files: [{ path: "new", content: body, mode: "create" }], preview: true },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(preview.details?.preview, true);
  assert.notEqual(preview.details, undefined);
  assert.deepEqual(preview.details.modifiedFiles, []);
  assert.deepEqual(await readdir(directory), []);
  assert.match(
    preview.content[1]?.type === "text" ? preview.content[1].text : "",
    /Preview truncated/,
  );
  assert.match(preview.details.files[0]?.diff ?? "", /FINAL-LINE/);
  initTheme("dark", false);
  const theme = fixture.session.extensionRunner.getUIContext().theme;
  const expanded = renderWrite(
    preview,
    { expanded: true, isPartial: false },
    theme,
    renderContext(directory),
  ).render(80);
  assert(expanded.some((line) => line.includes("FINAL-LINE")));
  for (const line of expanded) {
    assert(visibleWidth(line) <= 80);
  }
  const collapsed = renderWrite(
    preview,
    { expanded: false, isPartial: false },
    theme,
    renderContext(directory),
  ).render(80);
  assert(!collapsed.some((line) => line.includes("FINAL-LINE")));

  await writeFile(join(directory, "file"), "before\n");
  const result = await apply.execute("apply", { input: patch("file") }, undefined, undefined, ctx);
  assert.equal(await readFile(join(directory, "file"), "utf8"), "after\n");
  assert.deepEqual(result.details?.modifiedFiles, [join(directory, "file")]);
  assert.equal(result.details.files.at(0)?.status, "applied");
  const failed = await apply.execute(
    "fail",
    { input: patch("file", "missing") },
    undefined,
    undefined,
    ctx,
  );
  assert(failed.details !== undefined);
  assert.notEqual(failed.details.error, undefined);
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.structuredContent, JSON.parse(JSON.stringify(failed.details)));
  assert.deepEqual(failed.details.modifiedFiles, []);
  const failureView = renderApply(
    failed,
    { expanded: false, isPartial: false },
    theme,
    renderContext(directory, true),
  )
    .render(100)
    .join("\n");
  assert.match(failureView, /✗/);
  assert.doesNotMatch(failureView, /✓/);

  const nativeRealpath = fs.realpath;
  let resolutions = 0;
  t.mock.method(fs, "realpath", async (...args: Readonly<Parameters<typeof fs.realpath>>) => {
    const [path, options] = args;
    if (path === join(directory, "file") && ++resolutions === 2) {
      throw new Error("");
    }
    return nativeRealpath(path, options);
  });
  syncBuiltinESMExports();
  try {
    // Discovery succeeds, but Pi's subsequent queue acquisition rejects with an
    // empty-message error. Error presence, not message truthiness, owns the flag.
    const queueFailure = await write.execute(
      "queue-fail",
      {
        files: [{ path: join(directory, "file"), content: "must not write", mode: "replace" }],
      },
      undefined,
      undefined,
      ctx,
    );
    assert(queueFailure.details !== undefined);
    assert.equal(queueFailure.details.error, "");
    assert.equal(queueFailure.isError, true);
    assert.deepEqual(queueFailure.details.modifiedFiles, []);
    assert.equal(await readFile(join(directory, "file"), "utf8"), "after\n");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
