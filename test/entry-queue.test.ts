import assert from "node:assert/strict";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lstat, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatchToFiles, writeFiles } from "../src/apply-edits.ts";

for (const operation of ["delete", "move"] as const) {
  test(`entry ${operation} queues a self-referential link without resolving its target`, { skip: process.platform === "win32" }, async (t) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-entry-queue-")));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const path = join(cwd, "loop");
    await symlink("loop", path);
    const patch = `*** Begin Patch\n${operation === "delete" ? "*** Delete File: loop" : "*** Update File: loop\n*** Move to: moved"}\n*** End Patch`;
    const result = await applyPatchToFiles(patch, cwd);
    assert.equal(result.details.error, undefined, result.summary);
    assert(result.details.modifiedFiles.includes(path));
    await assert.rejects(lstat(path), /ENOENT/);
    if (operation === "move") assert.equal(await readlink(join(cwd, "moved")), "loop");
  });
}

test("a later create waits for deletion of an unresolvable link entry", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-entry-order-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await symlink("loop", join(cwd, "loop"));
  let deletion: ReturnType<typeof applyPatchToFiles> | undefined;
  let creation: ReturnType<typeof writeFiles> | undefined;
  await withFileMutationQueue(cwd, async () => {
    deletion = applyPatchToFiles("*** Begin Patch\n*** Delete File: loop\n*** End Patch", cwd);
    creation = writeFiles({ files: [{ path: "loop", content: "created\n", mode: "create" }] }, cwd);
  });
  for (const result of await Promise.all([deletion!, creation!])) assert.equal(result.details.error, undefined, result.summary);
  assert.equal(await readFile(join(cwd, "loop"), "utf8"), "created\n");
});

for (const operation of ["delete", "move"] as const) {
  for (const path of ["created", "nested/created"]) {
    test(`entry ${operation} waits for an earlier create of ${path}`, async (t) => {
      const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-entry-create-order-")));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      const creation = writeFiles({ files: [{ path, content: "created\n", mode: "create" }] }, cwd);
      const entry = operation === "delete" ? `*** Delete File: ${path}` : `*** Update File: ${path}\n*** Move to: moved`;
      const mutation = applyPatchToFiles(`*** Begin Patch\n${entry}\n*** End Patch`, cwd);
      for (const result of await Promise.all([creation, mutation])) {
        assert.equal(result.details.error, undefined, result.summary);
      }
      await assert.rejects(lstat(join(cwd, path)), /ENOENT/);
      if (operation === "move") assert.equal(await readFile(join(cwd, "moved"), "utf8"), "created\n");
    });
  }
}

test("missing entry errors identify the failed operation and state that nothing was written", async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-entry-missing-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "first"), "before\n");
  for (const preview of [false, true]) {
    for (const entry of ["*** Delete File: gone", "*** Update File: missing/gone\n*** Move to: moved"]) {
      const result = await applyPatchToFiles(`*** Begin Patch\n*** Update File: first\n@@\n-before\n+after\n${entry}\n*** End Patch`, cwd, preview);
      assert.match(result.summary, /files\[1\]: File does not exist: (?:missing\/)?gone\. No changes were written/);
      assert.doesNotMatch(result.summary, /ENOENT/);
      assert.deepEqual(result.details.modifiedFiles, []);
      assert.deepEqual(result.details.files.map((file) => file.status), ["unattempted", "failed"]);
      assert.equal(await readFile(join(cwd, "first"), "utf8"), "before\n");
    }
  }
});

test("partial move text exposes its verified destination even when source removal fails", async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-entry-partial-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = join(cwd, "source");
  const destination = join(cwd, "destination");
  await writeFile(source, "retained\n");
  const rename = nodeFs.promises.rename;
  const mock = t.mock.method(nodeFs.promises, "rename", async (...args: Parameters<typeof rename>) => {
    if (args[0] === source) throw new Error("Fixture source removal unavailable");
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await applyPatchToFiles("*** Begin Patch\n*** Update File: source\n*** Move to: destination\n*** End Patch", cwd);
    assert(result.details.error);
    assert.deepEqual(result.details.modifiedFiles, [destination]);
    assert.equal(result.details.files[0]?.status, "failed");
    assert.match(result.summary, /after 1 verified path change/);
    assert(result.summary.includes(`Verified committed paths: ${destination}`));
    assert.equal(await readFile(source, "utf8"), "retained\n");
    assert.equal(await readFile(destination, "utf8"), "retained\n");
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("success summaries distinguish create, delete, and move", async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-entry-summary-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const created = await applyPatchToFiles("*** Begin Patch\n*** Add File: file\n+content\n*** End Patch", cwd);
  assert.match(created.summary, /^Created 1 file/);
  const moved = await applyPatchToFiles("*** Begin Patch\n*** Update File: file\n*** Move to: moved\n*** End Patch", cwd);
  assert.match(moved.summary, /^Moved 1 file: file → moved/);
  const deleted = await applyPatchToFiles("*** Begin Patch\n*** Delete File: moved\n*** End Patch", cwd);
  assert.match(deleted.summary, /^Deleted 1 file/);
});
