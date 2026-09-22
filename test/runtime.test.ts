import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contentText, createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  isToolCallEventType,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import applyEditsExtension, { type ApplyEditsParameters } from "../extensions/apply-edits.ts";

async function offlineRuntime(root: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  runtime.registerProvider("offline-test", {
    api: "openai-completions", apiKey: "unused-offline-key", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"],
      contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  return runtime;
}

const call = (id: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name: "apply_edits", arguments: args });

function scriptCalls(session: AgentSession, steps: ToolCall[][]): void {
  const model = session.model;
  assert(model);
  let turn = 0;
  session.agent.streamFunction = () => {
    const calls = steps[turn++];
    const message: AssistantMessage = {
      role: "assistant", content: calls ?? [{ type: "text", text: "done" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: calls ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message });
    return stream;
  };
}

// Only the provider response is scripted: loading, validation, policy, execution, and settlement are real Pi.
test("native loader keeps retry targets and policy intact across previews and cwd changes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-apply-edits-runtime-"));
  const cwd = join(root, "a");
  const other = join(root, "b");
  const agentDir = join(root, "agent");
  let session: AgentSession | undefined;
  let networkAttempts = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("No network allowed in runtime smoke"); };
  try {
    await mkdir(cwd);
    await mkdir(other);
    await writeFile(join(cwd, "same.txt"), "shared\nA\n");
    await writeFile(join(other, "same.txt"), "shared\nB\n");
    await writeFile(join(cwd, "ordered-a.txt"), "initial\n");
    await writeFile(join(cwd, "ordered-b.txt"), "initial\n");
    const runtime = await offlineRuntime(root);
    const model = runtime.getModel("offline-test", "scripted");
    assert(model);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const seen = new Map<string, ApplyEditsParameters>();
    let virtualCwd = cwd;
    const sessionManager = SessionManager.inMemory(cwd);
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../extensions/apply-edits.ts", import.meta.url))],
      extensionFactories: [(pi) => {
        pi.events.on("pi-change-working-dir:resolve-execution-cwd", (data) => {
          const request = data as { sessionManager: unknown; result?: { cwd: string } };
          if (request.sessionManager === sessionManager) request.result = { cwd: virtualCwd };
        });
        pi.on("tool_call", (event) => {
          if (!isToolCallEventType<"apply_edits", ApplyEditsParameters>("apply_edits", event)) return;
          if (event.toolCallId === "preview-create") virtualCwd = other;
          seen.set(event.toolCallId, structuredClone(event.input));
          if (event.toolCallId === "denied-create") return { block: true, reason: "fixture policy denied" };
          return undefined;
        });
      }],
    });
    await loader.reload({ resolveProjectTrust: async () => false });
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, modelRuntime: runtime, model, thinkingLevel: "off",
      sessionManager, settingsManager: settings,
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    const results = new Map<string, { isError: boolean; text: string; details: unknown }>();
    const updates: string[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_end") results.set(event.toolCallId, {
        isError: event.isError,
        text: contentText(event.result.content, "\n"),
        details: event.result.details,
      });
      if (event.type === "tool_execution_update") updates.push(contentText(event.partialResult.content, "\n"));
    });
    const createBody = "\uFEFFcreated\r\nmixed\n";
    const steps = [
      [call("failed-create", { file_path: "created.txt", content: createBody, preserve_formatting: false })],
      [call("failed-edit", { path: "same.txt", edits: [{ oldText: "typo", newText: "CHANGED" }] })],
      [call("preview-create", { retry: { from: "failed-create" }, preview: true })],
      [call("denied-create", { retry: { from: "failed-create" } })],
      [call("preview-edit", { retry: { from: "failed-edit", oldText: "shared" }, preview: true })],
      [call("apply-create", { retry: { from: "failed-create" } })],
      [call("apply-edit", { retry: { from: "failed-edit", oldText: "shared" } }), call("duplicate-edit", { retry: { from: "failed-edit", oldText: "shared" } })],
      [call("invalid-preview", { path: "same.txt", rewrite: "wrong", preview: "true" })],
      [call("missing-path", { files: [{ rewrite: "wrong", onMissing: "create" }] })],
      [call("policy-preview", { path: "same.txt", edits: [{ oldText: "shared", newText: "PREVIEW" }], preview: true })],
      [call("batch", { files: [
        { path: join(cwd, "same.txt"), edits: [{ oldText: "CHANGED", newText: "DONE" }] },
        { path: "batch.txt", rewrite: "batch\n", onMissing: "create" },
      ] })],
      [
        call("ordered-batch", { files: [
          { path: join(cwd, "ordered-a.txt"), rewrite: "first\n" },
          { path: join(cwd, "ordered-b.txt"), rewrite: "first\n" },
        ] }),
        call("ordered-single", { path: join(cwd, "ordered-b.txt"), rewrite: "second\n" }),
      ],
      [call("unused", { path: "unused.txt", rewrite: "pending" })],
    ];
    scriptCalls(session, steps);
    await session.prompt("Run the local scripted tool flow.");
    await session.waitForIdle();
    assert.deepEqual(errors, []);
    for (const id of ["preview-create", "denied-create", "apply-create"]) {
      assert.equal(seen.get(id)?.path, join(cwd, "created.txt"));
      assert.equal(seen.get(id)?.rewrite, createBody);
      assert.equal(seen.get(id)?.preserveFormatting, false);
      assert.equal(seen.get(id)?.requireMissing, true);
    }
    for (const id of ["preview-edit", "apply-edit"]) {
      assert.equal(seen.get(id)?.path, join(cwd, "same.txt"));
      assert.equal(seen.get(id)?.edits?.[0]?.oldText, "shared");
      assert.equal(seen.get(id)?.edits?.[0]?.newText, "CHANGED");
    }
    for (const id of ["failed-create", "failed-edit", "denied-create", "duplicate-edit", "invalid-preview", "missing-path", "unused"]) {
      assert.equal(results.get(id)?.isError, true, `${id}: ${results.get(id)?.text}`);
    }
    for (const id of ["preview-create", "preview-edit", "apply-create", "apply-edit", "policy-preview", "batch", "ordered-batch", "ordered-single"]) {
      assert.equal(results.get(id)?.isError, false, `${id}: ${results.get(id)?.text}`);
    }
    for (const id of ["preview-create", "preview-edit", "policy-preview"]) {
      const details = results.get(id)?.details;
      assert(details && typeof details === "object" && "preview" in details && details.preview === true);
    }
    assert.equal(results.get("denied-create")?.text, "fixture policy denied");
    assert.match(results.get("preview-edit")?.text ?? "", /Would edit.*No files written/);
    assert.equal(seen.has("invalid-preview"), false);
    assert.equal(seen.has("missing-path"), false);
    assert.equal(seen.get("policy-preview")?.path, join(other, "same.txt"));
    assert(updates.some((text) => text.includes("Completed 2/2")));
    assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), createBody);
    await assert.rejects(readFile(join(other, "created.txt")), /ENOENT/);
    assert.equal(await readFile(join(cwd, "same.txt"), "utf8"), "DONE\nA\n");
    assert.equal(await readFile(join(other, "same.txt"), "utf8"), "shared\nB\n");
    assert.equal(await readFile(join(other, "batch.txt"), "utf8"), "batch\n");
    assert.equal(await readFile(join(cwd, "ordered-a.txt"), "utf8"), "first\n");
    assert.equal(await readFile(join(cwd, "ordered-b.txt"), "utf8"), "second\n");
    const tool = session.getToolDefinition("apply_edits");
    assert(tool?.prepareArguments);
    assert.throws(() => tool.prepareArguments!({ retry: { from: "unused" } }), /unavailable/);
    assert.equal(networkAttempts, 0);
  } finally {
    session?.dispose();
    globalThis.fetch = fetch;
    await rm(root, { recursive: true, force: true });
  }
});

