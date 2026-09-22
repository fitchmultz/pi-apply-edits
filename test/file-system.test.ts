import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  captureEntrySnapshot,
  captureSnapshot,
  PartialCreatePublishError,
  planEntryMove,
  planNewFile,
  preparePlannedNestedFiles,
  PublicationError,
  publishEntryDelete,
  publishEntryMove,
  publishNewFile,
  publishPreparedNestedFiles,
  publishReplacement,
} from "../src/file-system.ts";

const replacementUnsupported = process.platform === "win32";

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "pi-entry-test-"));
  const directory = await realpath(temporary);
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function outcome(modifiedFiles: string[], uncertainFiles: string[]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof PublicationError);
    assert.deepEqual(error.modifiedFiles, modifiedFiles);
    assert.deepEqual(error.uncertainFiles, uncertainFiles);
    return true;
  };
}

test("replacement errors distinguish no commit, unverified publication and verified cleanup failure", {
  skip: replacementUnsupported,
}, async () => {
  await fixture(async (directory) => {
    for (const phase of ["beforeRename", "afterRename", "beforeRecoveryCleanup"] as const) {
      const path = join(directory, phase);
      await writeFile(path, "old");
      const snapshot = await captureSnapshot(path);
      assert.ok(snapshot);
      await assert.rejects(publishReplacement(snapshot, Buffer.from("new"), undefined, {
        [phase]: () => { throw new Error("fixture observer failed"); },
      }), outcome(phase === "beforeRecoveryCleanup" ? [path] : [], phase === "afterRename" ? [path] : []));
      assert.equal(await readFile(path, "utf8"), phase === "beforeRename" ? "old" : "new");
    }
  });
});

test("post-commit cancellation keeps a verified replacement receipt", { skip: replacementUnsupported }, async () => {
  await fixture(async (directory) => {
    const path = join(directory, "file");
    await writeFile(path, "old");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    const abort = new AbortController();
    await publishReplacement(snapshot, Buffer.from("new"), abort.signal, { afterRename: () => abort.abort() });
    assert.equal(await readFile(path, "utf8"), "new");
  });
});

test("single create reports an unverified committed entry without inventing a verified path", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "file");
    await assert.rejects(publishNewFile(path, Buffer.from("new"), undefined, await planNewFile(path), {
      afterFilePublish: () => { throw new Error("fixture observer failed"); },
    }), outcome([], [path]));
    assert.equal(await readFile(path, "utf8"), "new");
  });
});

test("grouped partial creation separates verified files from claimed but unverified entries", async () => {
  await fixture(async (directory) => {
    const first = join(directory, "new", "first");
    const second = join(directory, "new", "second");
    const prepared = await preparePlannedNestedFiles([
      { plan: await planNewFile(first), bytes: Buffer.from("first") },
      { plan: await planNewFile(second), bytes: Buffer.from("second") },
    ], undefined, { afterFilePublish: ({ target }) => { if (target === second) throw new Error("fixture observer failed"); } });
    await assert.rejects(publishPreparedNestedFiles(prepared), (error: unknown) => {
      assert.ok(error instanceof PartialCreatePublishError);
      assert.equal(error.publishedFiles, 2);
      return outcome([first], [second])(error);
    });
    assert.equal(await readFile(first, "utf8"), "first");
    assert.equal(await readFile(second, "utf8"), "second");
  });
});

test("delete removes only a regular entry and never accepts a directory", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "file");
    await writeFile(path, "old");
    const entry = await captureEntrySnapshot(path);
    assert.ok(entry);
    await publishEntryDelete(entry);
    await assert.rejects(lstat(path), { code: "ENOENT" });
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(captureEntrySnapshot(directory), /not a regular file or symbolic link/);
  });
});

test("delete of dangling and directory symlinks preserves their targets", { skip: process.platform === "win32" }, async () => {
  await fixture(async (directory) => {
    const target = join(directory, "target");
    await mkdir(target);
    await writeFile(join(target, "kept"), "keep");
    for (const name of ["target", "missing"]) {
      const path = join(directory, `link-${name}`);
      await symlink(name, path);
      const entry = await captureEntrySnapshot(path);
      assert.ok(entry?.symbolicLink);
      await publishEntryDelete(entry);
      await assert.rejects(lstat(path), { code: "ENOENT" });
    }
    assert.equal(await readFile(join(target, "kept"), "utf8"), "keep");
  });
});

