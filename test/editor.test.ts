import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { applyPatchToFiles, replaceTextInFiles, writeFiles } from "../src/apply-edits.ts";

async function fixture(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pi-edit-contract-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const patch = (...operations: string[]) => `*** Begin Patch\n${operations.join("\n")}\n*** End Patch`;
const update = (path: string, before: string, after: string) => `*** Update File: ${path}\n@@\n-${before}\n+${after}`;

test("patch plans and applies create/update/move/delete with verified absolute receipts", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "source"), "\uFEFFbefore\r\nlast");
  await chmod(join(cwd, "source"), 0o751);
  await writeFile(join(cwd, "obsolete"), "delete\n");
  await writeFile(join(cwd, "plain"), "old\n");
  const result = await applyPatchToFiles(patch(
    "*** Update File: source\n*** Move to: nested/moved\n@@\n-before\n+after",
    "*** Add File: nested/new\n+created",
    "*** Delete File: obsolete",
    update("plain", "old", "new"),
  ), cwd);
  assert.equal(result.details.error, undefined, result.summary);
  assert.deepEqual(new Set(result.details.modifiedFiles), new Set(["source", "nested/moved", "nested/new", "obsolete", "plain"].map((path) => join(cwd, path))));
  assert.deepEqual(result.details.files.map((file) => [file.operation, file.status]), [["move", "applied"], ["create", "applied"], ["delete", "applied"], ["patch", "applied"]]);
  assert.equal(await readFile(join(cwd, "nested/moved"), "utf8"), "\uFEFFafter\r\nlast");
  assert.equal((await lstat(join(cwd, "nested/moved"))).mode & 0o777, 0o751);
  assert.equal(await readFile(join(cwd, "nested/new"), "utf8"), "created\n");
  for (const name of ["source", "obsolete"]) await assert.rejects(lstat(join(cwd, name)), /ENOENT/);
});

test("patch BOM rejection leaves update and move sources untouched", async (t) => {
  const cwd = await fixture(t);
  const original = "heading\n\uFEFFpayload\n";
  await writeFile(join(cwd, "source"), original);
  for (const preview of [false, true]) {
    for (const move of ["", "*** Move to: moved\n"]) {
      const result = await applyPatchToFiles(patch(`*** Update File: source\n${move}-heading`), cwd, preview);
      assert.match(result.details.error!, /U\+FEFF/);
      assert.deepEqual(result.details.modifiedFiles, []);
      assert.equal(await readFile(join(cwd, "source"), "utf8"), original);
      assert.deepEqual(await readdir(cwd), ["source"]);
    }
  }
});

test("pure moves and deletes operate on link entries, including dangling links", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "target"), "untouched\n");
  await symlink("target", join(cwd, "link"));
  await symlink("absent", join(cwd, "dangling"));
  const result = await applyPatchToFiles(patch("*** Update File: link\n*** Move to: moved", "*** Delete File: dangling"), cwd);
  assert.equal(result.details.error, undefined, result.summary);
  assert.equal(await readlink(join(cwd, "moved")), "target");
  assert.equal(await readFile(join(cwd, "target"), "utf8"), "untouched\n");
  assert.deepEqual(new Set(result.details.modifiedFiles), new Set(["link", "moved", "dangling"].map((path) => join(cwd, path))));
  const reject = await applyPatchToFiles(patch("*** Update File: moved\n*** Move to: elsewhere\n@@\n-untouched\n+wrong"), cwd);
  assert.match(reject.summary, /link-target content/);
  assert.deepEqual(reject.details.modifiedFiles, []);
});

test("batch refuses to delete a link used by another requested path", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await fixture(t);
  await mkdir(join(cwd, "real"));
  await symlink("real", join(cwd, "alias"));
  await symlink("alias", join(cwd, "pointer"));
  const deletion = "*** Delete File: alias";
  for (const name of ["alias", "pointer"]) {
    const creation = `*** Add File: ${name}/child.txt\n+content`;
    for (const operations of [[deletion, creation], [creation, deletion]]) {
      const result = await applyPatchToFiles(patch(...operations), cwd);
      assert.match(result.summary, /traverses symbolic link/);
      assert.deepEqual(result.details.modifiedFiles, []);
      assert.equal(await readlink(join(cwd, "alias")), "real");
      await assert.rejects(lstat(join(cwd, "real/child.txt")), /ENOENT/);
    }
  }
});

test("batch refuses to delete a link before deleting an entry through it", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await fixture(t);
  await mkdir(join(cwd, "real"));
  await writeFile(join(cwd, "real/child.txt"), "retained\n");
  await symlink("real", join(cwd, "alias"));
  const result = await applyPatchToFiles(patch("*** Delete File: alias", "*** Delete File: alias/child.txt"), cwd);
  assert.match(result.summary, /traverses symbolic link/);
  assert.deepEqual(result.details.modifiedFiles, []);
  assert.equal(await readlink(join(cwd, "alias")), "real");
  assert.equal(await readFile(join(cwd, "real/child.txt"), "utf8"), "retained\n");

  await symlink("alias/child.txt", join(cwd, "file-link"));
  const edit = await applyPatchToFiles(patch("*** Delete File: alias", "*** Update File: file-link\n@@\n-retained\n+changed"), cwd);
  assert.match(edit.summary, /traverses symbolic link/);
  assert.deepEqual(edit.details.modifiedFiles, []);
  assert.equal(await readFile(join(cwd, "real/child.txt"), "utf8"), "retained\n");

  const independent = await applyPatchToFiles(patch("*** Delete File: alias", "*** Delete File: file-link"), cwd);
  assert.equal(independent.details.error, undefined, independent.summary);
  for (const name of ["alias", "file-link"]) await assert.rejects(lstat(join(cwd, name)), /ENOENT/);
  assert.equal(await readFile(join(cwd, "real/child.txt"), "utf8"), "retained\n");
});