for (const bind of [true, false]) {
  test(`execution directory is bound before policy in ${bind ? "normal sessions" : "bare SDK prompts"}`, { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-apply-edits-admission-"));
    const cwd = join(root, "anchor");
    const a = join(root, "a");
    const b = join(root, "b");
    const agentDir = join(root, "agent");
    let session: AgentSession | undefined;
    t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
    const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network allowed"); });
    const processCwd = process.cwd();
    for (const dir of [cwd, a, b]) {
      await mkdir(dir);
      await writeFile(join(dir, "same.txt"), "before\n");
    }
    const runtime = await offlineRuntime(root);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const manager = SessionManager.inMemory(cwd);
    let ownerReply: unknown = { cwd: a };
    const ownerQueries: unknown[] = [];
    const seen = new Map<string, ApplyEditsParameters>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    let starts = 0;
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        (pi) => {
          // Load policy before the editor: admission cannot depend on hook ordering.
          pi.on("session_start", () => { starts++; });
          pi.on("tool_call", async (event) => {
            if (!isToolCallEventType<"apply_edits", ApplyEditsParameters>("apply_edits", event)) return;
            seen.set(event.toolCallId, structuredClone(event.input));
            if (event.toolCallId === "admitted") {
              entered.resolve();
              await release.promise;
            }
          });
          pi.events.on("pi-change-working-dir:resolve-execution-cwd", (data) => {
            const request = data as { sessionManager: unknown; result?: unknown };
            ownerQueries.push(request.sessionManager);
            if (request.sessionManager === manager) request.result = ownerReply;
          });
        },
        applyEditsExtension,
      ],
    });
    await loader.reload({ resolveProjectTrust: async () => false });
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel("offline-test", "scripted"), thinkingLevel: "off",
      sessionManager: manager, settingsManager: settings,
    }));
    const tool = session.getToolDefinition("apply_edits");
    assert(tool?.prepareArguments);
    const args = { path: "same.txt", rewrite: "after\n" };
    assert.throws(() => tool.prepareArguments!(args), /not initialized/);
    for (const invalid of [null, [], 42]) assert.deepEqual(tool.prepareArguments!(invalid), invalid);
    if (bind) {
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      assert.partialDeepStrictEqual(tool.prepareArguments(args), { path: join(a, "same.txt") });
      ownerQueries.length = 0;
    }
    scriptCalls(session, [
      [call("admitted", args)],
      [call("preview-batch", { preview: true, files: [
        { path: "same.txt", rewrite: "preview\n" },
        { path: "~", rewrite: "literal tilde\n", onMissing: "create" },
      ] })],
      [call("apply-batch", { files: [
        { path: "same.txt", rewrite: "B after\n" },
        { path: "@literal\u00a0file.txt", rewrite: "literal path\n", onMissing: "create" },
      ] })],
    ]);
    const running = session.prompt("Run the offline admission flow.");
    await entered.promise;
    assert.equal(seen.get("admitted")?.path, join(a, "same.txt"));
    assert.equal(await readFile(join(a, "same.txt"), "utf8"), "before\n");
    ownerReply = { cwd: b };
    release.resolve();
    await running;
    await session.waitForIdle();
    assert.equal(starts, bind ? 1 : 0);
    assert.deepEqual(ownerQueries, [manager, manager, manager]);
    assert.equal(seen.get("preview-batch")?.files?.[0]?.path, join(b, "same.txt"));
    assert.equal(seen.get("preview-batch")?.files?.[1]?.path, join(b, "~"));
    assert.equal(seen.get("apply-batch")?.files?.[1]?.path, join(b, "@literal\u00a0file.txt"));
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 3);
    for (const result of results) assert.equal(result.isError, false, contentText(result.content));
    assert.equal(await readFile(join(cwd, "same.txt"), "utf8"), "before\n");
    assert.equal(await readFile(join(a, "same.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(b, "same.txt"), "utf8"), "B after\n");
    assert.equal(await readFile(join(b, "@literal\u00a0file.txt"), "utf8"), "literal path\n");
    await assert.rejects(readFile(join(b, "~")), /ENOENT/);
    // Native preparation operates on a clone, not the model's transcript arguments.
    assert.equal(args.path, "same.txt");
    assert.equal(process.cwd(), processCwd);

    ownerReply = { cwd: b, error: "Selected directory is unavailable" };
    assert.throws(() => tool.prepareArguments!(args), /Selected directory is unavailable/);
    for (const invalid of [null, [], {}, { cwd: "" }, { cwd: "relative" }, { cwd: 42 }, { cwd: `${b}\0` }, { cwd: b, error: false }]) {
      ownerReply = invalid;
      assert.throws(() => tool.prepareArguments!(args), /invalid execution directory/);
    }
    ownerReply = undefined;
    assert.partialDeepStrictEqual(tool.prepareArguments(args), { path: join(cwd, "same.txt") });
    ownerReply = { cwd: b };
    if (!bind) await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    await session.reload();
    assert.throws(() => tool.prepareArguments!(args), /stale/);
    const reloaded = session.getToolDefinition("apply_edits");
    assert(reloaded?.prepareArguments);
    assert.partialDeepStrictEqual(reloaded.prepareArguments(args), { path: join(b, "same.txt") });
    session.dispose();
    assert.throws(() => reloaded.prepareArguments!(args), /stale/);
    session = undefined;
    assert.deepEqual(errors, []);
    assert.equal(network.mock.callCount(), 0);
  });
}

