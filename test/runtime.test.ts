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
import applyEditsExtension from "../extensions/apply-edits.ts";
import type { WriteFilesParameters } from "../src/tools.ts";

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

const call = (id: string, args: ToolCall["arguments"], name = "write_files"): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const patch = (path: string, before: string, after: string) => `*** Begin Patch\n*** Update File: ${path}\n@@\n-${before}\n+${after}\n*** End Patch`;

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
test("native loader executes focused tools with policy, errors, previews, and ordered publication", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-edit-runtime-"));
  const cwd = join(root, "a");
  const other = join(root, "b");
  const agentDir = join(root, "agent");
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network allowed"); });
  for (const dir of [cwd, other]) {
    await mkdir(dir);
    await writeFile(join(dir, "same.txt"), "before\n");
  }
  for (const name of ["ordered-a", "ordered-b"]) await writeFile(join(cwd, name), "initial\n");
  const runtime = await offlineRuntime(root);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const manager = SessionManager.inMemory(cwd);
  const seen = new Map<string, unknown>();
  let virtualCwd = cwd;
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/apply-edits.ts", import.meta.url))],
    extensionFactories: [(pi) => {
      pi.events.on("pi-change-working-dir:resolve-execution-cwd", (data) => {
        const request = data as { sessionManager: unknown; result?: { cwd: string } };
        if (request.sessionManager === manager) request.result = { cwd: virtualCwd };
      });
      pi.on("tool_call", (event) => {
        seen.set(event.toolCallId, structuredClone(event.input));
        if (event.toolCallId === "apply-patch") virtualCwd = other;
        if (event.toolCallId === "denied") return { block: true, reason: "fixture policy denied" };
        return undefined;
      });
    }],
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
    model: runtime.getModel("offline-test", "scripted"), thinkingLevel: "off", sessionManager: manager, settingsManager: settings }));
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  const updates: string[] = [];
  session.subscribe((event) => { if (event.type === "tool_execution_update") updates.push(contentText(event.partialResult.content)); });
  const createBody = "\uFEFFcreated\r\nmixed\n";
  scriptCalls(session, [
    [call("preview-patch", { input: patch("same.txt", "before", "preview") }, "preview_patch")],
    [call("bad-anchor", { input: patch("same.txt", "missing", "bad") }, "apply_patch")],
    [call("denied", { files: [{ path: "denied", content: "bad", mode: "create" }] })],
    [call("apply-patch", { input: patch("same.txt", "before", "changed") }, "apply_patch")],
    [call("preview-write", { files: [{ path: "same.txt", content: "preview\n", mode: "replace" }], preview: true })],
    [call("create", { files: [{ path: "created", content: createBody, mode: "create", preserveFormatting: null }], preview: null })],
    [call("replace", { files: [{ path: "same.txt", edits: [{ oldText: "before", newText: "B", all: null, endText: null, insert: null }] }] }, "replace_text")],
    [call("batch", { input: `*** Begin Patch\n*** Update File: ${join(cwd, "same.txt")}\n@@\n-changed\n+done\n*** Add File: batch\n+batch\n*** End Patch` }, "apply_patch")],
    [call("ordered-batch", { files: ["ordered-a", "ordered-b"].map((name) => ({ path: join(cwd, name), content: "first\n", mode: "replace" })) }),
     call("ordered-single", { files: [{ path: join(cwd, "ordered-b"), content: "second\n", mode: "replace" }] })],
    [call("invalid-alias", { path: "oops", content: "bad" })],
    [call("unknown-field", { files: [{ path: "oops", content: "bad", mode: "create", typo: true }] })],
    [call("invalid-preview", { files: [{ path: "same.txt", content: "bad", mode: "replace" }], preview: "true" })],
  ]);
  await session.prompt("Run the local scripted tool flow.");
  await session.waitForIdle();
  assert.deepEqual(errors, []);
  const results = new Map(session.messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
  for (const id of ["bad-anchor", "denied", "invalid-alias", "unknown-field", "invalid-preview"]) assert.equal(results.get(id)?.isError, true, id);
  for (const id of ["preview-patch", "apply-patch", "preview-write", "create", "replace", "batch", "ordered-batch", "ordered-single"]) assert.equal(results.get(id)?.isError, false, `${id}: ${contentText(results.get(id)?.content ?? [])}`);
  assert.partialDeepStrictEqual(results.get("bad-anchor")?.details, { modifiedFiles: [], files: [{ status: "failed" }] });
  assert.partialDeepStrictEqual(results.get("preview-patch")?.details, { preview: true, modifiedFiles: [] });
  assert.deepEqual(seen.get("apply-patch"), { input: patch(join(cwd, "same.txt"), "before", "changed") });
  assert.partialDeepStrictEqual(seen.get("create"), { files: [{ path: join(other, "created"), content: createBody }] });
  for (const id of ["invalid-alias", "unknown-field", "invalid-preview"]) assert.equal(seen.has(id), false, id);
  assert.equal(await readFile(join(cwd, "same.txt"), "utf8"), "done\n");
  assert.equal(await readFile(join(other, "same.txt"), "utf8"), "B\n");
  assert.equal(await readFile(join(other, "created"), "utf8"), createBody);
  assert.equal(await readFile(join(other, "batch"), "utf8"), "batch\n");
  assert.equal(await readFile(join(cwd, "ordered-a"), "utf8"), "first\n");
  assert.equal(await readFile(join(cwd, "ordered-b"), "utf8"), "second\n");
  await assert.rejects(readFile(join(cwd, "denied")), /ENOENT/);
  assert(updates.some((text) => text.includes("Completed 2/2")));
  assert.equal(session.getToolDefinition("apply_edits"), undefined);
  assert.equal(network.mock.callCount(), 0);
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
    const seen = new Map<string, WriteFilesParameters>();
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
            if (!isToolCallEventType<"write_files", WriteFilesParameters>("write_files", event)) return;
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
    const tool = session.getToolDefinition("write_files");
    assert(tool?.prepareArguments);
    const args = { files: [{ path: "same.txt", content: "after\n", mode: "replace" }] };
    assert.throws(() => tool.prepareArguments!(args), /not initialized/);
    for (const invalid of [null, [], 42]) assert.throws(() => tool.prepareArguments!(invalid), /files must be an array/);
    if (bind) {
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      assert.partialDeepStrictEqual(tool.prepareArguments(args), { files: [{ path: join(a, "same.txt") }] });
      ownerQueries.length = 0;
    }
    scriptCalls(session, [
      [call("admitted", args)],
      [call("preview-batch", { preview: true, files: [
        { path: "same.txt", content: "preview\n", mode: "replace" },
        { path: "~", content: "literal tilde\n", mode: "create" },
      ] })],
      [call("apply-batch", { files: [
        { path: "same.txt", content: "B after\n", mode: "replace" },
        { path: "@literal\u00a0file.txt", content: "literal path\n", mode: "create" },
      ] })],
    ]);
    const running = session.prompt("Run the offline admission flow.");
    await entered.promise;
    assert.equal(seen.get("admitted")?.files[0]?.path, join(a, "same.txt"));
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
    assert.equal(args.files[0]?.path, "same.txt");
    assert.equal(process.cwd(), processCwd);

    ownerReply = { cwd: b, error: "Selected directory is unavailable" };
    assert.throws(() => tool.prepareArguments!(args), /Selected directory is unavailable/);
    for (const invalid of [null, [], {}, { cwd: "" }, { cwd: "relative" }, { cwd: 42 }, { cwd: `${b}\0` }, { cwd: b, error: false }]) {
      ownerReply = invalid;
      assert.throws(() => tool.prepareArguments!(args), /invalid execution directory/);
    }
    ownerReply = undefined;
    assert.partialDeepStrictEqual(tool.prepareArguments(args), { files: [{ path: join(cwd, "same.txt") }] });
    ownerReply = { cwd: b };
    if (!bind) await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    await session.reload();
    assert.throws(() => tool.prepareArguments!(args), /stale/);
    const reloaded = session.getToolDefinition("write_files");
    assert(reloaded?.prepareArguments);
    assert.partialDeepStrictEqual(reloaded.prepareArguments(args), { files: [{ path: join(b, "same.txt") }] });
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
    const prepare = session.getToolDefinition("write_files")?.prepareArguments;
    assert(prepare);
    const args = { files: [{ path: "fixture.txt", content: "content", mode: "create" }] };
    if (scenario === "disabled" || scenario === "unrelated") {
      assert.partialDeepStrictEqual(prepare(args), { files: [{ path: join(root, "fixture.txt") }] });
      assert.equal(api.getCommands().some((command) => command.name === "cwd"), scenario === "unrelated");
    } else {
      assert.throws(() => prepare(args), /Update pi-change-working-dir and restart Pi/);
      assert(api.getCommands().some((command) => /^cwd(?::\d+)?$/.test(command.name)));
      if (scenario.startsWith("excluded")) assert.equal(api.getAllTools().some((tool) => tool.name === "change_dir"), false);
    }
    assert.equal(network.mock.callCount(), 0);
  });
}
