import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
} from "@earendil-works/pi-coding-agent";
import type { ApplyEditsParameters } from "../extensions/apply-edits.ts";

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
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"),
      refreshOnCreate: false, allowModelNetwork: false,
    });
    runtime.registerProvider("offline-test", {
      api: "openai-completions", apiKey: "unused-offline-key", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"],
        contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const model = runtime.getModel("offline-test", "scripted");
    assert(model);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const seen = new Map<string, ApplyEditsParameters>();
    let virtualCwd = cwd;
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../extensions/apply-edits.ts", import.meta.url))],
      extensionFactories: [(pi) => {
        pi.on("tool_call", (event) => {
          if (!isToolCallEventType<"apply_edits", ApplyEditsParameters>("apply_edits", event)) return;
          if (event.toolCallId === "preview-create") virtualCwd = other;
          // Working-directory extensions rewrite inputs, not the immutable session cwd.
          if (virtualCwd !== cwd) {
            for (const input of event.input.files ?? [event.input]) {
              if (input.path) input.path = resolve(virtualCwd, input.path);
            }
          }
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
      sessionManager: SessionManager.inMemory(cwd), settingsManager: settings,
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
    const call = (id: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name: "apply_edits", arguments: args });
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
      [call("unused", { path: "unused.txt", rewrite: "pending" })],
    ];
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
    for (const id of ["preview-create", "preview-edit", "apply-create", "apply-edit", "policy-preview", "batch"]) {
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