test("delete cancellation before commit and failure after commit report different outcomes", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "file");
    await writeFile(path, "old");
    const entry = await captureEntrySnapshot(path);
    assert.ok(entry);
    const abort = new AbortController();
    await assert.rejects(publishEntryDelete(entry, abort.signal, { beforeCommit: () => abort.abort() }), outcome([], []));
    assert.equal(await readFile(path, "utf8"), "old");
    await assert.rejects(publishEntryDelete(entry, undefined, { afterCommit: () => { throw new Error("cleanup unavailable"); } }), outcome([path], []));
    await assert.rejects(lstat(path), { code: "ENOENT" });
    const retainedDirectory = (await readdir(directory))[0]!;
    assert.equal(await readFile(join(directory, retainedDirectory, "entry"), "utf8"), "old");
  });
});

test("pure move preserves inode, exact bytes and source metadata", async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    const bytes = Buffer.from("\ufeffone\r\ntwo");
    await writeFile(source, bytes, { mode: 0o751 });
    const before = await stat(source, { bigint: true });
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    await publishEntryMove(await planEntryMove(entry, target));
    await assert.rejects(lstat(source), { code: "ENOENT" });
    assert.deepEqual(await readFile(target), bytes);
    const after = await stat(target, { bigint: true });
    for (const key of ["ino", "dev", "mode", "uid", "gid", "mtimeNs", "nlink"] as const) assert.equal(after[key], before[key]);
    assert.deepEqual(await readdir(directory), ["target"]);
  });
});

test("entry paths canonicalize their parent without dereferencing a final link", { skip: process.platform === "win32" }, async () => {
  await fixture(async (directory) => {
    const parent = join(directory, "parent");
    await mkdir(parent);
    await symlink("parent", join(directory, "alias"));
    await symlink("missing", join(parent, "source"));
    const entry = await captureEntrySnapshot(join(directory, "alias", "source"));
    assert.equal(entry?.actualPath, join(parent, "source"));
    assert.ok(entry?.symbolicLink);
    await publishEntryMove(await planEntryMove(entry, join(directory, "target")));
    assert.equal(await readlink(join(directory, "target")), "missing");
    assert.equal((await lstat(join(directory, "target"), { bigint: true })).ino, entry.stats.ino);
    await assert.rejects(lstat(join(parent, "source")), { code: "ENOENT" });
  });
});

test("move never overwrites a destination present at planning or publication", async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    await writeFile(source, "source");
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    const plan = await planEntryMove(entry, target);
    await writeFile(target, "keep");
    await assert.rejects(planEntryMove(entry, target), /already exists/);
    await assert.rejects(publishEntryMove(plan), outcome([], []));
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.equal(await readFile(source, "utf8"), "source");
  });
});

test("move rejects cross-device plans before publication", { skip: process.platform === "win32" }, async (t) => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    await writeFile(source, "source");
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    if ((await stat("/dev", { bigint: true })).dev === entry.stats.dev) { t.skip("no second device available"); return; }
    await assert.rejects(planEntryMove(entry, `/dev/pi-entry-test-${process.pid}`, undefined, true), /Cross-device moves are not supported/);
    assert.equal(await readFile(source, "utf8"), "source");
  });
});

test("move cancellation and partial source-removal failure retain exact affected paths", async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    await writeFile(source, "source");
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    const plan = await planEntryMove(entry, target);
    const abort = new AbortController();
    await assert.rejects(publishEntryMove(plan, undefined, abort.signal, { beforeCommit: () => abort.abort() }), outcome([], []));
    assert.equal(await readFile(source, "utf8"), "source");
    await assert.rejects(publishEntryMove(plan, undefined, undefined, { beforeSourceDelete: () => { throw new Error("source removal unavailable"); } }), outcome([target], []));
    assert.equal(await readFile(source, "utf8"), "source");
    assert.equal(await readFile(target, "utf8"), "source");
  });
});

test("move finishes source removal after a post-publication abort", async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    await writeFile(source, "source");
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    const abort = new AbortController();
    await publishEntryMove(await planEntryMove(entry, target), undefined, abort.signal, { afterCommit: () => abort.abort() });
    await assert.rejects(lstat(source), { code: "ENOENT" });
    assert.equal(await readFile(target, "utf8"), "source");
  });
});

test("content move preserves source metadata and uses provided bytes", { skip: replacementUnsupported }, async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "new", "deeper", "target");
    await writeFile(source, "old", { mode: 0o751 });
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    const plan = await planEntryMove(entry, target);
    const snapshot = await captureSnapshot(source);
    assert.ok(snapshot);
    const bytes = Buffer.from("\ufeffnew\r\nlast");
    await publishEntryMove(plan, { snapshot, bytes });
    await assert.rejects(lstat(source), { code: "ENOENT" });
    assert.deepEqual(await readFile(target), bytes);
    const after = await stat(target, { bigint: true });
    for (const key of ["mode", "uid", "gid"] as const) assert.equal(after[key], snapshot.stats[key]);
    assert.equal(after.nlink, 1n);
    assert.deepEqual(await readdir(directory), ["new"]);
  });
});