// Exercise real SourceInfo from both package and direct-file loading, including tool exclusion.
for (const scenario of ["legacy", "excluded", "excluded-collision", "direct", "disabled", "unrelated"] as const) {
  test(`directory-owner provenance: ${scenario}`, { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-apply-edits-owner-"));
    let session: AgentSession | undefined;
    t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
    const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network allowed"); });
    const agentDir = join(root, "agent");
    // The unrelated fixture deliberately has the same directory basename and tool/command names.
    const packageDir = join(root, "pi-change-working-dir");
    await mkdir(packageDir);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-change-working-dir" }));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: scenario === "unrelated" ? "unrelated-fixture" : "pi-change-working-dir", type: "module",
      pi: { extensions: ["./index.ts"] },
    }));
    await writeFile(join(packageDir, "index.ts"), `export default pi => {
      pi.registerTool({ name: "change_dir", label: "fixture", description: "fixture",
        parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });
      pi.registerCommand("cwd", { description: "fixture", handler: async () => {} });
    };`);
    const settings = SettingsManager.inMemory({
      packages: scenario === "direct" ? [] : scenario === "disabled"
        ? [{ source: packageDir, extensions: [] }] : [packageDir],
    });
    let api: ExtensionAPI | undefined;
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager: settings,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: scenario === "direct" ? [join(packageDir, "index.ts")] : [],
      extensionFactories: [(pi) => {
        api = pi;
        if (scenario === "excluded-collision") pi.registerCommand("cwd", { handler: async () => {} });
      }, applyEditsExtension],
    });
    await loader.reload({ resolveProjectTrust: async () => false });
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: root, agentDir, resourceLoader: loader, modelRuntime: await offlineRuntime(root),
      settingsManager: settings, sessionManager: SessionManager.inMemory(root),
      excludeTools: scenario.startsWith("excluded") ? ["change_dir"] : undefined,
    }));
    await session.bindExtensions({ mode: "print", onError: (error) => assert.fail(error.error) });
    assert(api);
    const prepare = session.getToolDefinition("apply_edits")?.prepareArguments;
    assert(prepare);
    const args = { path: "fixture.txt", rewrite: "content" };
    if (scenario === "disabled" || scenario === "unrelated") {
      assert.partialDeepStrictEqual(prepare(args), { path: join(root, "fixture.txt") });
      assert.equal(api.getCommands().some((command) => command.name === "cwd"), scenario === "unrelated");
    } else {
      assert.throws(() => prepare(args), /Update pi-change-working-dir and restart Pi/);
      assert(api.getCommands().some((command) => /^cwd(?::\d+)?$/.test(command.name)));
      if (scenario.startsWith("excluded")) assert.equal(api.getAllTools().some((tool) => tool.name === "change_dir"), false);
    }
    assert.equal(network.mock.callCount(), 0);
  });
}
