import assert from "node:assert/strict";
import nodeFs from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test as nodeTest, type TestContext } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import editingExtension from "../extensions/apply-edits.ts";
import { applyPatchToFiles, replaceTextInFiles, writeFiles } from "../src/apply-edits.ts";
import { supportsExistingFileReplacement } from "../src/file-system.ts";
import { EDITING_TOOL_NAMES } from "../src/tools.ts";

// This process models a filesystem without hard links, such as FAT or exFAT. Filesystems are
// probed once per process, so every probe here observes the refusal.
mock.method(nodeFs.promises, "link", async () => {
  throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
});
syncBuiltinESMExports();

const skip =
  process.platform !== "darwin" && process.platform !== "linux"
    ? "only hard-link publication probes its filesystem"
    : !(await supportsExistingFileReplacement()) && "existing-file replacement is unavailable";

async function fixture(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pi-edit-no-links-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, "code.py"), "print('hello')\n");
  return path;
}

const refusal = (path: string) =>
  new RegExp(
    `^files\\[0\\]: Cannot publish .*${path}: the filesystem at .* does not support hard links, which verified publication requires\\. No changes were written\\.`,
  );

nodeTest(
  "a filesystem without hard links refuses edits and moves before staging and keeps creates",
  { skip },
  async (t) => {
    const cwd = await fixture(t);
    const edit = await replaceTextInFiles(
      { files: [{ path: "code.py", edits: [{ oldText: "hello", newText: "world" }] }] },
      cwd,
    );
    assert.match(edit.details.error ?? "", refusal("code\\.py"));
    const move = await applyPatchToFiles(
      "*** Begin Patch\n*** Update File: code.py\n*** Move to: moved.py\n*** End Patch",
      cwd,
    );
    assert.match(move.details.error ?? "", refusal("moved\\.py"));
    const created = await writeFiles(
      {
        files: [
          { path: "one.py", content: "one\n", mode: "create" },
          { path: "lib/two.py", content: "two\n", mode: "create" },
        ],
      },
      cwd,
    );
    assert.equal(created.details.error, undefined, created.summary);
    assert.deepEqual((await readdir(cwd)).sort(), ["code.py", "lib", "one.py"]);
    assert.equal(await readFile(join(cwd, "code.py"), "utf8"), "print('hello')\n");
  },
);

for (const writer of ["builtin", "custom", "shared-schema", "shutdown"] as const) {
  nodeTest(
    `refused publication restores only suppressed registrations: ${writer}`,
    { skip },
    async (t) => {
      const cwd = await fixture(t);
      const settings = SettingsManager.inMemory({});
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      let api: ExtensionAPI | undefined;
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: join(cwd, "agent"),
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
      const { session } = await createAgentSession({
        cwd,
        agentDir: join(cwd, "agent"),
        resourceLoader: loader,
        modelRuntime: runtime,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(cwd),
      });
      t.after(async () => {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      });
      assert(api);
      const original = session.getToolDefinition("write");
      assert(original);
      assert.equal(
        api.getAllTools().find((tool) => tool.name === "write")?.sourceInfo.source,
        "builtin",
      );
      const initiallyActive = api.getActiveTools();
      await session.bindExtensions({ mode: "print" });
      assert.deepEqual(
        api.getActiveTools(),
        initiallyActive.filter((name) => name !== "edit" && name !== "write"),
      );
      if (writer === "custom" || writer === "shared-schema") {
        api.registerTool({
          name: "write",
          label: "Unrelated writer",
          description: "Must not be activated by publication fallback",
          defaultActive: false,
          parameters:
            writer === "shared-schema" ? original.parameters : { type: "object", properties: {} },
          execute: () => assert.fail("The unrelated writer must not execute"),
        });
      }
      api.registerTool({
        name: "unrelated",
        label: "Unrelated tool",
        description: "An unrelated addition must survive fallback",
        parameters: { type: "object", properties: {} },
        execute: () => assert.fail("The unrelated tool must not execute"),
      });
      assert(!api.getActiveTools().includes("write"));
      assert(api.getActiveTools().includes("unrelated"));
      // A manual selection is kept in place, not re-ordered by restoration.
      api.setActiveTools([
        ...api.getActiveTools().filter((name) => name !== "read"),
        ...(writer === "custom" || writer === "shared-schema" ? ["edit"] : []),
      ]);
      const beforeRefusal = api.getActiveTools();
      const runner = session.extensionRunner;
      const replace = session.getToolDefinition("replace_text");
      assert(replace);
      const refuse = () =>
        replace.execute(
          "refused",
          { files: [{ path: "code.py", edits: [{ oldText: "hello", newText: "world" }] }] },
          undefined,
          undefined,
          runner.createToolContext("refused", runner.createContext().signal),
        );
      if (writer === "shutdown") {
        await runner.emit({ type: "session_shutdown", reason: "quit" });
      }
      const result = await refuse();
      assert.equal(result.isError, true);
      const details: unknown = result.details;
      assert(typeof details === "object" && details !== null && "error" in details);
      assert.equal(typeof details.error, "string");
      assert.match(String(details.error), refusal("code\\.py"));
      assert.partialDeepStrictEqual(result.details, {
        modifiedFiles: [],
        files: [{ path: join(cwd, "code.py"), status: "failed" }],
      });
      assert.deepEqual(
        api.getActiveTools(),
        writer === "builtin" ? [...beforeRefusal, "edit", "write"] : beforeRefusal,
      );
      api.setActiveTools([...EDITING_TOOL_NAMES, "unrelated"]);
      const manuallySelected = api.getActiveTools();
      assert.equal((await refuse()).isError, true);
      assert.deepEqual(api.getActiveTools(), manuallySelected);
      assert.equal(await readFile(join(cwd, "code.py"), "utf8"), "print('hello')\n");
    },
  );
}
