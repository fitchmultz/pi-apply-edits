import assert from "node:assert/strict";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatchToFiles, replaceTextInFiles, writeFiles } from "../src/apply-edits.ts";
import { planNewFile, publishNewFile } from "../src/file-system.ts";

const posix = process.platform !== "win32";
async function fixture(t: test.TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-native-paths-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "actual", "inner"), { recursive: true });
  await symlink("actual/inner", join(cwd, "link"));
  await writeFile(join(cwd, "actual", "target"), "native\n");
  await writeFile(join(cwd, "target"), "lexical\n");
  return cwd;
}

test("Windows creates agree with native DOS traversal through a junction", { skip: posix }, async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-native-windows-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "actual", "inner"), { recursive: true });
  await symlink(join(cwd, "actual", "inner"), join(cwd, "link"), "junction");
  for (const prefix of ["link/../", "missing/../link/../"]) {
    const native = `${cwd}/${prefix}native`;
    await mkdir(`${cwd}/${prefix}`, { recursive: true });
    await writeFile(native, "native");
    const result = await writeFiles({ files: [{ path: `${prefix}extension`, content: "extension", mode: "create" }] }, cwd);
    assert.equal(result.details.error, undefined, result.summary);
    assert.equal(await readFile(`${cwd}/${prefix}extension`, "utf8"), "extension");
    assert.equal(await realpath(native), (await realpath(`${cwd}/${prefix}extension`)).replace(/extension$/, "native"));
    await rm(native);
    await rm(`${cwd}/${prefix}extension`);
  }
  await assert.rejects(lstat(join(cwd, "missing")), /ENOENT/);
});

test("write_files follows native symlink/.. traversal", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  const result = await writeFiles({ files: [{ path: "link/../target", content: "changed\n", mode: "replace" }] }, cwd);
  assert.equal(result.details.error, undefined, result.summary);
  assert.equal(await readFile(`${cwd}/link/../target`, "utf8"), "changed\n");
  assert.equal(await readFile(join(cwd, "target"), "utf8"), "lexical\n");
  assert.deepEqual(result.details.modifiedFiles, [join(cwd, "actual", "target")]);
});

for (const kind of ["replace", "patch"] as const) {
  test(`${kind} previews and edits native paths without changing Unicode or formatting`, { skip: !posix }, async (t) => {
    const cwd = await fixture(t);
    const name = "a\u00a0b";
    await writeFile(join(cwd, "actual", name), "\uFEFFbefore\r\nuntouched\n");
    await writeFile(join(cwd, "actual", "a b"), "neighbor");
    const path = `link/../${name}`;
    const edit = (preview: boolean) => kind === "replace"
      ? replaceTextInFiles({ preview, files: [{ path, edits: [{ oldText: "before", newText: "after" }] }] }, cwd)
      : applyPatchToFiles(`*** Begin Patch\n*** Update File: ${path}\n@@\n-before\n+after\n*** End Patch`, cwd, preview);
    const preview = await edit(true);
    assert.equal(preview.details.error, undefined, preview.summary);
    assert(preview.summary.includes(path));
    assert.deepEqual(preview.details.modifiedFiles, []);
    assert.equal(await readFile(join(cwd, "actual", name), "utf8"), "\uFEFFbefore\r\nuntouched\n");
    const result = await edit(false);
    assert.equal(result.details.error, undefined, result.summary);
    assert.equal(await readFile(join(cwd, "actual", name), "utf8"), "\uFEFFafter\r\nuntouched\n");
    assert.equal(await readFile(join(cwd, "actual", "a b"), "utf8"), "neighbor");
  });
}

test("invalid traversal and missing/.. replacements never write a lexical neighbor", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  await symlink("target/", join(cwd, "slash-link"));
  await symlink("target/../target", join(cwd, "dotdot-link"));
  for (const path of ["target/../target", "target/", "missing/../target", "slash-link", "dotdot-link"]) {
    const result = await writeFiles({ files: [{ path, content: "wrong", mode: "replace" }] }, cwd);
    assert(result.details.error, path);
    assert.deepEqual(result.details.modifiedFiles, [], path);
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "lexical\n");
  }
  await assert.rejects(lstat(join(cwd, "missing")), /ENOENT/);
});

for (const operation of ["delete", "move"] as const) {
  test(`${operation} traverses parents natively but preserves final symlink entry semantics`, { skip: !posix }, async (t) => {
    const cwd = await fixture(t);
    await symlink("target", join(cwd, "actual", "entry"));
    await symlink("target", join(cwd, "entry"));
    const source = "link/../entry";
    const patch = operation === "delete" ? `*** Delete File: ${source}`
      : `*** Update File: ${source}\n*** Move to: link/../moved`;
    const result = await applyPatchToFiles(`*** Begin Patch\n${patch}\n*** End Patch`, cwd);
    assert.equal(result.details.error, undefined, result.summary);
    await assert.rejects(lstat(join(cwd, "actual", "entry")), /ENOENT/);
    assert.equal(await readlink(join(cwd, "entry")), "target");
    assert.equal(await readFile(join(cwd, "actual", "target"), "utf8"), "native\n");
    if (operation === "move") assert.equal(await readlink(join(cwd, "actual", "moved")), "target");
  });
}

test("public physical lock holds a native-addressed batch through callback completion", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocker = withFileMutationQueue(join(cwd, "actual", "target"), async () => { entered(); await held; });
  await started;
  let completed = false;
  const batch = writeFiles({ files: [
    { path: "link/../target", content: "changed", mode: "replace" },
    { path: "target", content: "second", mode: "replace" },
  ] }, cwd).then((result) => { completed = true; return result; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(completed, false);
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "lexical\n");
  } finally { release(); }
  await blocker;
  const result = await batch;
  assert.equal(result.details.error, undefined, result.summary);
});

