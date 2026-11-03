import assert from "node:assert/strict";
import nodeFs from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test as nodeTest, type TestContext } from "node:test";
import { applyPatchToFiles, replaceTextInFiles, writeFiles } from "../src/apply-edits.ts";
import { supportsExistingFileReplacement } from "../src/file-system.ts";
import { EDITING_TOOL_NAMES } from "../src/tools.ts";
import { harness } from "./extension-harness.ts";

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

nodeTest(
  "a refused publication restores the built-in writers the extension replaced",
  { skip },
  async (t) => {
    const cwd = await fixture(t);
    const session = await harness(t, ["read", "edit", "write", ...EDITING_TOOL_NAMES], false, cwd);
    await session.session.extensionRunner.emit({ type: "session_start", reason: "new" });
    assert.deepEqual(session.state.active, ["read", ...EDITING_TOOL_NAMES]);
    const replace = session.tools.get("replace_text");
    assert(replace);
    const runner = session.session.extensionRunner;
    const result = await replace.execute(
      "refused",
      { files: [{ path: "code.py", edits: [{ oldText: "hello", newText: "world" }] }] },
      undefined,
      undefined,
      runner.createToolContext("refused", runner.createContext().signal),
    );
    assert.equal(result.isError, true);
    assert.deepEqual(session.state.active, ["read", ...EDITING_TOOL_NAMES, "edit", "write"]);
  },
);
