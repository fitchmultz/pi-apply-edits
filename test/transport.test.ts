import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
  contentText, createProvider, InMemoryCredentialStore, InMemoryModelsStore,
  type FetchFunction, type Model, type StreamOptions,
} from "@earendil-works/pi-ai";
import * as responses from "@earendil-works/pi-ai/api/openai-responses";
import * as codex from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PATCH_GRAMMAR } from "../src/patch.ts";

type Api = "openai-responses" | "openai-codex-responses";
type Reply = { native: boolean; input: string } | { text: string };
type RequestBody = { tools?: Record<string, unknown>[]; input: Record<string, unknown>[] };
const patch = (before: string, after: string, path = "fixture.txt") =>
  `*** Begin Patch\n*** Update File: ${path}\n@@\n-${before}\n+${after}\n*** End Patch`;
// Codex requires an account claim even though no request leaves the test.
const apiKey = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
})).toString("base64url")}.fixture`;

function sse(reply: Reply, sequence: number): Response {
  const id = `resp_${sequence}`;
  let item: Record<string, unknown>;
  let events: Record<string, unknown>[];
  if ("input" in reply) {
    const field = reply.native ? "input" : "arguments";
    const eventName = reply.native ? "custom_tool_call_input" : "function_call_arguments";
    const raw = reply.native ? reply.input : JSON.stringify({ input: reply.input });
    item = { type: reply.native ? "custom_tool_call" : "function_call", name: "apply_patch",
      id: `${reply.native ? "ctc" : "fc"}_${sequence}`, call_id: `call_${sequence}`, status: "completed", [field]: raw };
    const cut = Math.floor(raw.length / 2);
    events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", [field]: "" } },
      ...[raw.slice(0, cut), raw.slice(cut)].map((delta) => ({
        type: `response.${eventName}.delta`, output_index: 0, item_id: item.id, delta,
      })),
      { type: `response.${eventName}.done`, output_index: 0, item_id: item.id, [field]: raw },
      { type: "response.output_item.done", output_index: 0, item },
    ];
  } else {
    item = { type: "message", id: `msg_${sequence}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: reply.text, annotations: [] }] };
    events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: reply.text },
      { type: "response.output_item.done", output_index: 0, item },
    ];
  }
  events.unshift({ type: "response.created", response: { id, status: "in_progress" } });
  events.push({ type: "response.completed", response: { id, status: "completed", output: [item],
    usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 } } });
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    pull(controller) {
      const event = events.shift();
      if (event) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      else controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function fixture(t: TestContext, api: Api) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-edit-transport-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  await writeFile(join(cwd, "fixture.txt"), "before\n");
  const agentDir = join(cwd, "agent");
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 }, retry: { enabled: false }, cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/apply-edits.ts", import.meta.url))],
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const model: Model<Api> = {
    id: "grammar", name: "Fixture", api, provider: "transport-fixture", baseUrl: "https://fixture.invalid/v1",
    reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsOpenAIGrammarTools: true },
  };
  const replies: Reply[] = [];
  const requests: RequestBody[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).hostname, "fixture.invalid");
    const bytes = Buffer.from(await request.arrayBuffer());
    const body = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    requests.push(JSON.parse(body.toString("utf8")));
    const reply = replies.shift();
    assert(reply, "Unexpected provider request");
    return sse(reply, requests.length);
  };
  const transport: StreamOptions = { apiKey, fetch, transport: "sse", cacheRetention: "none", maxRetries: 0 };
  // Only HTTP is replaced: both provider adapters parse and serialize their real wire formats.
  runtime.registerNativeProvider(createProvider({
    id: model.provider, name: "Transport fixture", models: [model],
    auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "fixture" }),
      resolve: async () => ({ auth: { apiKey }, source: "fixture" }) } },
    api: api === "openai-responses" ? {
      stream: (m, c, o) => responses.stream({ ...m, api }, c, { ...o, ...transport }),
      streamSimple: (m, c, o) => responses.streamSimple({ ...m, api }, c, { ...o, ...transport }),
    } : {
      stream: (m, c, o) => codex.stream({ ...m, api }, c, { ...o, ...transport }),
      streamSimple: (m, c, o) => codex.streamSimple({ ...m, api }, c, { ...o, ...transport }),
    },
  }));
  const { session } = await createAgentSession({
    cwd, agentDir, model, modelRuntime: runtime, resourceLoader: loader, noTools: "builtin",
    sessionManager: SessionManager.inMemory(cwd), settingsManager: settings, thinkingLevel: "off",
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print", onError: (error) => assert.fail(error.error) });
  const deltas: string[] = [];
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });
  t.after(() => {
    assert.equal(replies.length, 0, "All synthetic responses consumed");
    assert.deepEqual(session.messages.filter((m) => m.role === "assistant" && m.stopReason === "error"), []);
  });
  return { cwd, model, session, requests, replies, deltas };
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api}: streamed edits and replay survive grammar → JSON → grammar model switches`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t, api);
    const inputs: string[] = [];
    let before = "before";
    for (const [index, native] of [true, false, true].entries()) {
      if (index > 0) await f.session.setModel({ ...f.model, id: `model-${index}`, compat: { supportsOpenAIGrammarTools: native } });
      const after = `after-${index}`;
      const input = patch(before, after);
      inputs.push(input);
      const deltaStart = f.deltas.length;
      f.replies.push({ native, input }, { text: "Edit complete." });
      await f.session.prompt("Apply the fixture patch.");
      await f.session.waitForIdle();
      assert.equal(await readFile(join(f.cwd, "fixture.txt"), "utf8"), `${after}\n`);
      const results = f.session.messages.filter((m) => m.role === "toolResult");
      assert.equal(results.length, index + 1);
      const result = results.at(-1)!;
      assert.equal(result.isError, false, contentText(result.content));
      assert.partialDeepStrictEqual(result.details, { modifiedFiles: [join(f.cwd, "fixture.txt")], files: [{ status: "applied" }] });
      const streamed = f.deltas.slice(deltaStart);
      assert(streamed.length >= 2, "The adapter emits incremental tool arguments");
      // Native grammar deltas are normalized to the same argument JSON as function calls.
      assert.equal(streamed.join(""), JSON.stringify({ input }));
      assert.equal(f.requests.length, (index + 1) * 2);
      for (const request of f.requests.slice(-2)) {
        assert.deepEqual(request.tools?.map((tool) => tool.name).sort(), ["apply_patch", "preview_patch", "replace_text", "write_files"]);
        for (const name of ["apply_patch", "preview_patch"]) {
          const definition: Record<string, unknown> | undefined = request.tools?.find((tool) => tool.name === name);
          assert(definition);
          assert.equal(definition.type, native ? "custom" : "function");
          if (native) assert.deepEqual(definition.format, { type: "grammar", syntax: "lark", definition: PATCH_GRAMMAR });
          else assert.partialDeepStrictEqual(definition.parameters, { type: "object", required: ["input"], properties: { input: { type: "string" } } });
        }
      }
      const replay = f.requests.at(-1)!.input;
      const calls = replay.filter((item) => item.type === "custom_tool_call" || item.type === "function_call");
      const outputs = replay.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
      assert.equal(calls.length, inputs.length);
      assert.equal(outputs.length, inputs.length);
      for (const [i, original] of inputs.entries()) {
        assert.equal(calls[i]!.type, native ? "custom_tool_call" : "function_call");
        assert.equal(calls[i]![native ? "input" : "arguments"], native ? original : JSON.stringify({ input: original }));
        assert.equal(outputs[i]!.type, native ? "custom_tool_call_output" : "function_call_output");
        assert.equal(outputs[i]!.call_id, calls[i]!.call_id);
        assert.equal(outputs[i]!.output, contentText(results[i]!.content));
      }
      before = after;
    }
  });
}

test("native compaction retains committed paths from successful and partial-error receipts", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, "openai-responses");
  f.replies.push({ native: true, input: patch("before", "after") }, { text: "Edit complete." });
  await f.session.prompt("Apply the fixture patch.");
  await f.session.waitForIdle();
  const assistant = f.session.messages.find((m) => m.role === "assistant" && m.stopReason === "toolUse");
  assert(assistant?.role === "assistant");
  const partialPath = join(f.cwd, "partial.txt");
  // Construct a recorded partial commit without provoking a filesystem failure or race.
  await writeFile(partialPath, "committed\n");
  f.session.sessionManager.appendMessage({ ...assistant, content: [{
    type: "toolCall", id: "partial", name: "apply_patch", arguments: { input: patch("before", "committed", "partial.txt") },
  }] });
  f.session.sessionManager.appendMessage({
    role: "toolResult", toolName: "apply_patch", toolCallId: "partial", isError: true, timestamp: Date.now(),
    content: [{ type: "text", text: "One file committed; a later fixture operation failed." }],
    details: { modifiedFiles: [partialPath], error: "Later fixture operation failed" },
  });
  f.session.sessionManager.appendMessage({ role: "user", content: "Retain this recent turn.", timestamp: Date.now() });
  f.session.refreshContext();
  f.replies.push({ text: "Fixture work summarized." });
  const compacted = await f.session.compact();
  const paths = [join(f.cwd, "fixture.txt"), partialPath].sort();
  assert.deepEqual(compacted.details, { readFiles: [], modifiedFiles: paths });
  assert(compacted.summary.includes(`<modified-files>\n${paths.join("\n")}\n</modified-files>`));
  const entry = f.session.sessionManager.getEntries().findLast((entry) => entry.type === "compaction");
  assert(entry?.type === "compaction");
  assert.equal(entry.summary, compacted.summary);
  assert.deepEqual(entry.details, compacted.details);
  f.replies.push({ text: "Summary received." });
  await f.session.prompt("Continue from the compacted context.");
  await f.session.waitForIdle();
  assert.equal(f.requests.length, 4);
  for (const path of paths) assert(JSON.stringify(f.requests.at(-1)!.input).includes(path));
});