test("prospective native aliases deduplicate before nested queue acquisition", { skip: !posix, timeout: 3000 }, async (t) => {
  const cwd = await fixture(t);
  for (const path of ["link/../new", "missing/../link/../new"]) {
    const result = await writeFiles({ files: [
      { path, content: "first", mode: "create" },
      { path: "actual/new", content: "second", mode: "create" },
    ] }, cwd);
    assert.match(result.summary, /same file/);
    assert.deepEqual(result.details.modifiedFiles, []);
    await assert.rejects(lstat(join(cwd, "actual", "new")), /ENOENT/);
    await assert.rejects(lstat(join(cwd, "missing")), /ENOENT/);
  }
});

for (const destination of ["created", "new/created"]) {
  test(`create preserves missing/.. traversal before an existing symlink: ${destination}`, { skip: !posix }, async (t) => {
    const cwd = await fixture(t);
    const path = `missing/deeper/../../link/../${destination}`;
    const request = { files: [{ path, content: "created", mode: "create" as const }] };
    const preview = await writeFiles({ ...request, preview: true }, cwd);
    assert.equal(preview.details.error, undefined, preview.summary);
    await assert.rejects(lstat(join(cwd, "missing")), /ENOENT/);
    const result = await writeFiles(request, cwd);
    assert.equal(result.details.error, undefined, result.summary);
    assert.equal(await readFile(`${cwd}/${path}`, "utf8"), "created");
    assert.equal(await readFile(join(cwd, "actual", destination), "utf8"), "created");
    assert((await lstat(join(cwd, "missing", "deeper"))).isDirectory());
  });
}

test("prospective creates refuse existing referents without publishing traversal directories", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  const result = await writeFiles({ files: [{ path: "missing/../link/../target", content: "wrong", mode: "create" }] }, cwd);
  assert(result.details.error);
  assert.deepEqual(result.details.modifiedFiles, []);
  assert.equal(await readFile(join(cwd, "actual", "target"), "utf8"), "native\n");
  await assert.rejects(lstat(join(cwd, "missing")), /ENOENT/);
});

test("batch planning failure and cancellation leave prospective traversal directories untouched", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  const first = { path: "missing/../link/../created", content: "new", mode: "create" as const };
  const failed = await writeFiles({ files: [first, { path: "absent", content: "bad", mode: "replace" }] }, cwd);
  assert(failed.details.error);
  const controller = new AbortController();
  const cancelled = await writeFiles({ files: [first] }, cwd, controller.signal, (summary) => {
    if (summary.startsWith("Publishing")) controller.abort();
  });
  assert.match(cancelled.summary, /aborted/);
  for (const result of [failed, cancelled]) assert.deepEqual(result.details.modifiedFiles, []);
  await assert.rejects(lstat(join(cwd, "missing")), /ENOENT/);
  await assert.rejects(lstat(join(cwd, "actual", "created")), /ENOENT/);
});

test("overlapping auxiliary traversal and staged roots fail before any batch write", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  for (const first of ["missing/file", "missing"]) {
    const result = await writeFiles({ files: [
      { path: "missing/deeper/../../link/../created", content: "first", mode: "create" },
      { path: first, content: "second", mode: "create" },
    ] }, cwd);
    assert.match(result.summary, /traversal directory.*Split.*calls/s);
    assert.deepEqual(result.details.modifiedFiles, []);
    await assert.rejects(lstat(join(cwd, "missing")), /ENOENT/);
    await assert.rejects(lstat(join(cwd, "actual", "created")), /ENOENT/);
  }
});

test("independent traversal directories and ordinary shared-root batches stay supported", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  const files = ["missing/../link/../new/a", "missing/../link/../new/b", "other/traverse/../child"].map((path) => ({ path, content: path, mode: "create" as const }));
  const result = await writeFiles({ files }, cwd);
  assert.equal(result.details.error, undefined, result.summary);
  for (const file of files) assert.equal(await readFile(`${cwd}/${file.path}`, "utf8"), file.content);
});

test("a replaced auxiliary directory parent fails before publication", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  const path = `${cwd}/link/missing/../../created`;
  const plan = await planNewFile(path);
  await assert.rejects(publishNewFile(path, Buffer.from("created"), undefined, plan, {
    beforeFilePublish: async () => {
      await rename(join(cwd, "actual", "inner"), join(cwd, "actual", "saved"));
      await mkdir(join(cwd, "actual", "inner"));
    },
  }), /changed identity/);
  await assert.rejects(lstat(join(cwd, "actual", "inner", "missing")), /ENOENT/);
  await assert.rejects(lstat(join(cwd, "actual", "created")), /ENOENT/);
});

test("failed publication cleans only owned prospective traversal directories", { skip: !posix }, async (t) => {
  const cwd = await fixture(t);
  const path = `${cwd}/missing/../link/../created`;
  const plan = await planNewFile(path);
  const controller = new AbortController();
  const originalMkdir = nodeFs.promises.mkdir;
  const mock = t.mock.method(nodeFs.promises, "mkdir", async (...args: Parameters<typeof originalMkdir>) => {
    const result = await originalMkdir(...args);
    if (String(args[0]) === join(cwd, "missing")) controller.abort();
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(publishNewFile(path, Buffer.from("created"), controller.signal, plan), /aborted/);
    assert(controller.signal.aborted, "cancellation followed actual traversal directory publication");
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(lstat(join(cwd, "missing")), /ENOENT/);
  await assert.rejects(lstat(join(cwd, "actual", "created")), /ENOENT/);
});