test("a planning failure publishes no earlier file and identifies unattempted operations", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "first"), "before\n");
  await writeFile(join(cwd, "second"), "actual\n");
  const result = await applyPatchToFiles(patch(update("first", "before", "after"), update("second", "wrong", "after"), "*** Add File: third\n+new"), cwd);
  assert(result.details.error);
  assert.deepEqual(result.details.modifiedFiles, []);
  assert.deepEqual(result.details.files.map((file) => file.status), ["unattempted", "failed", "unattempted"]);
  assert.equal(await readFile(join(cwd, "first"), "utf8"), "before\n");
  assert.deepEqual((await readdir(cwd)).sort(), ["first", "second"]);
});

test("cancellation retains earlier committed receipts and never misreports a final committed write", async (t) => {
  const cwd = await fixture(t);
  for (const path of ["a", "b", "c"]) await writeFile(join(cwd, path), "before\n");
  const controller = new AbortController();
  const result = await writeFiles({ files: ["a", "b", "c"].map((path) => ({ path, content: "after\n", mode: "replace" })) }, cwd, controller.signal, (summary) => {
    if (summary.startsWith("Completed 1/")) controller.abort();
  });
  assert(result.details.error);
  assert.deepEqual(result.details.modifiedFiles, [join(cwd, "a")]);
  assert.deepEqual(result.details.files.map((file) => file.status), ["applied", "failed", "unattempted"]);
  assert.equal(await readFile(join(cwd, "b"), "utf8"), "before\n");
  const finalAbort = new AbortController();
  const last = await writeFiles({ files: [{ path: "b", content: "after\n", mode: "replace" }] }, cwd, finalAbort.signal, (summary) => {
    if (summary.startsWith("Completed")) finalAbort.abort();
  });
  assert.equal(last.details.error, undefined, last.summary);
  assert.deepEqual(last.details.modifiedFiles, [join(cwd, "b")]);
});

test("compact replacements, exact writes, and unchanged receipts share the publication path", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "file"), "\uFEFFold\r\nSTART\r\nlarge body\r\nEND\r\nold\n");
  const replaced = await replaceTextInFiles({ files: [{ path: "file", edits: [
    { oldText: "old", newText: "new", all: true },
    { oldText: "START", endText: "END", newText: "range" },
  ] }] }, cwd);
  assert.equal(replaced.details.error, undefined, replaced.summary);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "\uFEFFnew\r\nrange\r\nnew\n");
  const content = "exact\nbytes\r\n";
  const exact = await writeFiles({ files: [{ path: "file", content, mode: "replace", preserveFormatting: false }] }, cwd);
  assert.equal(exact.details.error, undefined, exact.summary);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), content);
  const unchanged = await writeFiles({ files: [{ path: "file", content, mode: "replace", preserveFormatting: false }] }, cwd);
  assert.equal(unchanged.details.files[0]?.status, "unchanged");
  assert.deepEqual(unchanged.details.modifiedFiles, []);
  const createConflict = await writeFiles({ files: [{ path: "file", content: "bad", mode: "create" }] }, cwd);
  assert(createConflict.details.error);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), content);
});

test("preview does not stage directories or delete entries and does not cache a plan", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "file"), "before\n");
  const input = patch(update("file", "before", "after"), "*** Add File: new/child\n+new");
  const preview = await applyPatchToFiles(input, cwd, true);
  assert.equal(preview.details.error, undefined, preview.summary);
  assert.equal(preview.details.preview, true);
  assert.deepEqual(preview.details.modifiedFiles, []);
  assert.deepEqual(await readdir(cwd), ["file"]);
  await writeFile(join(cwd, "file"), "changed\n");
  const applied = await applyPatchToFiles(input, cwd);
  assert(applied.details.error);
  assert.deepEqual(applied.details.modifiedFiles, []);
  assert.deepEqual(await readdir(cwd), ["file"]);
  const deletion = await applyPatchToFiles(patch("*** Delete File: file"), cwd, true);
  assert.equal(deletion.details.error, undefined, deletion.summary);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "changed\n");
});

test("overlapping patch and structured calls observe invocation order", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "file"), "one\n");
  const results = await Promise.all([
    applyPatchToFiles(patch(update("file", "one", "two")), cwd),
    replaceTextInFiles({ files: [{ path: "file", edits: [{ oldText: "two", newText: "three" }] }] }, cwd),
  ]);
  for (const result of results) assert.equal(result.details.error, undefined, result.summary);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "three\n");
});
