import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type SourceInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import editingExtension from "../extensions/apply-edits.ts";
import { EDITING_TOOL_NAMES } from "../src/tools.ts";

export interface ExtensionHarness {
  readonly state: { active: string[] };
  readonly tools: Map<string, ToolDefinition<TSchema, unknown, unknown>>;
  readonly sources: Map<string, SourceInfo>;
  readonly session: AgentSession;
}

/** A real SDK session with the editing extension; only tool selection and provenance are mocked. */
export async function harness(
  t: TestContext,
  active: readonly string[] = ["read", "edit", "write", ...EDITING_TOOL_NAMES],
  flag = false,
  cwd?: string,
): Promise<ExtensionHarness> {
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
