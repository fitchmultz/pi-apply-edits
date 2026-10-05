import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import editingExtension from "../extensions/apply-edits.ts";
import type { Tool } from "@earendil-works/pi-ai";

// Journal recovery remains a supported contract; the dropped fork checkpoint API is not.
test("native reload and journal restore preserve history and explicit tool selection", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-apply-edits-restore-"));
  let session: AgentSession | undefined;
  t.after(async () => {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No network in restore test");
  });
  const agentDir = join(cwd, "agent");
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "empty-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let api: ExtensionAPI | undefined;
  const create = async (manager: SessionManager) => {
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        editingExtension,
        (pi) => {
          api = pi;
        },
      ],
    });
    await loader.reload({ resolveProjectTrust: async () => false });
    assert.deepEqual(loader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: manager,
      tools: ["read", "preview_patch"],
    });
    await created.session.bindExtensions({
      mode: "print",
      onError: (error) => assert.fail(error.error),
    });
    return created.session;
  };
  session = await create(SessionManager.create(cwd, join(cwd, "sessions")));
  assert(api);
  api.setActiveTools(["read", "preview_patch"]);
  // Persist the native loadout without a provider request.
  session.sessionManager.appendMessage({
    role: "system",
    content: "fixture",
    toolsAdded: session.agent.state.tools.map(
      ({ name, description, parameters, constrainedSampling }: Tool) => ({
        name,
        description,
        parameters,
        constrainedSampling,
      }),
    ),
    timestamp: 1,
  });
  session.sessionManager.appendMessage({
    role: "user",
    content: "synthetic history",
    timestamp: 2,
  });
  const file = session.sessionManager.getSessionFile();
  assert(file !== undefined && file.length > 0);
  const before = session.sessionManager.getEntries();
  await session.reload();
  assert.deepEqual(session.sessionManager.getEntries(), before);
  assert.deepEqual(api.getActiveTools(), ["read", "preview_patch"]);
  session.dispose();
  session = await create(SessionManager.open(file));
  assert.deepEqual(session.sessionManager.getEntries(), before);
  assert.deepEqual(api.getActiveTools(), ["read", "preview_patch"]);
});