test("content move failures leave original content intact and report only a published destination", { skip: replacementUnsupported }, async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    await writeFile(source, "old");
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    const plan = await planEntryMove(entry, target);
    const snapshot = await captureSnapshot(source);
    assert.ok(snapshot);
    const replacement = { snapshot, bytes: Buffer.from("new") };
    await writeFile(target, "keep");
    await assert.rejects(publishEntryMove(plan, replacement), outcome([], []));
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.equal(await readFile(source, "utf8"), "old");
    await rm(target);
    await assert.rejects(publishEntryMove(plan, replacement, undefined, {
      beforeSourceDelete: () => { throw new Error("source removal unavailable"); },
    }), outcome([target], []));
    assert.equal(await readFile(target, "utf8"), "new");
    assert.equal(await readFile(source, "utf8"), "old");
  });
});

test("content moves preserve macOS ACLs and extended attributes", { skip: process.platform !== "darwin" }, async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    await writeFile(source, "old");
    const exec = promisify(execFile);
    await exec("/usr/bin/xattr", ["-w", "com.pi-apply-edits.test", "kept", source]);
    await exec("/bin/chmod", ["+a", "everyone allow readattr", source]);
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    const plan = await planEntryMove(entry, target);
    const snapshot = await captureSnapshot(source);
    assert.ok(snapshot);
    await publishEntryMove(plan, { snapshot, bytes: Buffer.from("new") });
    assert.equal((await exec("/usr/bin/xattr", ["-p", "com.pi-apply-edits.test", target])).stdout.trim(), "kept");
    assert.match((await exec("/bin/ls", ["-le", target])).stdout, /everyone allow readattr/);
    await exec("/bin/chmod", ["-N", target]);
  });
});

test("mixed grouped moves and creates share a prebuilt missing root and truthful partial receipt", async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "new", "moved");
    const created = join(directory, "new", "created");
    await writeFile(source, "source");
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    const move = await planEntryMove(entry, target);
    const prepared = await preparePlannedNestedFiles([
      { plan: move.destination, bytes: Buffer.alloc(0), move: { entry } },
      { plan: await planNewFile(created), bytes: Buffer.from("created") },
    ], undefined, { beforeFilePublish: () => { throw new Error("second operation unavailable"); } });
    await assert.rejects(lstat(join(directory, "new")), { code: "ENOENT" });
    await assert.rejects(publishPreparedNestedFiles(prepared), outcome([target, source], []));
    assert.equal(await readFile(target, "utf8"), "source");
    await assert.rejects(lstat(source), { code: "ENOENT" });
    await assert.rejects(lstat(created), { code: "ENOENT" });
  });
});

test("grouped link moves preserve the link entry and target", { skip: process.platform === "win32" }, async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    const target = join(directory, "new", "link");
    await writeFile(join(directory, "kept"), "kept");
    await symlink("kept", source);
    const entry = await captureEntrySnapshot(source);
    assert.ok(entry);
    await publishEntryMove(await planEntryMove(entry, target));
    assert.equal(await readlink(target), "kept");
    assert.equal(await readFile(join(directory, "kept"), "utf8"), "kept");
  });
});

test("symlink-content moves reject without altering either entry or target", { skip: replacementUnsupported }, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "file");
    const source = join(directory, "source");
    const target = join(directory, "target");
    await writeFile(file, "old");
    await symlink("file", source);
    const entry = await captureEntrySnapshot(source);
    const snapshot = await captureSnapshot(source);
    assert.ok(entry && snapshot);
    await assert.rejects(publishEntryMove(await planEntryMove(entry, target), { snapshot, bytes: Buffer.from("new") }), /Cannot edit symbolic-link content/);
    assert.equal(await readlink(source), "file");
    assert.equal(await readFile(file, "utf8"), "old");
  });
});

test("preview entry planning reads non-writable directories without staging or probes", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  await fixture(async (directory) => {
    const source = join(directory, "source");
    await writeFile(source, "old");
    await chmod(directory, 0o555);
    try {
      const entry = await captureEntrySnapshot(source, false);
      assert.ok(entry);
      const plan = await planEntryMove(entry, join(directory, "new", "target"), undefined, true);
      assert.equal(plan.destination.missingDirectories.length, 1);
      assert.deepEqual(await readdir(directory), ["source"]);
      await assert.rejects(planEntryMove(entry, join(directory, "target")), /writable/);
    } finally { await chmod(directory, 0o755); }
  });
});
