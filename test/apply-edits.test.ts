import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  applyEditsToFile,
  applyTargetedEdits,
  resolveInputPath,
  RetryableApplyEditsError,
  type ApplyEditsDetails,
} from "../src/apply-edits.ts";

function singleDetails(details: { files?: ApplyEditsDetails[] } | ApplyEditsDetails): ApplyEditsDetails {
  if (details && typeof details === "object" && "files" in details) {
    throw new Error("expected single-file details");
  }
  return details as ApplyEditsDetails;
}

import {
  assertSnapshotCurrent,
  captureSnapshot,
  discardPreparedNestedFiles,
  planNewFile,
  preparePlannedNestedFiles,
  publishNewFile,
  publishPreparedNestedFiles,
  publishReplacement,
} from "../src/file-system.ts";

const execFile = promisify(execFileCallback);

async function inTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-apply-edits-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type FileSystemModule = typeof import("../src/file-system.ts");

/**
 * Loads a private copy of the file-system module with `node:fs/promises` patched, so a rename or
 * symlink swap can be injected in the middle of a publication syscall. Patches are reverted after.
 */
async function withRacingFileSystem<T = FileSystemModule>(
  patch: (promises: typeof nodeFs.promises) => void,
  run: (module: T) => Promise<void>,
  specifier = "../src/file-system.ts",
): Promise<void> {
  const originals = { ...nodeFs.promises };
  try {
    patch(nodeFs.promises);
    syncBuiltinESMExports();
    await run((await import(`${specifier}?race=${randomUUID()}`)) as T);
  } finally {
    Object.assign(nodeFs.promises, originals);
    syncBuiltinESMExports();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function firstExistingFile(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Try the next conventional location.
    }
  }
  return undefined;
}

test("ordered edits see prior replacements", () => {
  const result = applyTargetedEdits(
    "const state = 'old';\nconsole.log(state);\n",
    [
      { oldText: "const state = 'old';", newText: "const state = 'new';" },
      { oldText: "const state = 'new';\nconsole.log(state);", newText: "const state = 'done';" },
    ],
    "example.ts",
  );

  assert.equal(result.text, "const state = 'done';\n");
  assert.deepEqual(result.matches.map((match) => match.strategy), ["exact", "exact"]);
});

test("repeated text requires all or more context", () => {
  assert.throws(
    () => applyTargetedEdits("x\nx\n", [{ oldText: "x", newText: "y" }], "file.txt"),
    /matched 2 locations.*all: true/s,
  );

  const result = applyTargetedEdits(
    "x\nx\n",
    [{ oldText: "x", newText: "y", all: true }],
    "file.txt",
  );
  assert.equal(result.text, "y\ny\n");
  assert.equal(result.matches[0]?.replacements, 2);
});

test("large replace-all runs linearly and bounds structured line details", () => {
  const result = applyTargetedEdits(
    "x\n".repeat(10_000),
    [{ oldText: "x", newText: "y", all: true }],
    "file.txt",
  );

  assert.equal(result.text, "y\n".repeat(10_000));
  assert.equal(result.matches[0]?.replacements, 10_000);
  assert.equal(result.matches[0]?.lines.length, 32);
  assert.equal(result.matches[0]?.linesTruncated, true);
});

test("replacement count is capped before unbounded match arrays can grow", () => {
  assert.throws(
    () =>
      applyTargetedEdits(
        "x".repeat(10_001),
        [{ oldText: "x", newText: "y", all: true }],
        "large.txt",
      ),
    /more than 10,000 locations/,
  );
});

test("replace-all amplification is rejected under a bounded heap", () => {
  const moduleUrl = new URL("../src/apply-edits.ts", import.meta.url).href;
  const program = `
    import { applyTargetedEdits } from ${JSON.stringify(moduleUrl)};
    const content = "a\\n".repeat(10_000);
    try {
      applyTargetedEdits(
        content,
        [{ oldText: "a", newText: "x".repeat(10_000), all: true }],
        "large.txt",
      );
    } catch (error) {
      process.stdout.write(error.message);
    }
  `;
  const result = spawnSync(
    process.execPath,
    // Importing Pi itself exceeds 32 MB on Node 24; 48 MB still proves no 100 MB result is built.
    ["--max-old-space-size=48", "--input-type=module", "--eval", program],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /expand the result/);
});

test("normalized matching fails fast when candidate work exceeds its safety budget", () => {
  const content = `${"filler\n".repeat(60_000)}    alpha\n    beta\n    gamma\n    delta\n    epsilon\n`;
  assert.throws(
    () =>
      applyTargetedEdits(
        content,
        [{ oldText: "alpha\nbeta\ngamma\ndelta\nepsilon", newText: "done" }],
        "large.txt",
      ),
    /Could not find/,
  );
});

test("failed-match diagnostics stay bounded under a 64 MB heap", () => {
  const moduleUrl = new URL("../src/apply-edits.ts", import.meta.url).href;
  const program = `
    import { applyTargetedEdits } from ${JSON.stringify(moduleUrl)};
    const content = "x\\n".repeat(1_000_000);
    try {
      applyTargetedEdits(content, [{ oldText: "missing\\nblock", newText: "done" }], "large.txt");
    } catch {
      process.stdout.write("bounded");
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "--eval", program],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "bounded");
});

test("benign typography and trailing whitespace drift match only as complete lines", () => {
  const result = applyTargetedEdits(
    "const label = “ready”;   \nnext();\n",
    [{ oldText: 'const label = "ready";\nnext();', newText: 'const label = "done";\nnext();' }],
    "file.ts",
  );

  assert.equal(result.text, 'const label = "done";\nnext();\n');
  assert.equal(result.matches[0]?.strategy, "normalized");
});

test("uniform indentation drift reindents the replacement", () => {
  const result = applyTargetedEdits(
    "function run() {\n    if (ready) {\n        start();\n    }\n}\n",
    [
      {
        oldText: "if (ready) {\n    start();\n}",
        newText: "if (ready) {\n    prepare();\n    start();\n}",
      },
    ],
    "file.ts",
  );

  assert.equal(
    result.text,
    "function run() {\n    if (ready) {\n        prepare();\n        start();\n    }\n}\n",
  );
  assert.equal(result.matches[0]?.strategy, "indent-normalized");
});

test("indent-normalized replacements apply the candidate-versus-search indent delta", () => {
  const result = applyTargetedEdits(
    "  if (ready) {\n    start();\n  }\n",
    [{
      oldText: "    if (ready) {\n      start();\n    }",
      newText: "if (ready) {\n  prepare();\n}",
    }],
    "file.ts",
  );

  assert.equal(result.text, "if (ready) {\nprepare();\n}\n");
  assert.equal(result.matches[0]?.strategy, "indent-normalized");
});

test("indent correction preserves relative width when common indentation cuts through a tab", () => {
  const result = applyTargetedEdits(
    "    if (ready) {\n      start();\n    }\n",
    [
      {
        oldText: "  if (ready) {\n\tstart();\n  }",
        newText: "  if (ready) {\n\tprepare();\n  }",
      },
    ],
    "file.ts",
  );

  assert.equal(result.text, "    if (ready) {\n      prepare();\n    }\n");
  assert.equal(result.matches[0]?.strategy, "indent-normalized");
});

test("indent correction preserves non-indentation Unicode whitespace", () => {
  const result = applyTargetedEdits(
    "  if (ready)\n    old\n",
    [{ oldText: "if (ready)\n  old", newText: "if (ready)\n  \u00a0value" }],
    "file.ts",
  );

  assert.equal(result.text, "  if (ready)\n    \u00a0value\n");
  assert.equal(result.matches[0]?.strategy, "indent-normalized");
});

test("ordered edits can match prior CRLF output with LF anchors", () => {
  const result = applyTargetedEdits(
    "one\r\ntwo\r\n",
    [
      { oldText: "one", newText: "ONE\nadded" },
      { oldText: "ONE\nadded", newText: "done" },
    ],
    "windows.txt",
  );

  assert.equal(result.text, "done\r\ntwo\r\n");
  assert.deepEqual(result.matches.map((match) => match.strategy), ["exact", "exact"]);
});

test("ambiguous normalized matches fail without choosing one", () => {
  assert.throws(
    () =>
      applyTargetedEdits(
        "  if (ok) {\n    run();\n  }\n\n    if (ok) {\n      run();\n    }\n",
        [{ oldText: "if (ok) {\n  run();\n}", newText: "if (ok) stop();" }],
        "file.ts",
      ),
    /matched 2 locations/,
  );
});

test("overlapping normalized all-matches are rejected", () => {
  assert.throws(
    () =>
      applyTargetedEdits(
        "a   \na   \na   \n",
        [{ oldText: "a\na", newText: "b", all: true }],
        "file.txt",
      ),
    /overlapping matches/,
  );
});

test("missing text reports a bounded nearby block and possible idempotence", () => {
  assert.throws(
    () =>
      applyTargetedEdits(
        "alpha\nconst answer = 42;\nomega\n",
        [{ oldText: "const answer = 41;", newText: "const answer = 42;" }],
        "file.ts",
      ),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /replacement text already appears at line 2/i);
      assert.match(error.message, /Closest block is lines 2-2/);
      assert.match(error.message, /No changes were written/);
      return true;
    },
  );
});

test("all must be a boolean even through the core API", () => {
  assert.throws(
    () => applyTargetedEdits("x\nx\n", [{ oldText: "x", newText: "y", all: 1 as never }], "file.txt"),
    /all must be a boolean/,
  );
});

test("empty, NUL, and no-op targeted edits fail", () => {
  assert.throws(() => applyTargetedEdits("x", [{ oldText: "", newText: "y" }], "f"), /must not be empty/);
  assert.throws(() => applyTargetedEdits("x", [{ oldText: "x", newText: "x" }], "f"), /no change/);
  assert.throws(() => applyTargetedEdits("x", [{ oldText: "x", newText: "\0" }], "f"), /NUL/);
  assert.throws(
    () => applyTargetedEdits("x", [{ oldText: "x", newText: "\ud800" }], "f"),
    /valid Unicode/,
  );
});

test("request size limits bound files and ordered edits", async () => {
  assert.throws(
    () => applyTargetedEdits("x", Array.from({ length: 101 }, () => ({ oldText: "x", newText: "y" })), "f"),
    /more than 100 entries/,
  );
  await assert.rejects(
    applyEditsToFile({
      files: Array.from({ length: 65 }, (_, index) => ({
        path: `${index}.txt`,
        rewrite: "x",
        onMissing: "create" as const,
      })),
    }, process.cwd()),
    /more than 64 entries/,
  );
});

test("a failed ordered batch leaves the file byte-for-byte unchanged", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    const original = Buffer.from("one\ntwo\n");
    await writeFile(path, original);

    await assert.rejects(
      applyEditsToFile(
        {
          path,
          edits: [
            { oldText: "one", newText: "changed" },
            { oldText: "missing", newText: "never" },
          ],
        },
        directory,
      ),
      /No changes were written/,
    );

    assert.deepEqual(await readFile(path), original);
    assert.deepEqual((await readdir(directory)).sort(), ["file.txt"]);
  });
});

test("rewrite creation is explicit and creates parent directories", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "nested", "file.txt");
    await assert.rejects(
      applyEditsToFile({ path, rewrite: "hello\n" }, directory),
      /onMissing: "create"/,
    );
    await assert.rejects(readFile(path), /ENOENT/);

    const result = await applyEditsToFile(
      { path, rewrite: "hello\n", onMissing: "create" },
      directory,
    );
    assert.equal(await readFile(path, "utf8"), "hello\n");
    assert.equal(singleDetails(result.details).operation, "create");
    assert.match(result.summary, /^Created nested\/file\.txt/);
  });
});

test("missing rewrite failures expose compact-create eligibility before any write", async () => {
  await inTemporaryDirectory(async (directory) => {
    await assert.rejects(
      applyEditsToFile(
        {
          files: [
            { path: "a.txt", rewrite: "A\n" },
            { path: "b.txt", rewrite: "B\n" },
          ],
        },
        directory,
      ),
      (error: unknown) => {
        assert(error instanceof RetryableApplyEditsError);
        assert.deepEqual(error.retry, { kind: "create", files: [0, 1] });
        assert.match(error.message, /files\[0\].*onMissing: "create"/s);
        return true;
      },
    );
    await assert.rejects(readFile(join(directory, "a.txt")), /ENOENT/);
    await assert.rejects(readFile(join(directory, "b.txt")), /ENOENT/);
  });
});

test("explicit onMissing error does not offer compact create", async () => {
  await inTemporaryDirectory(async (directory) => {
    await assert.rejects(
      applyEditsToFile(
        { path: "missing.txt", rewrite: "content\n", onMissing: "error" },
        directory,
      ),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error instanceof RetryableApplyEditsError, false);
        assert.match(error.message, /onMissing: "create"/);
        return true;
      },
    );
  });
});

test("requireMissing prevents compact create retries from rewriting a file that appeared", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "appeared.txt");
    await writeFile(path, "external\n");

    await assert.rejects(
      applyEditsToFile(
        { path, rewrite: "agent\n", onMissing: "create", requireMissing: true },
        directory,
      ),
      /File now exists.*No changes were written/s,
    );
    assert.equal(await readFile(path, "utf8"), "external\n");
  });
});

test("requireMissing keeps a stale create batch entirely unchanged", async () => {
  await inTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "appeared.txt"), "external\n");

    await assert.rejects(
      applyEditsToFile(
        {
          files: [
            {
              path: "still-missing.txt",
              rewrite: "new\n",
              onMissing: "create",
              requireMissing: true,
            },
            {
              path: "appeared.txt",
              rewrite: "agent\n",
              onMissing: "create",
              requireMissing: true,
            },
          ],
        },
        directory,
      ),
      /File now exists.*No changes were written/s,
    );
    await assert.rejects(readFile(join(directory, "still-missing.txt")), /ENOENT/);
    assert.equal(await readFile(join(directory, "appeared.txt"), "utf8"), "external\n");
  });
});

test("create reports a file-valued parent without raw filesystem errors", async () => {
  await inTemporaryDirectory(async (directory) => {
    const parent = join(directory, "parent");
    await writeFile(parent, "not a directory\n");

    await assert.rejects(
      applyEditsToFile(
        { path: join(parent, "child.txt"), rewrite: "content\n", onMissing: "create" },
        directory,
      ),
      /a parent path is not a directory\. No changes were written/,
    );
    assert.equal(await readFile(parent, "utf8"), "not a directory\n");
  });
});

test("existing rewrites preserve UTF-8 BOM and CRLF line endings", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "windows.txt");
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\r\n")]));

    await applyEditsToFile({ path, rewrite: "alpha\nbeta\n" }, directory);

    assert.deepEqual(
      await readFile(path),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\r\nbeta\r\n")]),
    );
  });
});

test("targeted edits preserve CRLF and BOM", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "windows.txt");
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\r\n")]));

    await applyEditsToFile(
      { path, edits: [{ oldText: "one\ntwo", newText: "one\nthree" }] },
      directory,
    );

    assert.deepEqual(
      await readFile(path),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\nthree\r\n")]),
    );
  });
});

test("targeted edits reject newly leading U+FEFF without changing bytes", async () => {
  await inTemporaryDirectory(async (directory) => {
    const withBom = join(directory, "with-bom.txt");
    const withoutBom = join(directory, "without-bom.txt");
    const originalWithBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\n")]);
    await writeFile(withBom, originalWithBom);
    await writeFile(withoutBom, "one\n");

    await assert.rejects(
      () => applyEditsToFile(
        { path: withBom, edits: [{ oldText: "one", newText: "\uFEFFtwo" }] },
        directory,
      ),
      /would move or add U\+FEFF/,
    );
    await assert.rejects(
      () => applyEditsToFile(
        { path: withoutBom, edits: [{ oldText: "one", newText: "\uFEFFtwo" }] },
        directory,
      ),
      /would move or add U\+FEFF/,
    );

    assert.deepEqual(await readFile(withBom), originalWithBom);
    assert.equal(await readFile(withoutBom, "utf8"), "one\n");
  });
});

test("targeted edits match internal U+FEFF anchors exactly", () => {
  assert.equal(
    applyTargetedEdits(
      "p|\uFEFFtoken|s",
      [{ oldText: "\uFEFFtoken", newText: "changed" }],
      "internal-feff.txt",
    ).text,
    "p|changed|s",
  );
  assert.equal(
    applyTargetedEdits(
      "p|\uFEFFtoken|s",
      [{ oldText: "\uFEFFtoken", newText: "X", insert: "before" }],
      "internal-feff.txt",
    ).text,
    "p|X\uFEFFtoken|s",
  );
});

test("targeted edits reject deletion that would silently remove relocated U+FEFF", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "relocated-feff.txt");
    const original = Buffer.from("x\uFEFFy");
    await writeFile(path, original);

    await assert.rejects(
      () => applyEditsToFile(
        { path, edits: [{ oldText: "x", newText: "" }] },
        directory,
      ),
      /would move or add U\+FEFF/,
    );
    assert.deepEqual(await readFile(path), original);
  });
});

test("targeted edits preserve a second leading U+FEFF content character", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "double-bom.txt");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(path, Buffer.concat([bom, bom, Buffer.from("keep\nold\n")]));

    await applyEditsToFile(
      { path, edits: [{ oldText: "old", newText: "new" }] },
      directory,
    );

    assert.deepEqual(
      await readFile(path),
      Buffer.concat([bom, bom, Buffer.from("keep\nnew\n")]),
    );
  });
});

test("non-regular and dangling-link targets are refused", { skip: process.platform === "win32" }, async () => {
  await inTemporaryDirectory(async (directory) => {
    const childDirectory = join(directory, "child");
    const dangling = join(directory, "dangling.txt");
    await mkdir(childDirectory);
    await symlink("missing.txt", dangling);

    await assert.rejects(
      applyEditsToFile(
        { path: childDirectory, edits: [{ oldText: "before", newText: "after" }] },
        directory,
      ),
      /not a regular file/,
    );
    await assert.rejects(
      applyEditsToFile(
        { path: dangling, edits: [{ oldText: "before", newText: "after" }] },
        directory,
      ),
      /dangling symbolic link/,
    );
  });
});

test("editing through a symbolic link preserves the link", { skip: process.platform === "win32" }, async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "target.txt");
    const alias = join(directory, "alias.txt");
    await writeFile(target, "before\n");
    await symlink("target.txt", alias);

    await applyEditsToFile(
      { path: alias, edits: [{ oldText: "before", newText: "after" }] },
      directory,
    );

    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), "after\n");
  });
});

test("existing file mode is preserved", { skip: process.platform === "win32" }, async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "script.sh");
    await writeFile(path, "echo before\n");
    await chmod(path, 0o751);

    await applyEditsToFile(
      { path, edits: [{ oldText: "before", newText: "after" }] },
      directory,
    );

    assert.equal((await stat(path)).mode & 0o777, 0o751);
  });
});

test("setuid and setgid files are rejected without metadata loss", { skip: process.platform === "win32" }, async () => {
  await inTemporaryDirectory(async (directory) => {
    for (const mode of [0o4755, 0o2755, 0o6755]) {
      const path = join(directory, mode.toString(8));
      await writeFile(path, "before\n");
      await chmod(path, mode);

      await assert.rejects(
        applyEditsToFile(
          { path, edits: [{ oldText: "before", newText: "after" }] },
          directory,
        ),
        /setuid or setgid/,
      );
      assert.equal((await stat(path)).mode & 0o7777, mode);
      assert.equal(await readFile(path, "utf8"), "before\n");
    }
  });
});

test("capability-bearing Linux files are rejected unchanged", { skip: process.platform !== "linux" }, async (t) => {
  await inTemporaryDirectory(async (directory) => {
    const setcap = await firstExistingFile(["/usr/sbin/setcap", "/sbin/setcap", "/usr/bin/setcap"]);
    const getcap = await firstExistingFile(["/usr/sbin/getcap", "/sbin/getcap", "/usr/bin/getcap"]);
    if (!setcap || !getcap) {
      t.skip("setcap/getcap are unavailable");
      return;
    }
    const path = join(directory, "capability.txt");
    await writeFile(path, "before\n");
    try {
      await execFile(setcap, ["cap_net_bind_service=ep", path]);
    } catch {
      t.skip("the test user cannot set file capabilities");
      return;
    }

    await assert.rejects(
      applyEditsToFile(
        { path, edits: [{ oldText: "before", newText: "after" }] },
        directory,
      ),
      /capability-bearing Linux file/,
    );
    assert.equal(await readFile(path, "utf8"), "before\n");
    const { stdout } = await execFile(getcap, ["-n", path]);
    assert.notEqual(stdout.trim(), "");
  });
});

test(
  "atomic replacement preserves macOS extended attributes and ACLs",
  { skip: process.platform !== "darwin" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "metadata.txt");
      const attribute = "com.pi-apply-edits.test";
      const acl = `user:${userInfo().username} allow read`;
      await writeFile(path, "before\n");
      await execFile("/usr/bin/xattr", ["-w", attribute, "retained", path]);
      await execFile("/bin/chmod", ["+a", acl, path]);

      await applyEditsToFile(
        { path, edits: [{ oldText: "before", newText: "after" }] },
        directory,
      );

      const { stdout } = await execFile("/usr/bin/xattr", ["-p", attribute, path]);
      const { stdout: listing } = await execFile("/bin/ls", ["-le", path]);
      assert.equal(stdout.trim(), "retained");
      assert.match(listing, new RegExp(`user:${userInfo().username} allow read`));
    });
  },
);

test(
  "read-only files are refused even when their directory permits replacement",
  {
    skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
  },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "protected.txt");
      await writeFile(path, "before\n");
      await chmod(path, 0o444);

      await assert.rejects(
        applyEditsToFile(
          { path, edits: [{ oldText: "before", newText: "after" }] },
          directory,
        ),
        /must be readable and writable/,
      );
      assert.equal(await readFile(path, "utf8"), "before\n");
    });
  },
);

test("hard-linked files are refused without changing either name", { skip: process.platform === "win32" }, async () => {
  await inTemporaryDirectory(async (directory) => {
    const first = join(directory, "first.txt");
    const second = join(directory, "second.txt");
    await writeFile(first, "before\n");
    await link(first, second);

    await assert.rejects(
      applyEditsToFile(
        { path: first, edits: [{ oldText: "before", newText: "after" }] },
        directory,
      ),
      /hard-linked file/,
    );
    assert.equal(await readFile(first, "utf8"), "before\n");
    assert.equal(await readFile(second, "utf8"), "before\n");
  });
});

test("non-UTF-8 and NUL-containing files are refused unchanged", async () => {
  await inTemporaryDirectory(async (directory) => {
    const invalid = join(directory, "invalid.txt");
    const nul = join(directory, "nul.txt");
    await writeFile(invalid, Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(nul, Buffer.from("a\0b"));

    await assert.rejects(
      applyEditsToFile({ path: invalid, edits: [{ oldText: "a", newText: "b" }] }, directory),
      /non-UTF-8/,
    );
    await assert.rejects(
      applyEditsToFile({ path: nul, edits: [{ oldText: "a", newText: "b" }] }, directory),
      /NUL bytes/,
    );
    assert.deepEqual(await readFile(invalid), Buffer.from([0xff, 0xfe, 0xfd]));
    assert.deepEqual(await readFile(nul), Buffer.from("a\0b"));
  });
});

test("concurrent calls on one path serialize through Pi's mutation queue", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    await writeFile(path, "one\n");

    await Promise.all([
      applyEditsToFile({ path, edits: [{ oldText: "one", newText: "two" }] }, directory),
      applyEditsToFile({ path, edits: [{ oldText: "two", newText: "three" }] }, directory),
    ]);

    assert.equal(await readFile(path, "utf8"), "three\n");
  });
});

test(
  "real and symbolic paths share Pi's mutation queue",
  { skip: process.platform === "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const target = join(directory, "target.txt");
      const alias = join(directory, "alias.txt");
      await writeFile(target, "one\n");
      await symlink("target.txt", alias);

      await Promise.all([
        applyEditsToFile({ path: alias, edits: [{ oldText: "one", newText: "two" }] }, directory),
        applyEditsToFile({ path: target, edits: [{ oldText: "two", newText: "three" }] }, directory),
      ]);

      assert.equal(await readFile(target, "utf8"), "three\n");
      assert.equal((await lstat(alias)).isSymbolicLink(), true);
    });
  },
);

test("replacement rejects a canonical parent alias swapped before rename", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalParent = join(directory, "original");
    const otherParent = join(directory, "other");
    const alias = join(directory, "alias");
    await mkdir(originalParent);
    await mkdir(otherParent);
    await writeFile(join(originalParent, "file.txt"), "before\n");
    await writeFile(join(otherParent, "file.txt"), "outside\n");
    await symlink(originalParent, alias);
    const snapshot = await captureSnapshot(join(alias, "file.txt"));
    assert.ok(snapshot);

    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
        beforeRename: async ({ temporary }) => {
          assert.equal((await lstat(dirname(temporary))).mode & 0o777, 0o700);
          await unlink(alias);
          await symlink(otherParent, alias);
        },
      }),
      /File path changed before commit/,
    );

    assert.equal(await readFile(join(originalParent, "file.txt"), "utf8"), "before\n");
    assert.equal(await readFile(join(otherParent, "file.txt"), "utf8"), "outside\n");
  });
});

test("replacement rejects a final target changed into a symbolic link", async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "target.txt");
    const saved = join(directory, "saved.txt");
    await writeFile(target, "before\n");
    const snapshot = await captureSnapshot(target);
    assert.ok(snapshot);

    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
        beforeRename: async () => {
          await rename(target, saved);
          await symlink(saved, target);
        },
      }),
      /File path changed before commit/,
    );

    assert.equal((await lstat(target)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), "before\n");
    assert.equal(await readFile(saved, "utf8"), "before\n");
  });
});

test(
  "replacement rejects an extended-attribute change after the recovery link",
  { skip: process.platform !== "darwin" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const target = join(directory, "target.txt");
      await writeFile(target, "before\n");
      const snapshot = await captureSnapshot(target);
      assert.ok(snapshot);

      await assert.rejects(
        publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
          beforeRename: async () => {
            await execFile("/usr/bin/xattr", [
              "-w",
              "com.pi-apply-edits.concurrent",
              "kept",
              target,
            ]);
          },
        }),
        /changed before commit/,
      );

      assert.equal(await readFile(target, "utf8"), "before\n");
      const { stdout } = await execFile("/usr/bin/xattr", [
        "-p",
        "com.pi-apply-edits.concurrent",
        target,
      ]);
      assert.equal(stdout.trim(), "kept");
    });
  },
);

test("replacement honors an abort from the final rename hook", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    await writeFile(path, "before\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    const controller = new AbortController();

    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("after\n"), controller.signal, {
        beforeRename: () => controller.abort(),
      }),
      /Operation aborted before file content was committed/,
    );
    assert.equal(await readFile(path, "utf8"), "before\n");
  });
});

test("replacement cleanup leaves a swapped-in temporary file untouched", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    const victim = join(directory, "victim.txt");
    await writeFile(path, "before\n");
    await writeFile(victim, "KEEP\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    let temporary = "";
    let saved = "";

    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
        beforeRename: async (paths) => {
          temporary = paths.temporary;
          saved = `${temporary}.saved`;
          await rename(temporary, saved);
          await rename(victim, temporary);
        },
      }),
      /Temporary replacement changed before commit.*Cleanup was incomplete.*changed identity/s,
    );

    assert.equal(await readFile(path, "utf8"), "before\n");
    assert.equal(await readFile(temporary, "utf8"), "KEEP\n");
    assert.equal(await readFile(saved, "utf8"), "after\n");
    await rm(dirname(temporary), { recursive: true });
  });
});

test("post-rename read failures report uncertain commit state and retain recovery", {
  skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
}, async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    await writeFile(path, "before\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    let recovery = "";

    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
        afterRename: async (paths) => {
          recovery = paths.recovery;
          await chmod(recovery, 0o000);
        },
      }),
      /Commit status is uncertain; inspect the target and recovery path/,
    );

    assert.equal(await readFile(path, "utf8"), "after\n");
    await chmod(recovery, 0o644);
    assert.equal(await readFile(recovery, "utf8"), "before\n");
    await unlink(recovery);
  });
});

test("recovery-side writes retain both versions without automatic rollback", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    await writeFile(path, "before\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    let recovery = "";

    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("agent\n"), undefined, {
        afterRename: async (paths) => {
          recovery = paths.recovery;
          await writeFile(recovery, "external\n");
        },
      }),
      /No automatic rollback was attempted.*current target was left untouched/,
    );

    assert.equal(await readFile(path, "utf8"), "agent\n");
    assert.equal(await readFile(recovery, "utf8"), "external\n");
    await unlink(recovery);
  });
});

test("a target replaced at the former rollback boundary is never overwritten", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    const external = join(directory, "external.txt");
    await writeFile(path, "before\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    let recovery = "";

    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("agent\n"), undefined, {
        afterRename: async (paths) => {
          recovery = paths.recovery;
          await writeFile(recovery, "external-old-inode\n");
        },
        beforeConflictReturn: async () => {
          await writeFile(external, "external-new-inode\n");
          await rename(external, path);
        },
      }),
      /No automatic rollback was attempted.*current target was left untouched/,
    );

    assert.equal(await readFile(path, "utf8"), "external-new-inode\n");
    assert.equal(await readFile(recovery, "utf8"), "external-old-inode\n");
    await unlink(recovery);
  });
});

test("simultaneous old-inode and new-inode writers are both retained", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    const external = join(directory, "external.txt");
    await writeFile(path, "before\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    let recovery = "";

    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("agent\n"), undefined, {
        afterRename: async (paths) => {
          recovery = paths.recovery;
          await writeFile(recovery, "external-old-inode\n");
          await writeFile(external, "external-new-inode\n");
          await rename(external, path);
        },
      }),
      /File versions changed.*No automatic rollback was attempted/,
    );

    assert.equal(await readFile(path, "utf8"), "external-new-inode\n");
    assert.equal(await readFile(recovery, "utf8"), "external-old-inode\n");
    await unlink(recovery);
  });
});

test("post-commit cleanup and sync failures return explicit warnings", {
  skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
}, async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    await writeFile(path, "before\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    let recovery = "";
    let warnings: string[] = [];

    try {
      warnings = await publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
        beforeRecoveryCleanup: async (paths) => {
          recovery = paths.recovery;
          await chmod(directory, 0o000);
        },
      });
    } finally {
      await chmod(directory, 0o755);
    }

    assert.equal(await readFile(path, "utf8"), "after\n");
    assert.equal(await readFile(recovery, "utf8"), "before\n");
    assert.match(
      warnings.join(" "),
      /recovery cleanup was incomplete; the previous content may remain at .* or elsewhere/,
    );
    assert.match(warnings.join(" "), /parent directory could not be synced/);
    await unlink(recovery);
  });
});

test("recovery cleanup leaves a swapped-in file untouched", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    const victim = join(directory, "victim.txt");
    await writeFile(path, "before\n");
    await writeFile(victim, "KEEP\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    let recovery = "";
    let saved = "";

    const warnings = await publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
      beforeRecoveryCleanup: async (paths) => {
        recovery = paths.recovery;
        saved = `${recovery}.saved`;
        await rename(recovery, saved);
        await rename(victim, recovery);
      },
    });

    assert.equal(await readFile(path, "utf8"), "after\n");
    assert.equal(await readFile(recovery, "utf8"), "KEEP\n");
    assert.equal(await readFile(saved, "utf8"), "before\n");
    assert.match(warnings.join(" "), /changed identity and was left untouched/);
    await unlink(recovery);
    await unlink(saved);
  });
});

test("recovery cleanup preserves writes made after commit verification", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    await writeFile(path, "before\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);

    const warnings = await publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
      beforeRecoveryCleanup: async ({ recovery }) => writeFile(recovery, "EXTERNAL\n"),
    });

    const preserved = /preserved at (.+)$/.exec(warnings.join(" "))?.[1];
    assert.ok(preserved);
    assert.equal(await readFile(path, "utf8"), "after\n");
    assert.equal(await readFile(preserved, "utf8"), "EXTERNAL\n");
    await rm(dirname(preserved), { recursive: true });
  });
});

test("diff statistics count content that resembles patch headers", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "patch-like.txt");
    await writeFile(path, "--before\n");

    const result = await applyEditsToFile({ path, rewrite: "++after\n" }, directory);

    assert.equal(singleDetails(result.details).addedLines, 1);
    assert.equal(singleDetails(result.details).deletedLines, 1);
  });
});

test("many-line rewrites skip quadratic diff work even when byte size is small", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "many-lines.txt");
    await writeFile(path, "a\n".repeat(5_000));

    const result = await applyEditsToFile(
      { path, rewrite: "b\n".repeat(5_000) },
      directory,
    );

    assert.equal(singleDetails(result.details).diffTruncated, true);
    assert.match(singleDetails(result.details).diff, /Diff omitted/);
    assert.equal(singleDetails(result.details).addedLines, undefined);
    assert.equal(singleDetails(result.details).deletedLines, undefined);
  });
});

test("batch summary omits aggregate counts when one changed diff count is unavailable", async () => {
  await inTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "small.txt"), "a\n");
    await writeFile(join(directory, "large.txt"), "a\n".repeat(5_000));

    const result = await applyEditsToFile({
      files: [
        { path: "small.txt", rewrite: "b\n" },
        { path: "large.txt", rewrite: "b\n".repeat(5_000) },
      ],
    }, directory);

    assert.doesNotMatch(result.summary, /\(\+\d+\/-\d+\)/);
    assert.ok("files" in result.details);
    assert.equal(result.details.files[1]?.addedLines, undefined);
  });
});

test("large rewrites skip expensive diff computation", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "large.txt");
    const original = `${"a".repeat(2_100_000)}\n`;
    const replacement = `${"b"}${original.slice(1)}`;
    await writeFile(path, original);

    const result = await applyEditsToFile({ path, rewrite: replacement }, directory);

    assert.match(singleDetails(result.details).diff, /Diff omitted/);
    assert.equal(singleDetails(result.details).diffTruncated, true);
    assert.equal(await readFile(path, "utf8"), replacement);
  });
});

test("snapshot validation detects stale no-change plans", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    await writeFile(path, "same\n");
    const snapshot = await captureSnapshot(path);
    assert.ok(snapshot);
    await writeFile(path, "changed\n");
    await assert.rejects(assertSnapshotCurrent(snapshot), /changed before commit/);
  });
});

test("aborted creates remove parent directories created by the call", async () => {
  await inTemporaryDirectory(async (directory) => {
    const firstParent = join(directory, "a");
    const path = join(firstParent, "b", "file.txt");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(publishNewFile(path, Buffer.from("content"), controller.signal), /aborted/);
    await assert.rejects(lstat(firstParent), (error: unknown) => {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    });
  });
});

test("aborted calls and identical rewrites have explicit non-mutating outcomes", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "file.txt");
    await writeFile(path, "same\n");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      applyEditsToFile({ path, rewrite: "different\n" }, directory, controller.signal),
      /aborted before file content/,
    );
    assert.equal(await readFile(path, "utf8"), "same\n");

    const result = await applyEditsToFile({ path, rewrite: "same\n" }, directory);
    assert.equal(singleDetails(result.details).operation, "no_change");
    assert.equal(await readFile(path, "utf8"), "same\n");
  });
});

test("literal Unicode spaces and leading @ path segments are never rewritten", async () => {
  await inTemporaryDirectory(async (directory) => {
    const unicodePath = join(directory, "a\u00a0b.txt");
    const asciiPath = join(directory, "a b.txt");
    const atDirectory = join(directory, "@src");
    const atPath = join(atDirectory, "file.txt");
    await mkdir(atDirectory);
    await writeFile(unicodePath, "unicode\n");
    await writeFile(asciiPath, "ascii\n");
    await writeFile(atPath, "before\n");

    assert.equal(resolveInputPath("a\u00a0b.txt", directory), unicodePath);
    assert.equal(resolveInputPath("@src/file.txt", directory), atPath);
    await applyEditsToFile(
      { path: "a\u00a0b.txt", edits: [{ oldText: "unicode", newText: "changed" }] },
      directory,
    );
    await applyEditsToFile(
      { path: "@src/file.txt", edits: [{ oldText: "before", newText: "after" }] },
      directory,
    );
    assert.equal(await readFile(unicodePath, "utf8"), "changed\n");
    assert.equal(await readFile(asciiPath, "utf8"), "ascii\n");
    assert.equal(await readFile(atPath, "utf8"), "after\n");

    const literalTilde = join(directory, "~");
    await mkdir(literalTilde);
    assert.equal(resolveInputPath("~", directory), literalTilde);
    assert.equal(resolveInputPath("./~", directory), literalTilde);
  });
});

test("file URL-shaped paths are always literal", async () => {
  await inTemporaryDirectory(async (directory) => {
    const literalDirectory = join(directory, "file:", "host");
    const literalPath = join(literalDirectory, "x.txt");
    await mkdir(literalDirectory, { recursive: true });
    await writeFile(literalPath, "literal\n");

    assert.equal(resolveInputPath("file://host/x.txt", directory), literalPath);
    assert.equal(
      resolveInputPath("file://missing/y.txt", directory),
      join(directory, "file:", "missing", "y.txt"),
    );
  });
});

test("insert before/after anchors without replacing them", () => {
  const after = applyTargetedEdits(
    'import fs from "node:fs";\n',
    [{ oldText: 'import fs from "node:fs";', newText: '\nimport path from "node:path";', insert: "after" }],
    "a.ts",
  );
  assert.equal(after.text, 'import fs from "node:fs";\nimport path from "node:path";\n');

  const before = applyTargetedEdits(
    "export function main() {}\n",
    [{ oldText: "export function main()", newText: "// entry\n", insert: "before" }],
    "a.ts",
  );
  assert.equal(before.text, "// entry\nexport function main() {}\n");
});

test("insert all applies at every match and empty insert text fails", () => {
  const result = applyTargetedEdits(
    "item\nitem\n",
    [{ oldText: "item", newText: "!", insert: "after", all: true }],
    "list.txt",
  );
  assert.equal(result.text, "item!\nitem!\n");

  assert.throws(
    () =>
      applyTargetedEdits(
        "item\n",
        [{ oldText: "item", newText: "", insert: "after" }],
        "list.txt",
      ),
    /newText must not be empty when insert is set/,
  );
});

test("multi-file batch plans then writes all files", async () => {
  await inTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "a.ts"), "const a = 1;\n");
    await writeFile(join(directory, "b.ts"), "const b = 1;\n");

    const result = await applyEditsToFile(
      {
        files: [
          { path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
          {
            path: "b.ts",
            edits: [{ oldText: "const b = 1;", newText: "\nexport {};", insert: "after" }],
          },
        ],
      },
      directory,
    );

    assert.match(result.summary, /Updated 2 files/);
    assert.match(result.summary, /zero separator/);
    assert.equal("files" in result.details, true);
    if (!("files" in result.details)) throw new Error("expected batch details");
    assert.equal(result.details.files.length, 2);
    assert.equal(await readFile(join(directory, "a.ts"), "utf8"), "const a = 2;\n");
    assert.equal(await readFile(join(directory, "b.ts"), "utf8"), "const b = 1;\nexport {};\n");
  });
});

test("multi-file batch publishes sibling creates under one missing root together", async () => {
  await inTemporaryDirectory(async (directory) => {
    const result = await applyEditsToFile(
      {
        files: [
          { path: "shared/a.txt", rewrite: "A\n", onMissing: "create" },
          { path: "shared/b.txt", rewrite: "B\n", onMissing: "create" },
          { path: "shared/nested/c.txt", rewrite: "C\n", onMissing: "create" },
        ],
      },
      directory,
    );

    assert.match(result.summary, /Updated 3 files/);
    assert.equal(await readFile(join(directory, "shared/a.txt"), "utf8"), "A\n");
    assert.equal(await readFile(join(directory, "shared/b.txt"), "utf8"), "B\n");
    assert.equal(await readFile(join(directory, "shared/nested/c.txt"), "utf8"), "C\n");
    assert.equal(
      (await stat(join(directory, "shared"))).mode & 0o777,
      0o777 & ~process.umask(),
    );
    assert.equal((await stat(join(directory, "shared/a.txt"))).nlink, 1);
    assert.equal((await stat(join(directory, "shared/b.txt"))).nlink, 1);
    assert.equal((await stat(join(directory, "shared/nested/c.txt"))).nlink, 1);
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith(".pi-apply-edits-")),
      false,
    );
  });
});

test("nested create staging failures are detected before earlier batch writes", async () => {
  await inTemporaryDirectory(async (directory) => {
    const sentinel = join(directory, "sentinel.txt");
    await writeFile(sentinel, "old\n");

    await assert.rejects(
      () => applyEditsToFile(
        {
          files: [
            { path: "sentinel.txt", rewrite: "new\n" },
            {
              path: `missing/${"x".repeat(300)}.txt`,
              rewrite: "content\n",
              onMissing: "create",
            },
          ],
        },
        directory,
      ),
      /could not be prepared|ENAMETOOLONG/,
    );

    assert.equal(await readFile(sentinel, "utf8"), "old\n");
    await assert.rejects(() => readFile(join(directory, "missing"), "utf8"), /ENOENT/);
  });
});

test("sibling creates reject alias-spelled missing roots before publication", async () => {
  await inTemporaryDirectory(async (directory) => {
    const probe = join(directory, "probe");
    let caseInsensitive = false;
    try {
      await mkdir(probe);
      const { statSync } = await import("node:fs");
      caseInsensitive = statSync(probe).ino === statSync(join(directory, "PROBE")).ino;
      await rm(probe, { recursive: true });
    } catch {
      await rm(probe, { recursive: true, force: true });
    }
    if (!caseInsensitive) return;

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "Shared/a.txt", rewrite: "A\n", onMissing: "create" },
              { path: "shared/b.txt", rewrite: "B\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /alias spellings/,
    );
    await assert.rejects(() => readFile(join(directory, "shared/a.txt"), "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(join(directory, "Shared/b.txt"), "utf8"), /ENOENT/);
  });
});

test("multi-file batch writes nothing when a later file cannot be planned", async () => {
  await inTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "a.ts"), "const a = 1;\n");
    await writeFile(join(directory, "b.ts"), "const b = 1;\n");

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
              { path: "b.ts", edits: [{ oldText: "missing", newText: "x" }] },
            ],
          },
          directory,
        ),
      /Could not find edits\[0\]\.oldText/,
    );

    assert.equal(await readFile(join(directory, "a.ts"), "utf8"), "const a = 1;\n");
    assert.equal(await readFile(join(directory, "b.ts"), "utf8"), "const b = 1;\n");
  });
});

test("ambiguous batch anchors expose the exact compact oldText correction", async () => {
  await inTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "a.txt"), "first\n");
    await writeFile(join(directory, "b.txt"), "target\ntarget\n");

    await assert.rejects(
      applyEditsToFile(
        {
          files: [
            { path: "a.txt", edits: [{ oldText: "first", newText: "FIRST" }] },
            { path: "b.txt", edits: [{ oldText: "target", newText: "changed" }] },
          ],
        },
        directory,
      ),
      (error: unknown) => {
        assert(error instanceof RetryableApplyEditsError);
        assert.deepEqual(error.retry, { kind: "oldText", file: 1, edit: 0 });
        assert.match(error.message, /files\[1\].*matched 2 locations/s);
        return true;
      },
    );
    assert.equal(await readFile(join(directory, "a.txt"), "utf8"), "first\n");
    assert.equal(await readFile(join(directory, "b.txt"), "utf8"), "target\ntarget\n");
  });
});

test("multi-file batch rejects duplicate resolved paths", async () => {
  await inTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "a.ts"), "x\n");
    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
              { path: "./a.ts", edits: [{ oldText: "y", newText: "z" }] },
            ],
          },
          directory,
        ),
      /same file/,
    );
  });
});

test("insert does not guess that adjacent text makes the request idempotent", () => {
  const result = applyTargetedEdits(
    'import fs from "node:fs";\nimport path from "node:path";\n',
    [{
      oldText: 'import fs from "node:fs";',
      newText: '\nimport path from "node:path";',
      insert: "after",
    }],
    "a.ts",
  );
  assert.equal(
    result.text,
    'import fs from "node:fs";\nimport path from "node:path";\nimport path from "node:path";\n',
  );
});

test("insert all rejects overlapping normalized anchor windows", () => {
  assert.throws(
    () =>
      applyTargetedEdits(
        "a \na \na \n",
        [{ oldText: "a\na", newText: "!", insert: "after", all: true }],
        "file.txt",
      ),
    /overlapping matches/,
  );
});

test("multi-file batch rejects symlink aliases of the same file", async () => {
  await inTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "a.txt"), "x\n");
    await symlink(join(directory, "a.txt"), join(directory, "alias.txt"));
    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] },
              { path: "alias.txt", edits: [{ oldText: "x", newText: "z" }] },
            ],
          },
          directory,
        ),
      /same file/,
    );
    assert.equal(await readFile(join(directory, "a.txt"), "utf8"), "x\n");
  });
});

test("multi-file batch rejects case-alias paths of the same file on case-insensitive volumes", async () => {
  await inTemporaryDirectory(async (directory) => {
    const lower = join(directory, "a.txt");
    await writeFile(lower, "x\n");
    const upper = join(directory, "A.TXT");
    // On case-insensitive APFS, upper is the same inode; on case-sensitive FS this is a second file.
    let sameFile = false;
    try {
      const { statSync } = await import("node:fs");
      sameFile = statSync(lower).ino === statSync(upper).ino;
    } catch {
      sameFile = false;
    }
    if (!sameFile) return; // skip on case-sensitive volumes

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] },
              { path: "A.TXT", edits: [{ oldText: "x", newText: "z" }] },
            ],
          },
          directory,
        ),
      /same file/,
    );
    assert.equal(await readFile(lower, "utf8"), "x\n");
  });
});

test("multi-file batch refuses hard-linked targets during plan before any write", async () => {
  await inTemporaryDirectory(async (directory) => {
    const first = join(directory, "a.txt");
    const second = join(directory, "b.txt");
    const linked = join(directory, "b-link.txt");
    await writeFile(first, "one\n");
    await writeFile(second, "two\n");
    await link(second, linked);

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "a.txt", edits: [{ oldText: "one", newText: "ONE" }] },
              { path: "b.txt", edits: [{ oldText: "two", newText: "TWO" }] },
            ],
          },
          directory,
        ),
      /hard-linked file/,
    );

    assert.equal(await readFile(first, "utf8"), "one\n");
    assert.equal(await readFile(second, "utf8"), "two\n");
  });
});

test("missing text with no close match shows the file head", () => {
  assert.throws(
    () =>
      applyTargetedEdits(
        "alpha\nbeta\ngamma\n",
        [{ oldText: "zzzz-not-present", newText: "nope" }],
        "file.txt",
      ),
    /File starts with:\nalpha\nbeta\ngamma/,
  );
});

test("insert all applies at anchors with adjacent short text", () => {
  const result = applyTargetedEdits(
    "x!\ny\nx\n",
    [{ oldText: "x", newText: "!", insert: "after", all: true }],
    "file.txt",
  );
  // short insert "!" is not treated as idempotent; both x get !
  assert.equal(result.text, "x!!\ny\nx!\n");
});

test("insert all applies even when identical text is already adjacent", () => {
  const result = applyTargetedEdits(
    "x<!--done-->\ny\nx\n",
    [{ oldText: "x", newText: "<!--done-->", insert: "after", all: true }],
    "file.txt",
  );
  assert.equal(result.text, "x<!--done--><!--done-->\ny\nx<!--done-->\n");
});

test("short insert after shared prefix is not false-already-applied", () => {
  const result = applyTargetedEdits(
    "test\n",
    [{ oldText: "tes", newText: "t", insert: "after" }],
    "file.txt",
  );
  assert.equal(result.text, "testt\n");
});

test("exact overlapping matches are ambiguous without all", () => {
  assert.throws(
    () => applyTargetedEdits("banana\n", [{ oldText: "ana", newText: "X" }], "overlap.txt"),
    /matched 2 locations/,
  );
});

test("exact overlapping all-matches are rejected", () => {
  assert.throws(
    () =>
      applyTargetedEdits("banana\n", [{ oldText: "ana", newText: "X", all: true }], "overlap.txt"),
    /overlapping matches/,
  );
});

test("multi-file batch rejects create aliases through symlink parents before any write", async () => {
  await inTemporaryDirectory(async (directory) => {
    const real = join(directory, "real");
    const alias = join(directory, "alias");
    await mkdir(real);
    await symlink(real, alias);

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: join(real, "new.txt"), rewrite: "first\n", onMissing: "create" },
              { path: join(alias, "new.txt"), rewrite: "second\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /same file/,
    );

    await assert.rejects(() => readFile(join(real, "new.txt"), "utf8"), /ENOENT/);
  });
});

test("multi-file batch rejects Unicode case-fold aliases of the same missing path", async () => {
  await inTemporaryDirectory(async (directory) => {
    const plain = join(directory, "s");
    const longS = join(directory, "ſ");
    let aliases = false;
    try {
      await writeFile(plain, "probe\n");
      const { statSync } = await import("node:fs");
      aliases = statSync(plain).ino === statSync(longS).ino;
      await unlink(plain);
    } catch {
      try { await unlink(plain); } catch { /* ignore */ }
    }
    if (!aliases) return;

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: plain, rewrite: "first\n", onMissing: "create" },
              { path: longS, rewrite: "second\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /same file/,
    );
    await assert.rejects(() => readFile(plain, "utf8"), /ENOENT/);
  });
});

test("Linux keeps distinct NFC and NFD missing paths", { skip: process.platform !== "linux" }, async () => {
  await inTemporaryDirectory(async (directory) => {
    const nfc = "é.txt";
    const nfd = "é.txt";
    await applyEditsToFile({
      files: [
        { path: nfc, rewrite: "NFC\n", onMissing: "create" },
        { path: nfd, rewrite: "NFD\n", onMissing: "create" },
      ],
    }, directory);
    assert.equal(await readFile(join(directory, nfc), "utf8"), "NFC\n");
    assert.equal(await readFile(join(directory, nfd), "utf8"), "NFD\n");
  });
});

test("multi-file batch rejects uppercase/lowercase sharp-S aliases", async () => {
  await inTemporaryDirectory(async (directory) => {
    const upper = join(directory, "ẞ.txt");
    const lower = join(directory, "ß.txt");
    let aliases = false;
    try {
      await writeFile(upper, "probe\n");
      const { statSync } = await import("node:fs");
      aliases = statSync(upper).ino === statSync(lower).ino;
      await unlink(upper);
    } catch {
      try { await unlink(upper); } catch { /* ignore */ }
    }
    if (!aliases) return;

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: upper, rewrite: "upper\n", onMissing: "create" },
              { path: lower, rewrite: "lower\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /same file/,
    );
    await assert.rejects(() => readFile(upper, "utf8"), /ENOENT/);
  });
});

test("exact match wins in mixed-line-ending files", () => {
  const result = applyTargetedEdits(
    "A\nB\n---\r\nA\r\nB\r\n",
    [{ oldText: "A\nB\n", newText: "X\n" }],
    "mixed.txt",
  );
  assert.equal(result.text, "X\n---\r\nA\r\nB\r\n");
  assert.equal(result.matches[0]?.strategy, "exact");
});

test("multi-file batch rejects case-alias creates of the same missing path", async () => {
  await inTemporaryDirectory(async (directory) => {
    // On case-sensitive volumes this creates two different paths; skip if both can coexist.
    const lower = join(directory, "new.txt");
    const upper = join(directory, "NEW.TXT");
    let caseInsensitive = false;
    try {
      await writeFile(lower, "probe\n");
      const { statSync } = await import("node:fs");
      caseInsensitive = statSync(lower).ino === statSync(upper).ino;
      await unlink(lower);
    } catch {
      caseInsensitive = false;
      try { await unlink(lower); } catch { /* ignore */ }
    }
    if (!caseInsensitive) return;

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "new.txt", rewrite: "first\n", onMissing: "create" },
              { path: "NEW.TXT", rewrite: "second\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /same file/,
    );
    await assert.rejects(() => readFile(lower, "utf8"), /ENOENT/);
  });
});

test("multi-file batch rejects create under an existing file parent before any write", async () => {
  await inTemporaryDirectory(async (directory) => {
    const first = join(directory, "first.txt");
    const blocker = join(directory, "blocker");
    await writeFile(first, "old\n");
    await writeFile(blocker, "file\n");

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "first.txt", rewrite: "new\n" },
              { path: "blocker/child.txt", rewrite: "child\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /not a directory/,
    );

    assert.equal(await readFile(first, "utf8"), "old\n");
  });
});

test("multi-file batch rejects a path nested under another batch target before any write", async () => {
  await inTemporaryDirectory(async (directory) => {
    const first = join(directory, "first.txt");
    await writeFile(first, "old\n");

    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "first.txt", rewrite: "new\n" },
              { path: "parent", rewrite: "file\n", onMissing: "create" },
              { path: "parent/child.txt", rewrite: "child\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /nested under/,
    );

    assert.equal(await readFile(first, "utf8"), "old\n");
    await assert.rejects(() => readFile(join(directory, "parent"), "utf8"), /ENOENT/);
  });
});

test("ancestor conflict detection cannot be bypassed by a locale-sort interloper", async () => {
  await inTemporaryDirectory(async (directory) => {
    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "a", rewrite: "file\n", onMissing: "create" },
              { path: "a-", rewrite: "other\n", onMissing: "create" },
              { path: "a/x", rewrite: "child\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /nested under/,
    );
    for (const path of ["a", "a-", "a/x"]) {
      await assert.rejects(() => readFile(join(directory, path), "utf8"), /ENOENT/);
    }
  });
});

test("multi-file batch rejects dangling parent symlinks during plan", async () => {
  await inTemporaryDirectory(async (directory) => {
    await symlink(join(directory, "missing-dir"), join(directory, "dangling"));
    await assert.rejects(
      () =>
        applyEditsToFile(
          {
            files: [
              { path: "first.txt", rewrite: "written\n", onMissing: "create" },
              { path: "dangling/child.txt", rewrite: "child\n", onMissing: "create" },
            ],
          },
          directory,
        ),
      /dangling symbolic link/,
    );
    await assert.rejects(() => readFile(join(directory, "first.txt"), "utf8"), /ENOENT/);
  });
});

test("planned create stays bound to its canonical parent if an alias changes", async () => {
  await inTemporaryDirectory(async (directory) => {
    const dir1 = join(directory, "dir1");
    const dir2 = join(directory, "dir2");
    const alias = join(directory, "alias");
    await mkdir(dir1);
    await mkdir(dir2);
    await symlink(dir1, alias);

    const inputPath = join(alias, "child.txt");
    const plan = await planNewFile(inputPath);
    await unlink(alias);
    await symlink(dir2, alias);
    await publishNewFile(inputPath, Buffer.from("created\n"), undefined, plan);

    assert.equal(await readFile(join(dir1, "child.txt"), "utf8"), "created\n");
    await assert.rejects(() => readFile(join(dir2, "child.txt"), "utf8"), /ENOENT/);
  });
});

test("direct create honors an abort from the final publish hook", async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "target.txt");
    const plan = await planNewFile(target);
    const controller = new AbortController();

    await assert.rejects(
      publishNewFile(target, Buffer.from("created\n"), controller.signal, plan, {
        beforeFilePublish: () => controller.abort(),
      }),
      /Operation aborted before file content was committed/,
    );
    await assert.rejects(readFile(target), /ENOENT/);
  });
});

test("direct create cleanup leaves a swapped-in temporary file untouched", async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "target.txt");
    const victim = join(directory, "victim.txt");
    const plan = await planNewFile(target);
    await writeFile(victim, "KEEP\n");
    let temporary = "";
    let saved = "";

    await assert.rejects(
      publishNewFile(target, Buffer.from("created\n"), undefined, plan, {
        beforeFilePublish: async (paths) => {
          temporary = paths.temporary;
          assert.equal((await stat(dirname(temporary))).mode & 0o077, 0);
          saved = `${temporary}.saved`;
          await rename(temporary, saved);
          await rename(victim, temporary);
        },
      }),
      /Temporary create file changed before commit.*Cleanup was incomplete.*changed identity/s,
    );

    await assert.rejects(readFile(target), /ENOENT/);
    assert.equal(await readFile(temporary, "utf8"), "KEEP\n");
    assert.equal(await readFile(saved, "utf8"), "created\n");
    await unlink(temporary);
    await unlink(saved);
  });
});

test("direct create rejects a replaced parent immediately before publication", async () => {
  await inTemporaryDirectory(async (directory) => {
    const parent = join(directory, "parent");
    const moved = join(directory, "moved");
    const target = join(parent, "target.txt");
    await mkdir(parent);
    const plan = await planNewFile(target);

    await assert.rejects(
      publishNewFile(target, Buffer.from("created\n"), undefined, plan, {
        beforeFilePublish: async ({ temporary }) => {
          const temporaryDirectoryName = basename(dirname(temporary));
          await rename(parent, moved);
          await mkdir(parent);
          await mkdir(dirname(temporary), { mode: 0o700 });
          await rename(join(moved, temporaryDirectoryName, basename(temporary)), temporary);
        },
      }),
      /(?:Create parent changed after planning|Temporary create file changed before commit)/,
    );

    await assert.rejects(readFile(target), /ENOENT/);
    await assert.rejects(readFile(join(moved, "target.txt")), /ENOENT/);
  });
});

test("planned nested create never replaces a directory appearing at final reservation", async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "missing", "child.txt");
    const plan = await planNewFile(target);
    let appearedStats: Awaited<ReturnType<typeof lstat>> | undefined;

    await assert.rejects(
      publishNewFile(target, Buffer.from("created\n"), undefined, plan, {
        beforeRootReserve: async ({ target: publishRoot }) => {
          await mkdir(publishRoot);
          appearedStats = await lstat(publishRoot);
        },
      }),
      /Create parent changed after planning/,
    );

    const current = await lstat(join(directory, "missing"));
    assert.equal(current.ino, appearedStats?.ino);
    assert.deepEqual(await readdir(join(directory, "missing")), []);
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith(".pi-apply-edits-")),
      false,
    );
  });
});

test("planned nested create preserves an entry appearing inside its reserved root", async () => {
  await inTemporaryDirectory(async (directory) => {
    const firstPlan = await planNewFile(join(directory, "shared", "a.txt"));
    const secondPlan = await planNewFile(join(directory, "shared", "b.txt"));
    const prepared = await preparePlannedNestedFiles(
      [
        { plan: firstPlan, bytes: Buffer.from("A\n") },
        { plan: secondPlan, bytes: Buffer.from("B\n") },
      ],
      undefined,
      {
        afterRootReserve: async ({ target: publishRoot }) => {
          await writeFile(join(publishRoot, "b.txt"), "EXTERNAL\n");
        },
      },
    );

    await assert.rejects(
      publishPreparedNestedFiles(prepared),
      /File appeared before create.*Partial create publication retained 1 file.*private staging remains/s,
    );

    assert.equal(await readFile(join(directory, "shared/a.txt"), "utf8"), "A\n");
    assert.equal(await readFile(join(directory, "shared/b.txt"), "utf8"), "EXTERNAL\n");
    assert.equal(await readFile(join(prepared.staging, "a.txt"), "utf8"), "A\n");
    await rm(join(directory, "shared"), { recursive: true });
    await rm(prepared.container, { recursive: true });
  });
});

test("planned nested create rejects staged content tampering", async () => {
  await inTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "missing", "nested", "child.txt");
    const plan = await planNewFile(inputPath);
    let staging = "";

    await assert.rejects(
      publishNewFile(inputPath, Buffer.from("created\n"), undefined, plan, {
        beforeDirectoryCommit: async (paths) => {
          staging = paths.staging;
          await writeFile(join(staging, "nested", "child.txt"), "tampered\n");
        },
      }),
      /Staged create file changed before publish/,
    );
    await assert.rejects(readFile(inputPath, "utf8"), /ENOENT/);
    await rm(staging, { recursive: true });
  });
});

test("planned nested cleanup leaves a swapped-in directory untouched", async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "missing", "child.txt");
    const victim = join(directory, "victim");
    await mkdir(victim);
    await writeFile(join(victim, "important.txt"), "KEEP\n");
    const plan = await planNewFile(target);
    let staging = "";
    let displaced = "";

    await assert.rejects(
      publishNewFile(target, Buffer.from("created\n"), undefined, plan, {
        beforeDirectoryPublish: async (paths) => {
          staging = paths.staging;
          displaced = `${staging}.saved`;
          await rename(staging, displaced);
          await rename(victim, staging);
        },
      }),
      /Staged create entry changed.*Cleanup was incomplete/s,
    );

    assert.equal(await readFile(join(staging, "important.txt"), "utf8"), "KEEP\n");
    assert.equal(await readFile(join(displaced, "child.txt"), "utf8"), "created\n");
    await assert.rejects(readFile(target), /ENOENT/);
    await rm(staging, { recursive: true });
    await rm(displaced, { recursive: true });
  });
});

test("planned nested create revalidates its ancestor at final root reservation", async () => {
  await inTemporaryDirectory(async (directory) => {
    const ancestor = join(directory, "ancestor");
    const moved = join(directory, "moved");
    const target = join(ancestor, "missing", "child.txt");
    await mkdir(ancestor);
    const plan = await planNewFile(target);

    await assert.rejects(
      publishNewFile(target, Buffer.from("created\n"), undefined, plan, {
        beforeRootReserve: async () => {
          await rename(ancestor, moved);
          await mkdir(ancestor);
        },
      }),
      /Create parent changed after planning.*Cleanup was incomplete/s,
    );

    await assert.rejects(readFile(target), /ENOENT/);
    await assert.rejects(readFile(join(moved, "missing", "child.txt")), /ENOENT/);
    await rm(moved, { recursive: true });
  });
});

test("planned nested create preserves inherited setgid directory mode", {
  skip: process.platform === "win32",
}, async () => {
  await inTemporaryDirectory(async (directory) => {
    const parent = join(directory, "setgid-parent");
    const target = join(parent, "missing", "child.txt");
    await mkdir(parent);
    await chmod(parent, 0o2775);
    const plan = await planNewFile(target);

    await publishNewFile(target, Buffer.from("created\n"), undefined, plan);

    assert.equal((await stat(join(parent, "missing"))).mode & 0o2000, 0o2000);
  });
});

test("planned nested create rejects a replaced ancestor immediately before commit", async () => {
  await inTemporaryDirectory(async (directory) => {
    const parent = join(directory, "parent");
    const moved = join(directory, "moved");
    const target = join(parent, "missing", "child.txt");
    await mkdir(parent);
    const plan = await planNewFile(target);

    await assert.rejects(
      publishNewFile(target, Buffer.from("created\n"), undefined, plan, {
        beforeDirectoryCommit: async () => {
          await rename(parent, moved);
          await mkdir(parent);
        },
      }),
      /Create parent changed after planning/,
    );

    await assert.rejects(readFile(target), /ENOENT/);
    await assert.rejects(readFile(join(moved, "missing", "child.txt")), /ENOENT/);
  });
});

test("planned nested create honors an abort from the final commit hook", async () => {
  await inTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "missing", "child.txt");
    const plan = await planNewFile(inputPath);
    const controller = new AbortController();

    await assert.rejects(
      publishNewFile(inputPath, Buffer.from("created\n"), controller.signal, plan, {
        beforeDirectoryCommit: () => controller.abort(),
      }),
      /Operation aborted before file content was committed/,
    );
    await assert.rejects(readFile(inputPath), /ENOENT/);
  });
});

test("nested discard is idempotent and later prepared groups can still be cleaned", async () => {
  await inTemporaryDirectory(async (directory) => {
    const firstPlan = await planNewFile(join(directory, "first", "child.txt"));
    const secondPlan = await planNewFile(join(directory, "second", "child.txt"));
    const controller = new AbortController();
    const first = await preparePlannedNestedFiles(
      [{ plan: firstPlan, bytes: Buffer.from("first\n") }],
      undefined,
      { beforeDirectoryCommit: () => controller.abort() },
    );
    const second = await preparePlannedNestedFiles([
      { plan: secondPlan, bytes: Buffer.from("second\n") },
    ]);

    await assert.rejects(
      publishPreparedNestedFiles(first, controller.signal),
      /Operation aborted before file content was committed/,
    );
    await discardPreparedNestedFiles(first);
    await discardPreparedNestedFiles(second);

    await assert.rejects(lstat(first.container), /ENOENT/);
    await assert.rejects(lstat(second.container), /ENOENT/);
  });
});

test("planned nested create rejects staged symbolic links", async () => {
  await inTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "missing", "nested", "child.txt");
    const outside = join(directory, "outside.txt");
    await writeFile(outside, "outside\n");
    const plan = await planNewFile(inputPath);
    let staging = "";

    await assert.rejects(
      publishNewFile(inputPath, Buffer.from("created\n"), undefined, plan, {
        beforeDirectoryPublish: async (paths) => {
          staging = paths.staging;
          const staged = join(staging, "nested", "child.txt");
          await unlink(staged);
          await symlink(outside, staged);
        },
      }),
      /(?:contains a symbolic link|Staged create entry changed)/,
    );
    assert.equal(await readFile(outside, "utf8"), "outside\n");
    await assert.rejects(readFile(inputPath, "utf8"), /ENOENT/);
    await rm(staging, { recursive: true });
  });
});

test("planned nested create never follows a parent symlink appearing after validation", async () => {
  await inTemporaryDirectory(async (directory) => {
    const outside = join(directory, "outside");
    const gate = join(directory, "gate");
    const inputPath = join(gate, "sub", "child.txt");
    await mkdir(outside);
    const plan = await planNewFile(inputPath);

    await assert.rejects(
      () =>
        publishNewFile(inputPath, Buffer.from("created\n"), undefined, plan, {
          beforeDirectoryPublish: async () => symlink(outside, gate),
        }),
      /Create parent changed after planning/,
    );

    await assert.rejects(() => readFile(join(outside, "sub", "child.txt"), "utf8"), /ENOENT/);
    assert.equal((await lstat(gate)).isSymbolicLink(), true);
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith(".pi-apply-edits-")),
      false,
    );
  });
});

test("ancestor replacement leaves displaced private staging for inspection", async () => {
  await inTemporaryDirectory(async (directory) => {
    const ancestor = join(directory, "ancestor");
    const movedAncestor = join(directory, "moved-ancestor");
    const inputPath = join(ancestor, "missing", "child.txt");
    await mkdir(ancestor);
    const plan = await planNewFile(inputPath);
    let staging = "";

    await assert.rejects(
      () => publishNewFile(inputPath, Buffer.from("created\n"), undefined, plan, {
        beforeDirectoryPublish: async (paths) => {
          staging = paths.staging;
          await rename(ancestor, movedAncestor);
          await mkdir(ancestor);
        },
      }),
      /Create parent changed after planning.*Cleanup was incomplete/s,
    );

    const movedContainer = join(movedAncestor, basename(dirname(staging)));
    const movedStaging = join(movedContainer, basename(staging));
    assert.equal(await readFile(join(movedStaging, "child.txt"), "utf8"), "created\n");
    await assert.rejects(readFile(inputPath), /ENOENT/);
    await rm(movedContainer, { recursive: true });
  });
});

test("concurrent single creates through symlink-parent aliases serialize", async () => {
  await inTemporaryDirectory(async (directory) => {
    const real = join(directory, "real");
    const alias = join(directory, "alias");
    await mkdir(real);
    await symlink(real, alias);

    const results = await Promise.all([
      applyEditsToFile(
        { path: join(real, "child.txt"), rewrite: "first\n", onMissing: "create" },
        directory,
      ),
      applyEditsToFile(
        { path: join(alias, "child.txt"), rewrite: "second\n", onMissing: "create" },
        directory,
      ),
    ]);
    assert.equal(results.length, 2);
    assert.equal(await readFile(join(real, "child.txt"), "utf8"), "second\n");
  });
});

test("long valid basenames do not overflow temporary names", async () => {
  await inTemporaryDirectory(async (directory) => {
    const existing = "x".repeat(240);
    const created = "y".repeat(240);
    await writeFile(join(directory, existing), "before\n");

    await applyEditsToFile({ path: existing, rewrite: "after\n" }, directory);
    await applyEditsToFile({ path: created, rewrite: "created\n", onMissing: "create" }, directory);

    assert.equal(await readFile(join(directory, existing), "utf8"), "after\n");
    assert.equal(await readFile(join(directory, created), "utf8"), "created\n");
  });
});

test("multi-file batch rejects unwritable target directories during plan", async () => {
  if (process.platform === "win32") return;
  await inTemporaryDirectory(async (directory) => {
    const first = join(directory, "first.txt");
    const lockedDir = join(directory, "locked");
    const second = join(lockedDir, "second.txt");
    await writeFile(first, "old\n");
    await mkdir(lockedDir);
    await writeFile(second, "second\n");
    await chmod(lockedDir, 0o555);

    try {
      await assert.rejects(
        () =>
          applyEditsToFile(
            {
              files: [
                { path: "first.txt", rewrite: "new\n" },
                { path: "locked/second.txt", edits: [{ oldText: "second", newText: "changed" }] },
              ],
            },
            directory,
          ),
        /Directory must be writable/,
      );
      assert.equal(await readFile(first, "utf8"), "old\n");
      assert.equal(await readFile(second, "utf8"), "second\n");
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });
});

test(
  "create rejects a target entry swapped for a symbolic link after linking",
  { skip: process.platform === "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const input = join(directory, "target.txt");
      const saved = join(directory, "saved.txt");
      const originalLstat = nodeFs.promises.lstat;
      let target = "";
      let armed = false;

      await withRacingFileSystem(
        (promises) => {
          promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
            if (armed && String(path) === target) {
              armed = false;
              await rename(target, saved);
              await symlink(saved, target);
            }
            return (originalLstat as Function).call(this, path, ...args);
          }) as typeof promises.lstat;
        },
        async (module) => {
          const plan = await module.planNewFile(input);
          target = plan.targetPath;
          await assert.rejects(
            () =>
              module.publishNewFile(input, Buffer.from("created\n"), undefined, plan, {
                beforeFilePublish() {
                  armed = true;
                },
              }),
            /changed during publication/,
          );
        },
      );

      assert.equal((await lstat(input)).isSymbolicLink(), true);
      assert.equal(await readFile(saved, "utf8"), "created\n");
    });
  },
);

test(
  "create reports an uncertain commit when the parent moves after exclusive open",
  { skip: process.platform === "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const parent = join(directory, "parent");
      await mkdir(parent);
      const input = join(parent, "target.txt");
      const moved = join(directory, "moved");
      const originalStat = nodeFs.promises.stat;
      let ancestor = "";
      let armed = false;
      let checks = 0;

      await withRacingFileSystem(
        (promises) => {
          promises.link = async () => {
            throw Object.assign(new Error("forced"), { code: "EPERM" });
          };
          promises.stat = (async function (this: unknown, path: string, ...args: unknown[]) {
            if (armed && String(path) === ancestor && ++checks === 3) {
              await rename(ancestor, moved);
              await mkdir(ancestor);
            }
            return (originalStat as Function).call(this, path, ...args);
          }) as typeof promises.stat;
        },
        async (module) => {
          const plan = await module.planNewFile(input);
          ancestor = plan.ancestorPath;
          await assert.rejects(
            () =>
              module.publishNewFile(input, Buffer.from("created\n"), undefined, plan, {
                beforeFilePublish() {
                  armed = true;
                },
              }),
            /Commit status is uncertain/,
          );
        },
      );

      assert.equal((await readFile(join(moved, "target.txt"))).length, 0);
    });
  },
);

test(
  "replacement rejects a parent alias swapped during target validation",
  { skip: process.platform === "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const original = join(directory, "original");
      const other = join(directory, "other");
      const alias = join(directory, "alias");
      await mkdir(original);
      await mkdir(other);
      await writeFile(join(original, "file.txt"), "before\n");
      await writeFile(join(other, "file.txt"), "outside\n");
      await symlink(original, alias);

      const originalOpen = nodeFs.promises.open;
      let actual = "";
      let armed = false;

      await withRacingFileSystem(
        (promises) => {
          promises.open = (async function (this: unknown, path: string, ...args: unknown[]) {
            if (armed && String(path) === actual) {
              armed = false;
              await unlink(alias);
              await symlink(other, alias);
            }
            return (originalOpen as Function).call(this, path, ...args);
          }) as typeof promises.open;
        },
        async (module) => {
          const snapshot = await module.captureSnapshot(join(alias, "file.txt"));
          assert.ok(snapshot);
          actual = snapshot.actualPath;
          await assert.rejects(
            () =>
              module.publishReplacement(snapshot, Buffer.from("after\n"), undefined, {
                beforeRename() {
                  armed = true;
                },
              }),
            /File path changed before commit/,
          );
        },
      );

      assert.equal(await readFile(join(original, "file.txt"), "utf8"), "before\n");
      assert.equal(await readFile(join(other, "file.txt"), "utf8"), "outside\n");
    });
  },
);

test(
  "nested create cleanup never follows a swapped directory entry to an unrelated path",
  { skip: process.platform === "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "victim"));
      const victim = await realpath(join(directory, "victim"));
      const input = join(directory, "missing", "sub", "child.txt");
      const originalMkdir = nodeFs.promises.mkdir;
      const originalLstat = nodeFs.promises.lstat;
      let publishRoot = "";
      let subdirectory = "";
      let phase = "idle";

      await withRacingFileSystem(
        (promises) => {
          promises.mkdir = (async function (this: unknown, path: string, ...args: unknown[]) {
            const result = await (originalMkdir as Function).call(this, path, ...args);
            if (phase === "armed" && String(path) === subdirectory) {
              // Replace the just-claimed entry with a link to an unrelated directory.
              await rename(subdirectory, `${subdirectory}.saved`);
              await symlink(victim, subdirectory);
              phase = "move-root";
            }
            return result;
          }) as typeof promises.mkdir;
          promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
            // Then invalidate the reserved root, so the revalidation guarding it fails and
            // the cleanup branch for the new directory runs.
            if (phase === "move-root" && String(path) === publishRoot) {
              phase = "done";
              await rename(publishRoot, `${publishRoot}.moved`);
              await mkdir(publishRoot);
            }
            return (originalLstat as Function).call(this, path, ...args);
          }) as typeof promises.lstat;
        },
        async (module) => {
          const plan = await module.planNewFile(input);
          await assert.rejects(
            () =>
              module.publishNewFile(input, Buffer.from("created\n"), undefined, plan, {
                afterRootReserve({ target }) {
                  publishRoot = target;
                  subdirectory = join(target, "sub");
                  phase = "armed";
                },
              }),
            /changed identity/,
          );
        },
      );

      // Following the swapped entry would have published into the unrelated directory, or
      // deleted it during cleanup.
      assert.equal((await lstat(victim)).isDirectory(), true);
      assert.deepEqual(await readdir(victim), []);
    });
  },
);

test(
  "create reports an uncertain commit when the parent moves right after linking",
  { skip: process.platform === "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const parent = join(directory, "parent");
      await mkdir(parent);
      const input = join(parent, "target.txt");
      const moved = join(directory, "moved");
      const originalLink = nodeFs.promises.link;
      let target = "";
      let armed = false;

      await withRacingFileSystem(
        (promises) => {
          promises.link = (async function (this: unknown, from: string, to: string, ...args: unknown[]) {
            const result = await (originalLink as Function).call(this, from, to, ...args);
            if (armed && String(to) === target) {
              armed = false;
              await rename(parent, moved);
            }
            return result;
          }) as typeof promises.link;
        },
        async (module) => {
          const plan = await module.planNewFile(input);
          target = plan.targetPath;
          await assert.rejects(
            () =>
              module.publishNewFile(input, Buffer.from("created\n"), undefined, plan, {
                beforeFilePublish() {
                  armed = true;
                },
              }),
            /Commit status is uncertain; nothing was rolled back/,
          );
        },
      );

      // Both hard links survive under the moved parent, and they are the same inode.
      assert.equal(await readFile(join(moved, "target.txt"), "utf8"), "created\n");
      const survivors = (await readdir(moved, { recursive: true, withFileTypes: true })).filter(
        (entry) => entry.isFile(),
      );
      assert.equal(survivors.length, 2);
      const inodes = new Set<string>();
      for (const entry of survivors) {
        inodes.add(String((await stat(join(entry.parentPath, entry.name), { bigint: true })).ino));
      }
      assert.equal(inodes.size, 1);
    });
  },
);

// Mixed case is covered because the Pi key for a create is the exact-case path. A folded key
// would name a different queue than the realpath-derived key an edit takes after publication.
for (const relative of ["missing/target.txt", "Missing/Target.txt"]) {
  test(
    `a rewrite of ${relative} while it is being created waits for the create to finish`,
    { skip: process.platform === "win32" },
    async () => {
      await inTemporaryDirectory(async (directory) => {
        const originalRm = nodeFs.promises.rm;
        let heldOnce = false;
        let signalLinked = () => {};
        const linked = new Promise<void>((resolve) => {
          signalLinked = resolve;
        });
        let releaseTemporary = () => {};
        const held = new Promise<void>((resolve) => {
          releaseTemporary = resolve;
        });

        await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
          (promises) => {
            promises.rm = (async function (this: unknown, path: string, ...args: unknown[]) {
              // Hold the staged copy so the published target stays at two links, widening the
              // window in which a concurrent rewrite could observe a transient hard link.
              if (!heldOnce && String(path).includes(".tmpdir")) {
                heldOnce = true;
                signalLinked();
                await held;
              }
              return (originalRm as Function).call(this, path, ...args);
            }) as typeof promises.rm;
          },
          async (module) => {
            const create = module.applyEditsToFile(
              { path: relative, rewrite: "created\n", onMissing: "create" },
              directory,
            );
            await linked;
            let rewriteSettled = false;
            const settle = <T,>(value: T) => {
              rewriteSettled = true;
              return value;
            };
            const rewrite = module
              .applyEditsToFile({ path: relative, rewrite: "rewritten\n" }, directory)
              .then(settle, (error: unknown) => {
                settle(undefined);
                throw error;
              });
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(rewriteSettled, false, "the rewrite must wait for the create lock");
            releaseTemporary();
            await create;
            await rewrite;
          },
          "../src/apply-edits.ts",
        );

        assert.equal(await readFile(join(directory, relative), "utf8"), "rewritten\n");
      });
    },
  );
}

test(
  "a rewrite that resolves a path before it is created still completes",
  { skip: process.platform === "win32" },
  async () => {
    // Pi canonicalizes each lock key with realpath when the lock is taken, so a create must
    // never hold two keys that name the same file once it exists. This is the window that
    // would expose it: the rewrite resolves its key while the target is still missing.
    await inTemporaryDirectory(async (directory) => {
      const originalLink = nodeFs.promises.link;
      let signalBeforeLink = () => {};
      const beforeLink = new Promise<void>((resolve) => {
        signalBeforeLink = resolve;
      });
      let releaseLink = () => {};
      const released = new Promise<void>((resolve) => {
        releaseLink = resolve;
      });
      let holding = false;

      await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
        (promises) => {
          promises.link = (async function (this: unknown, from: string, to: string, ...args: unknown[]) {
            if (!holding && String(to).endsWith("Target.txt")) {
              holding = true;
              signalBeforeLink();
              await released;
            }
            return (originalLink as Function).call(this, from, to, ...args);
          }) as typeof promises.link;
        },
        async (module) => {
          const create = module.applyEditsToFile(
            { path: "Target.txt", rewrite: "created\n", onMissing: "create" },
            directory,
          );
          await beforeLink;
          const rewrite = module.applyEditsToFile(
            { path: "Target.txt", rewrite: "rewritten\n" },
            directory,
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          releaseLink();
          await create;

          const outcome = await Promise.race([
            rewrite.then(
              () => "settled",
              (error: unknown) => `rejected: ${String(error)}`,
            ),
            new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
          ]);
          assert.equal(outcome, "settled");
          assert.equal(await readFile(join(directory, "Target.txt"), "utf8"), "rewritten\n");
        },
        "../src/apply-edits.ts",
      );
    });
  },
);

test(
  "an unverifiable create claims nothing about what remains on disk",
  { skip: process.platform === "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const input = join(directory, "target.txt");
      const originalLink = nodeFs.promises.link;

      await withRacingFileSystem(
        (promises) => {
          promises.link = (async function (this: unknown, from: string, to: string, ...args: unknown[]) {
            const result = await (originalLink as Function).call(this, from, to, ...args);
            // Remove the freshly published name, so only the temporary link survives.
            if (String(to).endsWith("target.txt")) await unlink(to);
            return result;
          }) as typeof promises.link;
        },
        async (module) => {
          const plan = await module.planNewFile(input);
          let caught: unknown;
          try {
            await module.publishNewFile(input, Buffer.from("created\n"), undefined, plan);
          } catch (error) {
            caught = error;
          }
          // Assert outside assert.rejects, which would accept a failing assertion as a
          // rejection and pass regardless of the message.
          assert.ok(caught, "expected the create to report a failure");
          assert.match(String(caught), /Commit status is uncertain; nothing was rolled back/);
          assert.doesNotMatch(String(caught), /two hard links|were retained/);
        },
      );
    });
  },
);

test("concurrent creates under one missing root serialize instead of racing the claim", async () => {
  await inTemporaryDirectory(async (directory) => {
    // Both creates must claim the same missing root. Without a lock that survives the root
    // coming into existence, one wins the exclusive mkdir and the other fails closed.
    await Promise.all([
      applyEditsToFile({ path: "shared/a.txt", rewrite: "A\n", onMissing: "create" }, directory),
      applyEditsToFile({ path: "shared/b.txt", rewrite: "B\n", onMissing: "create" }, directory),
    ]);
    assert.equal(await readFile(join(directory, "shared/a.txt"), "utf8"), "A\n");
    assert.equal(await readFile(join(directory, "shared/b.txt"), "utf8"), "B\n");
  });
});

test("concurrent creates three deep under one missing root all publish", async () => {
  await inTemporaryDirectory(async (directory) => {
    await Promise.all([
      applyEditsToFile({ path: "r/x/a.txt", rewrite: "A\n", onMissing: "create" }, directory),
      applyEditsToFile({ path: "r/y/b.txt", rewrite: "B\n", onMissing: "create" }, directory),
      applyEditsToFile({ path: "r/z/c.txt", rewrite: "C\n", onMissing: "create" }, directory),
    ]);
    assert.equal(await readFile(join(directory, "r/x/a.txt"), "utf8"), "A\n");
    assert.equal(await readFile(join(directory, "r/y/b.txt"), "utf8"), "B\n");
    assert.equal(await readFile(join(directory, "r/z/c.txt"), "utf8"), "C\n");
  });
});

test(
  "concurrent creates of one path spelled two ways do not both claim it",
  { skip: process.platform !== "darwin" && process.platform !== "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      // Two spellings of one file on a case-insensitive volume. Serialized, the second plans
      // after the first published and becomes a rewrite. Unserialized, both plan against a
      // missing path and one fails closed on the exclusive claim.
      const outcomes = await Promise.allSettled([
        applyEditsToFile({ path: "case/Target.txt", rewrite: "A\n", onMissing: "create" }, directory),
        applyEditsToFile({ path: "case/target.txt", rewrite: "B\n", onMissing: "create" }, directory),
      ]);
      assert.deepEqual(
        outcomes.map((outcome) => outcome.status),
        ["fulfilled", "fulfilled"],
      );
      const entries = await readdir(join(directory, "case"));
      assert.equal(entries.length, 1);
      assert.match(await readFile(join(directory, "case", entries[0]!), "utf8"), /^[AB]\n$/);
    });
  },
);

test(
  "a newly claimed directory owned by another user is never adopted for publication or cleanup",
  { skip: process.platform === "win32" || typeof process.geteuid !== "function" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const input = join(directory, "missing", "sub", "child.txt");
      const originalLstat = nodeFs.promises.lstat;
      let publishRoot = "";
      let armed = false;

      await withRacingFileSystem(
        (promises) => {
          promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
            const stats = await (originalLstat as Function).call(this, path, ...args);
            if (!armed || String(path) !== publishRoot) return stats;
            armed = false;
            // Stand in for a cross-user rename swap in the mkdir-to-lstat gap. Only uid is
            // changed: the name and inode still look internally consistent, so main adopts
            // the entry, publishes into it, and records it for cleanup.
            return new Proxy(stats, {
              get(target, property, receiver) {
                if (property === "uid") return target.uid + 1n;
                return Reflect.get(target, property, receiver);
              },
            });
          }) as typeof promises.lstat;
        },
        async (module) => {
          const plan = await module.planNewFile(input);
          await assert.rejects(
            () =>
              module.publishNewFile(input, Buffer.from("created\n"), undefined, plan, {
                beforeRootReserve({ target }) {
                  publishRoot = target;
                  armed = true;
                },
              }),
            /owner changed.*left untouched/,
          );
        },
      );

      assert.equal((await lstat(publishRoot)).isDirectory(), true);
      assert.deepEqual(await readdir(publishRoot), []);
    });
  },
);

test("a batch rejects a dangling alias before its lock can collapse onto the target", async () => {
  await inTemporaryDirectory(async (directory) => {
    const alias = join(directory, "a");
    const target = join(directory, "b");
    await symlink("b", alias);
    const canonicalDirectory = await realpath(directory);
    const queueAlias = join(canonicalDirectory, "a");
    const originalRealpath = nodeFs.promises.realpath;
    let aliasFailed = false;
    let targetFailed = false;
    let injected = false;

    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.realpath = (async function (this: unknown, path: string, ...args: unknown[]) {
          const value = String(path);
          // Both entries must first be classified as distinct missing targets. When Pi later
          // resolves the first queue key, make the dangling alias resolve onto the second.
          // Main then acquires that queue twice and waits on itself.
          if (!injected && aliasFailed && targetFailed && value === queueAlias) {
            await writeFile(target, "external\n");
            injected = true;
          }
          try {
            return await (originalRealpath as Function).call(this, path, ...args);
          } catch (error) {
            if (value === alias || value === queueAlias) aliasFailed = true;
            if (value === target || value === join(canonicalDirectory, "b")) targetFailed = true;
            throw error;
          }
        }) as typeof promises.realpath;
      },
      async (module) => {
        const operation = module.applyEditsToFile(
          {
            files: [
              { path: "a", rewrite: "one\n" },
              { path: "b", rewrite: "two\n" },
            ],
          },
          directory,
        );
        const outcome = await Promise.race([
          operation.then(
            () => "settled",
            (error: unknown) => `rejected: ${String(error)}`,
          ),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
        ]);
        assert.match(String(outcome), /^rejected: .*Cannot mutate dangling symbolic link/);
        assert.equal(injected, false, "the operation must reject before Pi acquires a queue key");
      },
      "../src/apply-edits.ts",
    );

    await assert.rejects(lstat(target), /ENOENT/);
  });
});

test("insert results state that no separator was inferred", async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "imports.ts");
    await writeFile(target, 'import fs from "node:fs";\n');
    const result = await applyEditsToFile(
      {
        path: target,
        edits: [
          {
            oldText: 'import fs from "node:fs";',
            newText: '\nimport path from "node:path";',
            insert: "after",
          },
        ],
      },
      directory,
    );
    assert.match(result.summary, /Warning: 1 insert spliced exactly with zero separator/);
    assert.match(result.summary, /all newlines and spaces came from newText/);
    assert.equal(
      await readFile(target, "utf8"),
      'import fs from "node:fs";\nimport path from "node:path";\n',
    );
  });
});

test("a batch rejects a dangling ancestor before its lock can collapse onto the target", async () => {
  await inTemporaryDirectory(async (directory) => {
    const aliasParent = join(directory, "a");
    const targetParent = join(directory, "b");
    const alias = join(aliasParent, "child.txt");
    const target = join(targetParent, "child.txt");
    await symlink("b", aliasParent);
    const canonicalDirectory = await realpath(directory);
    const queueAlias = join(canonicalDirectory, "a", "child.txt");
    const originalRealpath = nodeFs.promises.realpath;
    let aliasFailed = false;
    let targetFailed = false;
    let injected = false;

    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.realpath = (async function (this: unknown, path: string, ...args: unknown[]) {
          const value = String(path);
          if (!injected && aliasFailed && targetFailed && value === queueAlias) {
            await mkdir(targetParent);
            await writeFile(target, "external\n");
            injected = true;
          }
          try {
            return await (originalRealpath as Function).call(this, path, ...args);
          } catch (error) {
            if (value === alias || value === queueAlias) aliasFailed = true;
            if (value === target || value === join(canonicalDirectory, "b", "child.txt")) {
              targetFailed = true;
            }
            throw error;
          }
        }) as typeof promises.realpath;
      },
      async (module) => {
        const operation = module.applyEditsToFile(
          {
            files: [
              { path: "a/child.txt", rewrite: "one\n" },
              { path: "b/child.txt", rewrite: "two\n" },
            ],
          },
          directory,
        );
        const outcome = await Promise.race([
          operation.then(
            () => "settled",
            (error: unknown) => `rejected: ${String(error)}`,
          ),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
        ]);
        assert.match(String(outcome), /^rejected: .*Cannot mutate dangling symbolic link/);
        assert.equal(injected, false, "the operation must reject before Pi acquires a queue key");
      },
      "../src/apply-edits.ts",
    );

    await assert.rejects(lstat(targetParent), /ENOENT/);
  });
});

test("local create locks stay stable as missing ancestors are published", async () => {
  await inTemporaryDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const root = join(canonicalDirectory, "r");
    const shiftedRoot = join(root, "y");
    await writeFile(join(directory, "sentinel.txt"), "old\n");
    const originalMkdir = nodeFs.promises.mkdir;
    const rootReached = deferred();
    const releaseRoot = deferred();
    const shiftedReached = deferred();
    const releaseShifted = deferred();
    let heldRoot = false;
    let heldShifted = false;

    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.mkdir = (async function (this: unknown, path: string, ...args: unknown[]) {
          const value = String(path);
          if (value === root && !heldRoot) {
            heldRoot = true;
            rootReached.resolve();
            await releaseRoot.promise;
          } else if (value === shiftedRoot && !heldShifted) {
            heldShifted = true;
            shiftedReached.resolve();
            await releaseShifted.promise;
          }
          return (originalMkdir as Function).call(this, path, ...args);
        }) as typeof promises.mkdir;
      },
      async (module) => {
        let first: Promise<unknown> | undefined;
        let batch: Promise<unknown> | undefined;
        let later: Promise<unknown> | undefined;
        try {
          first = module.applyEditsToFile(
            { path: "r/x/a.txt", rewrite: "A\n", onMissing: "create" },
            directory,
          );
          await withTimeout(rootReached.promise, "first create reaching r");

          batch = module.applyEditsToFile(
            {
              files: [
                { path: "sentinel.txt", rewrite: "new\n" },
                { path: "r/y/b.txt", rewrite: "B\n", onMissing: "create" },
              ],
            },
            directory,
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
          releaseRoot.resolve();
          await withTimeout(first, "first create finishing");
          await withTimeout(shiftedReached.promise, "batch reaching r/y");

          let laterSettled = false;
          later = module
            .applyEditsToFile(
              { path: "r/y/c.txt", rewrite: "C\n", onMissing: "create" },
              directory,
            )
            .finally(() => {
              laterSettled = true;
            });
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(laterSettled, false, "the later create bypassed the batch's stale root lock");
          releaseShifted.resolve();
          await withTimeout(batch, "batch finishing");
          await withTimeout(later, "later create finishing");
        } finally {
          releaseRoot.resolve();
          releaseShifted.resolve();
          await Promise.allSettled([first, batch, later].filter((item) => item !== undefined));
        }
      },
      "../src/apply-edits.ts",
    );

    assert.equal(await readFile(join(directory, "sentinel.txt"), "utf8"), "new\n");
    assert.equal(await readFile(join(root, "y/b.txt"), "utf8"), "B\n");
    assert.equal(await readFile(join(root, "y/c.txt"), "utf8"), "C\n");
  });
});

test(
  "whole-path folding dedupes a batch when an ancestor appears with different case",
  { skip: process.platform !== "darwin" && process.platform !== "win32" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const canonicalDirectory = await realpath(directory);
      const root = join(canonicalDirectory, "R");
      const upperTarget = join(root, "b.txt");
      const originalMkdir = nodeFs.promises.mkdir;
      const originalRealpath = nodeFs.promises.realpath;
      const originalLink = nodeFs.promises.link;
      const rootReached = deferred();
      const releaseRoot = deferred();
      const releaseUpperDiscovery = deferred();
      const targetLinkReached = deferred();
      const releaseTargetLink = deferred();
      let heldRoot = false;
      let heldUpperDiscovery = false;
      let heldTargetLink = false;

      await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
        (promises) => {
          promises.mkdir = (async function (this: unknown, path: string, ...args: unknown[]) {
            if (String(path) === root && !heldRoot) {
              heldRoot = true;
              rootReached.resolve();
              await releaseRoot.promise;
            }
            return (originalMkdir as Function).call(this, path, ...args);
          }) as typeof promises.mkdir;
          promises.realpath = (async function (this: unknown, path: string, ...args: unknown[]) {
            if (String(path) === upperTarget && !heldUpperDiscovery) {
              heldUpperDiscovery = true;
              await releaseUpperDiscovery.promise;
            }
            return (originalRealpath as Function).call(this, path, ...args);
          }) as typeof promises.realpath;
          promises.link = (async function (this: unknown, from: string, to: string, ...args: unknown[]) {
            if (String(to) === upperTarget && !heldTargetLink) {
              heldTargetLink = true;
              targetLinkReached.resolve();
              await releaseTargetLink.promise;
            }
            return (originalLink as Function).call(this, from, to, ...args);
          }) as typeof promises.link;
        },
        async (module) => {
          let rootCreate: Promise<unknown> | undefined;
          let batchOutcome: Promise<string> | undefined;
          let targetCreate: Promise<unknown> | undefined;
          try {
            rootCreate = module.applyEditsToFile(
              { path: "R/x/a.txt", rewrite: "A\n", onMissing: "create" },
              canonicalDirectory,
            );
            await withTimeout(rootReached.promise, "root reservation");

            // Lowercase discovery completes while R is absent. Uppercase discovery waits
            // until R exists and realpath returns that spelling. Suffix-only folding assigned
            // different target keys; whole-path folding rejects them as the same file.
            batchOutcome = module
              .applyEditsToFile(
                {
                  files: [
                    { path: "r/b.txt", rewrite: "one\n", onMissing: "create" },
                    { path: "R/b.txt", rewrite: "two\n", onMissing: "create" },
                  ],
                },
                canonicalDirectory,
              )
              .then(
                () => "fulfilled",
                (error: unknown) => `rejected: ${String(error)}`,
              );
            await new Promise((resolve) => setTimeout(resolve, 50));
            releaseRoot.resolve();
            await withTimeout(rootCreate, "root create finishing");

            targetCreate = module.applyEditsToFile(
              { path: "R/b.txt", rewrite: "outside\n", onMissing: "create" },
              canonicalDirectory,
            );
            await withTimeout(targetLinkReached.promise, "target create reaching link");
            releaseUpperDiscovery.resolve();
            const outcome = await withTimeout(batchOutcome, "batch duplicate rejection", 1000);
            assert.match(outcome, /^rejected: .*refers to the same file/);
            releaseTargetLink.resolve();
            await withTimeout(targetCreate, "target create finishing");
          } finally {
            releaseRoot.resolve();
            releaseUpperDiscovery.resolve();
            releaseTargetLink.resolve();
            // Do not await batchOutcome here: on the control tree it is the intentionally
            // deadlocked promise this regression must detect. Its queue keys are temp-scoped.
            await Promise.allSettled(
              [rootCreate, targetCreate].filter((item) => item !== undefined),
            );
          }
        },
        "../src/apply-edits.ts",
      );
    });
  },
);

test("batch dedupe stays stable when a missing target appears between discoveries", async () => {
  await inTemporaryDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const root = join(canonicalDirectory, "R");
    const target = join(root, "B.txt");
    await mkdir(root);
    const originalRealpath = nodeFs.promises.realpath;
    const secondDiscoveryReached = deferred();
    const releaseSecondDiscovery = deferred();
    let targetCalls = 0;

    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.realpath = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (String(path) === target && ++targetCalls === 2) {
            secondDiscoveryReached.resolve();
            await releaseSecondDiscovery.promise;
          }
          return (originalRealpath as Function).call(this, path, ...args);
        }) as typeof promises.realpath;
      },
      async (module) => {
        let batch: Promise<string> | undefined;
        try {
          batch = module
            .applyEditsToFile(
              {
                files: [
                  { path: "R/B.txt", rewrite: "one\n", onMissing: "create" },
                  { path: "R/B.txt", rewrite: "two\n", onMissing: "create" },
                ],
              },
              canonicalDirectory,
            )
            .then(
              () => "fulfilled",
              (error: unknown) => `rejected: ${String(error)}`,
            );
          await withTimeout(secondDiscoveryReached.promise, "second target discovery");
          await module.applyEditsToFile(
            { path: "R/B.txt", rewrite: "outside\n", onMissing: "create" },
            canonicalDirectory,
          );
          releaseSecondDiscovery.resolve();
          const outcome = await withTimeout(batch, "batch duplicate rejection");
          assert.match(outcome, /^rejected: .*refers to the same file/);
        } finally {
          releaseSecondDiscovery.resolve();
        }
      },
      "../src/apply-edits.ts",
    );

    assert.equal(await readFile(target, "utf8"), "outside\n");
  });
});

test(
  "whole-path folding keeps APFS-distinct i and dotless-i paths separate",
  { skip: process.platform !== "darwin" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "i"));
      await mkdir(join(directory, "ı"));
      assert.deepEqual(new Set(await readdir(directory)), new Set(["i", "ı"]));
      await applyEditsToFile(
        {
          files: [
            { path: "i/new", rewrite: "one\n", onMissing: "create" },
            { path: "ı/new/child", rewrite: "two\n", onMissing: "create" },
          ],
        },
        directory,
      );
      assert.equal(await readFile(join(directory, "i/new"), "utf8"), "one\n");
      assert.equal(await readFile(join(directory, "ı/new/child"), "utf8"), "two\n");
    });
  },
);

test("an already-aborted batch does no filesystem key discovery", async () => {
  let filesystemCalls = 0;
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
    (promises) => {
      promises.realpath = (async () => {
        filesystemCalls++;
        throw missing();
      }) as typeof promises.realpath;
      promises.lstat = (async () => {
        filesystemCalls++;
        throw missing();
      }) as typeof promises.lstat;
    },
    async (module) => {
      const files = Array.from({ length: 64 }, (_, file) => ({
        path: [`u${file}`, ...Array(256).fill("x"), "f"].join("/"),
        rewrite: "x",
        onMissing: "create" as const,
      }));
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        module.applyEditsToFile({ files }, "/e", controller.signal),
        /Operation aborted/,
      );
    },
    "../src/apply-edits.ts",
  );
  assert.equal(filesystemCalls, 0);
});

test(
  "near-limit replacement is rejected during planning before staging",
  { skip: process.platform !== "darwin" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const canonicalDirectory = await realpath(directory);
      let relative = "";
      while (Buffer.byteLength(join(canonicalDirectory, relative, "f")) < 900) {
        relative = relative ? `${relative}/x` : "x";
      }
      relative += "/f";

      const result = await applyEditsToFile(
        { path: relative, rewrite: "ok\n", onMissing: "create" },
        canonicalDirectory,
      );
      const warnings = "warnings" in result.details ? result.details.warnings : [];
      assert.doesNotMatch(warnings.join("\n"), /cleanup was incomplete/);
      assert.equal((await stat(join(canonicalDirectory, relative))).nlink, 1);

      await assert.rejects(
        applyEditsToFile(
          { path: relative, rewrite: "next\n" },
          canonicalDirectory,
        ),
        /planned staging and cleanup.*supported 991 bytes.*PATH_MAX 1024.*No changes were written/s,
      );
      assert.equal(await readFile(join(canonicalDirectory, relative), "utf8"), "ok\n");
      assert.deepEqual(
        (await readdir(canonicalDirectory)).filter((name) => name.startsWith(".pi-apply-edits-")),
        [],
      );
    });
  },
);

test(
  "batch rejects a near-limit create before an earlier planned write",
  { skip: process.platform !== "darwin" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const canonicalDirectory = await realpath(directory);
      let ancestor = canonicalDirectory;
      let remaining = 953 - Buffer.byteLength(ancestor);
      if (remaining % 2 === 1) {
        ancestor = join(ancestor, "xx");
        remaining -= 3;
      }
      while (remaining > 256) {
        ancestor = join(ancestor, "x");
        remaining -= 2;
      }
      ancestor = join(ancestor, "x".repeat(remaining - 1));
      assert.equal(Buffer.byteLength(ancestor), 953);
      await mkdir(ancestor, { recursive: true });

      const ordinary = join(canonicalDirectory, "ordinary");
      const deepTarget = join(ancestor, "a", "f");
      await writeFile(ordinary, "old\n");
      await assert.rejects(
        applyEditsToFile(
          {
            files: [
              { path: ordinary, rewrite: "new\n" },
              { path: deepTarget, rewrite: "deep\n", onMissing: "create" },
            ],
          },
          canonicalDirectory,
        ),
        /planned staging and cleanup.*No changes were written/s,
      );
      assert.equal(await readFile(ordinary, "utf8"), "old\n");
      await assert.rejects(lstat(deepTarget), /ENOENT/);
      assert.deepEqual(
        (await readdir(ancestor)).filter((name) => name.startsWith(".pi-apply-edits-")),
        [],
      );
    });
  },
);

test("nested create reports staging disappearance during cleanup quarantine", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const originalRm = nodeFs.promises.rm;
    let retainedContainer = "";
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (
          this: unknown,
          source: Parameters<typeof promises.rename>[0],
          target: Parameters<typeof promises.rename>[1],
        ) {
          if (basename(String(source)) === "publish" && basename(String(target)) === "q") {
            retainedContainer = dirname(String(source));
            await originalRm(source, { recursive: true });
          }
          return (originalRename as Function).call(this, source, target);
        }) as typeof promises.rename;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "missing/child.txt", rewrite: "created\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(
          warnings.join("\n"),
          /private staging cleanup was incomplete: Staged create cleanup changed during quarantine/,
        );
      },
      "../src/apply-edits.ts",
    );

    assert.equal(await readFile(join(directory, "missing/child.txt"), "utf8"), "created\n");
    assert(retainedContainer);
    assert.deepEqual(await readdir(retainedContainer), ["q"]);
    await rm(retainedContainer, { recursive: true });
  });
});

test("non-empty staged container fails cleanup at its original path", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const originalRmdir = nodeFs.promises.rmdir;
    let container = "";
    const inject = async (path: string) => {
      if (container) return;
      container = path;
      await writeFile(join(path, "concurrent"), "keep\n");
    };
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          if (
            basename(String(source)).endsWith(".tmpdir") &&
            basename(String(target)).endsWith(".tmpdir")
          ) {
            await inject(String(source));
          }
          return (originalRename as Function).call(this, source, target);
        }) as typeof promises.rename;
        promises.rmdir = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (
            !basename(dirname(String(path))).endsWith(".tmpdir") &&
            basename(String(path)).endsWith(".tmpdir")
          ) {
            await inject(String(path));
          }
          return (originalRmdir as Function).call(this, path, ...args);
        }) as typeof promises.rmdir;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "missing/file", rewrite: "ok\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(warnings.join("\n"), /container remains at.*(?:ENOTEMPTY|not empty)/is);
      },
      "../src/apply-edits.ts",
    );
    assert(container);
    assert.equal(await readFile(join(container, "concurrent"), "utf8"), "keep\n");
    assert.equal(await readFile(join(directory, "missing", "file"), "utf8"), "ok\n");
  });
});

test("staging quarantine ENOENT reports an uncertain location", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-staging");
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          if (basename(String(source)) === "publish" && basename(String(target)) === "q") {
            await (originalRename as Function).call(this, source, escaped);
          }
          return (originalRename as Function).call(this, source, target);
        }) as typeof promises.rename;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "missing/file", rewrite: "secret\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(
          warnings.join("\n"),
          /location is uncertain.*published target may remain linked to private staging/,
        );
        assert.doesNotMatch(warnings.join("\n"), /private state was preserved at/);
      },
      "../src/apply-edits.ts",
    );

    assert.equal((await stat(join(escaped, "file"))).isFile(), true);
    assert.equal((await stat(join(directory, "missing/file"))).nlink, 2);
  });
});

test(
  "owner-rejected initial private directories never enter cleanup state",
  { skip: process.platform === "win32" || typeof process.geteuid !== "function" },
  async () => {
    for (const flow of ["nested", "replacement", "direct-create"] as const) {
      await inTemporaryDirectory(async (directory) => {
        const originalMkdir = nodeFs.promises.mkdir;
        const originalLstat = nodeFs.promises.lstat;
        let privateDirectory = "";
        let spoofed = false;
        await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
          (promises) => {
            promises.mkdir = (async function (this: unknown, path: string, ...args: unknown[]) {
              const result = await (originalMkdir as Function).call(this, path, ...args);
              const name = basename(String(path));
              if (!privateDirectory && name.startsWith(".pi-apply-edits-") && name.endsWith(".tmpdir")) {
                privateDirectory = String(path);
              }
              return result;
            }) as typeof promises.mkdir;
            promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
              const stats = await (originalLstat as Function).call(this, path, ...args);
              if (!spoofed && privateDirectory && String(path) === privateDirectory) {
                spoofed = true;
                return new Proxy(stats, {
                  get(target, property, receiver) {
                    if (property === "uid") return target.uid + 1n;
                    return Reflect.get(target, property, receiver);
                  },
                });
              }
              return stats;
            }) as typeof promises.lstat;
          },
          async (module) => {
            if (flow === "replacement") await writeFile(join(directory, "f.txt"), "old\n");
            const path = flow === "nested" ? "missing/file" : flow === "replacement" ? "f.txt" : "new.txt";
            await assert.rejects(
              module.applyEditsToFile(
                { path, rewrite: "new\n", ...(flow === "replacement" ? {} : { onMissing: "create" as const }) },
                directory,
              ),
              /owner changed.*left untouched/,
              flow,
            );
          },
          "../src/apply-edits.ts",
        );

        assert(spoofed, flow);
        await lstat(privateDirectory);
      });
    }
  },
);

test("nested create warns when staging disappears before quarantine precheck", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalLstat = nodeFs.promises.lstat;
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-staging");
    let stagingChecks = 0;
    let moved = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (basename(String(path)) === "publish" && ++stagingChecks === 6) {
            await (originalRename as Function).call(this, path, escaped);
            moved = true;
          }
          return (originalLstat as Function).call(this, path, ...args);
        }) as typeof promises.lstat;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "missing/file", rewrite: "secret\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(
          warnings.join("\n"),
          /private staging cleanup was incomplete.*location is uncertain.*may remain linked/s,
        );
      },
      "../src/apply-edits.ts",
    );

    assert(moved);
    assert.equal((await stat(join(directory, "missing/file"))).nlink, 2);
    assert.equal((await stat(join(escaped, "file"))).nlink, 2);
  });
});

test(
  "owner-rejected entries inside the container block container cleanup entirely",
  { skip: process.platform === "win32" || typeof process.geteuid !== "function" },
  async () => {
    for (const rejectedName of ["q", "publish"] as const) {
      await inTemporaryDirectory(async (directory) => {
        const originalLstat = nodeFs.promises.lstat;
        let rejectedPath = "";
        let rejectedIdentity: { dev: bigint; ino: bigint } | undefined;
        await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
          (promises) => {
            promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
              const stats = await (originalLstat as Function).call(this, path, ...args);
              if (!rejectedPath && basename(String(path)) === rejectedName) {
                rejectedPath = String(path);
                rejectedIdentity = { dev: stats.dev, ino: stats.ino };
                return new Proxy(stats, {
                  get(target, property, receiver) {
                    if (property === "uid") return target.uid + 1n;
                    return Reflect.get(target, property, receiver);
                  },
                });
              }
              return stats;
            }) as typeof promises.lstat;
          },
          async (module) => {
            await assert.rejects(
              module.applyEditsToFile(
                { path: "missing/file", rewrite: "secret\n", onMissing: "create" },
                directory,
              ),
              /owner changed.*left untouched.*container was left untouched/s,
              rejectedName,
            );
          },
          "../src/apply-edits.ts",
        );

        const current = await lstat(rejectedPath, { bigint: true });
        assert.equal(current.dev, rejectedIdentity!.dev, rejectedName);
        assert.equal(current.ino, rejectedIdentity!.ino, rejectedName);
      });
    }
  },
);

test(
  "unplanned create leaves a rejected temporary directory in place without moving parents",
  { skip: process.platform === "win32" || typeof process.geteuid !== "function" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const originalLstat = nodeFs.promises.lstat;
      let rejectedPath = "";
      let rejectedIdentity: { dev: bigint; ino: bigint } | undefined;
      await withRacingFileSystem<typeof import("../src/file-system.ts")>(
        (promises) => {
          promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
            const stats = await (originalLstat as Function).call(this, path, ...args);
            const name = basename(String(path));
            if (!rejectedPath && name.startsWith(".pi-apply-edits-") && name.endsWith(".tmpdir")) {
              rejectedPath = String(path);
              rejectedIdentity = { dev: stats.dev, ino: stats.ino };
              return new Proxy(stats, {
                get(target, property, receiver) {
                  if (property === "uid") return target.uid + 1n;
                  return Reflect.get(target, property, receiver);
                },
              });
            }
            return stats;
          }) as typeof promises.lstat;
        },
        async (module) => {
          await assert.rejects(
            module.publishNewFile(join(directory, "new-parent", "file"), Buffer.from("x\n")),
            /owner changed.*left untouched/,
          );
        },
        "../src/file-system.ts",
      );

      const current = await lstat(rejectedPath, { bigint: true });
      assert.equal(current.dev, rejectedIdentity!.dev);
      assert.equal(current.ino, rejectedIdentity!.ino);
    });
  },
);

test("partial publication reports a moved staging tree as uncertain", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalLink = nodeFs.promises.link;
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-staging");
    let movedStaging = "";
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.link = (async function (this: unknown, source: string, target: string) {
          const result = await (originalLink as Function).call(this, source, target);
          if (!movedStaging && String(source).includes(".tmpdir/publish/")) {
            movedStaging = dirname(String(source));
            await (originalRename as Function).call(this, movedStaging, escaped);
          }
          return result;
        }) as typeof promises.link;
      },
      async (module) => {
        await assert.rejects(
          module.applyEditsToFile(
            { path: "missing/file", rewrite: "secret\n", onMissing: "create" },
            directory,
          ),
          (error: Error) => {
            assert.match(error.message, /location is uncertain.*may remain linked/s);
            assert.doesNotMatch(error.message, /private staging remains at/);
            return true;
          },
        );
      },
      "../src/apply-edits.ts",
    );

    assert(movedStaging);
    assert.equal((await stat(join(escaped, "file"))).nlink, 2);
  });
});

test("staged container disappearance before cleanup returns a warning", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalLstat = nodeFs.promises.lstat;
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-container");
    const checks = new Map<string, number>();
    let moved = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
          const name = basename(String(path));
          if (name.startsWith(".pi-apply-edits-") && name.endsWith(".tmpdir")) {
            const count = (checks.get(String(path)) ?? 0) + 1;
            checks.set(String(path), count);
            if (!moved && count === 3) {
              await (originalRename as Function).call(this, path, escaped);
              moved = true;
            }
          }
          return (originalLstat as Function).call(this, path, ...args);
        }) as typeof promises.lstat;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "missing/file", rewrite: "ok\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(
          warnings.join("\n"),
          /container disappeared before cleanup.*location is uncertain.*may remain outside.*may not be empty/s,
        );
      },
      "../src/apply-edits.ts",
    );
    assert(moved);
    assert.equal((await stat(escaped)).isDirectory(), true);
  });
});

test("direct create warns when its temporary link escapes before unlink", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-temporary-link");
    let moved = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          if (
            !moved &&
            basename(String(source)) === "create" &&
            basename(String(target)) === "entry"
          ) {
            await (originalRename as Function).call(this, source, escaped);
            moved = true;
          }
          return (originalRename as Function).call(this, source, target);
        }) as typeof promises.rename;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "file", rewrite: "secret\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(
          warnings.join("\n"),
          /temporary link is no longer at.*may remain hard-linked/s,
        );
      },
      "../src/apply-edits.ts",
    );

    assert(moved);
    const target = await stat(join(directory, "file"));
    assert.equal(Number(target.nlink), 2);
    assert.equal(target.ino, (await stat(escaped)).ino);
  });
});

test("replacement warns when the recovery link escapes before unlink", async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "file");
    const escaped = join(directory, "escaped-recovery");
    await writeFile(target, "old\n");
    const { captureSnapshot, publishReplacement } = await import("../src/file-system.ts");
    const snapshot = await captureSnapshot(target);
    assert(snapshot);
    const warnings = await publishReplacement(snapshot, Buffer.from("new\n"), undefined, {
      beforeRecoveryCleanup: async ({ recovery }) => {
        await rename(recovery, escaped);
      },
    });
    assert.match(
      warnings.join("\n"),
      /recovery link is no longer at.*previous content may remain elsewhere/s,
    );
    assert.equal(await readFile(target, "utf8"), "new\n");
    assert.equal(await readFile(escaped, "utf8"), "old\n");
  });
});

test("partial publication does not claim absence when staging cannot be inspected", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalLink = nodeFs.promises.link;
    const originalLstat = nodeFs.promises.lstat;
    let linkCalls = 0;
    let publicationFailed = false;
    let staging = "";
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.link = (async function (this: unknown, source: string, target: string) {
          linkCalls += 1;
          staging ||= dirname(String(source));
          if (linkCalls === 2) {
            publicationFailed = true;
            throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
          }
          return (originalLink as Function).call(this, source, target);
        }) as typeof promises.link;
        promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (publicationFailed && basename(String(path)) === "publish") {
            throw Object.assign(new Error("injected staging inspection failure"), { code: "EACCES" });
          }
          return (originalLstat as Function).call(this, path, ...args);
        }) as typeof promises.lstat;
      },
      async (module) => {
        await assert.rejects(
          module.applyEditsToFile(
            {
              files: [
                { path: "missing/a", rewrite: "a\n", onMissing: "create" },
                { path: "missing/b", rewrite: "b\n", onMissing: "create" },
              ],
            },
            directory,
          ),
          (error: Error) => {
            assert.match(error.message, /could not be verified at.*may remain linked/s);
            assert.doesNotMatch(error.message, /no longer at its recorded path/);
            return true;
          },
        );
      },
      "../src/apply-edits.ts",
    );
    assert((await lstat(staging)).isDirectory());
  });
});

test("staged container disappearance during rmdir returns a warning", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const originalRmdir = nodeFs.promises.rmdir;
    const escaped = join(directory, "escaped-container");
    let moved = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rmdir = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (
            !moved &&
            !basename(dirname(String(path))).endsWith(".tmpdir") &&
            basename(String(path)).endsWith(".tmpdir")
          ) {
            await (originalRename as Function).call(this, path, escaped);
            moved = true;
          }
          return (originalRmdir as Function).call(this, path, ...args);
        }) as typeof promises.rmdir;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "missing/file", rewrite: "ok\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(
          warnings.join("\n"),
          /container disappeared during cleanup.*location is uncertain.*may remain outside.*may not be empty/s,
        );
      },
      "../src/apply-edits.ts",
    );
    assert(moved);
    assert.equal((await stat(escaped)).isDirectory(), true);
  });
});

test("direct create warns when its temporary link escapes after quarantine", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-temporary-link");
    let moved = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          const result = await (originalRename as Function).call(this, source, target);
          if (
            !moved &&
            basename(String(source)) === "create" &&
            basename(String(target)) === "entry"
          ) {
            moved = true;
            await (originalRename as Function).call(this, target, escaped);
          }
          return result;
        }) as typeof promises.rename;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "file", rewrite: "secret\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(warnings.join("\n"), /temporary link is no longer at.*may remain hard-linked/s);
      },
      "../src/apply-edits.ts",
    );
    assert(moved);
    assert.equal((await stat(join(directory, "file"))).ino, (await stat(escaped)).ino);
  });
});

test("staged create cleanup reports an escape after its quarantine rename", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-staging");
    let moved = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          const result = await (originalRename as Function).call(this, source, target);
          if (!moved && basename(String(source)) === "publish" && basename(String(target)) === "q") {
            moved = true;
            await (originalRename as Function).call(this, target, escaped);
          }
          return result;
        }) as typeof promises.rename;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "missing/file", rewrite: "secret\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(
          warnings.join("\n"),
          /changed during quarantine.*location is uncertain.*may remain linked/s,
        );
      },
      "../src/apply-edits.ts",
    );
    assert(moved);
    assert.equal(
      (await stat(join(directory, "missing", "file"))).ino,
      (await stat(join(escaped, "file"))).ino,
    );
  });
});

test("non-empty temporary directory fails cleanup in place instead of being moved", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const originalRmdir = nodeFs.promises.rmdir;
    let injectedDirectory = "";
    const inject = async (path: string) => {
      if (injectedDirectory) return;
      injectedDirectory = path;
      await writeFile(join(path, "concurrent"), "keep\n");
    };
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          if (
            !basename(dirname(String(source))).endsWith(".tmpdir") &&
            basename(String(source)).endsWith(".tmpdir") &&
            basename(String(target)) === "entry"
          ) {
            await inject(String(source));
          }
          return (originalRename as Function).call(this, source, target);
        }) as typeof promises.rename;
        promises.rmdir = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (
            !basename(dirname(String(path))).endsWith(".tmpdir") &&
            basename(String(path)).endsWith(".tmpdir")
          ) {
            await inject(String(path));
          }
          return (originalRmdir as Function).call(this, path, ...args);
        }) as typeof promises.rmdir;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "file", rewrite: "ok\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(warnings.join("\n"), /temporary directory remains.*(?:ENOTEMPTY|not empty)/is);
      },
      "../src/apply-edits.ts",
    );
    assert(injectedDirectory);
    assert.equal(await readFile(join(injectedDirectory, "concurrent"), "utf8"), "keep\n");
    assert.equal(await readFile(join(directory, "file"), "utf8"), "ok\n");
  });
});

test(
  "nested create whose rollback cleanup would exceed the budget is rejected during planning",
  { skip: process.platform !== "darwin" && process.platform !== "linux" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const limit = process.platform === "darwin" ? 1024 : 4096;
      const base = await realpath(directory);
      // Long missing root keeps the staged copy of the tree well under the budget while the
      // target itself stays legal; only the rollback quarantine beside the target overflows.
      const root = "r".repeat(255);
      const desiredParent = limit - 33 - 10;
      let remaining = desiredParent - Buffer.byteLength(join(base, root));
      const segments: string[] = [root];
      while (remaining > 0) {
        const length = Math.min(200, remaining - 1 > 0 ? remaining - 1 : 1);
        segments.push("d".repeat(length));
        remaining -= length + 1;
      }
      const target = join(base, ...segments, "f");
      assert(Buffer.byteLength(target) <= limit - 33);
      assert(Buffer.byteLength(dirname(target)) + 67 > limit - 33);

      await assert.rejects(
        applyEditsToFile({ path: target, rewrite: "x\n", onMissing: "create" }, base),
        /planned staging and cleanup.*No changes were written/s,
      );
      await assert.rejects(lstat(join(base, root)), /ENOENT/);
      assert.deepEqual(
        (await readdir(base)).filter((name) => name.startsWith(".pi-apply-edits-")),
        [],
      );
    });
  },
);

test(
  "near-limit direct create is rejected during planning on supported POSIX platforms",
  { skip: process.platform !== "darwin" && process.platform !== "linux" },
  async () => {
    await inTemporaryDirectory(async (directory) => {
      const limit = process.platform === "darwin" ? 1024 : 4096;
      const desiredLength = limit - 75;
      let ancestor = await realpath(directory);
      let remaining = desiredLength - Buffer.byteLength(ancestor);
      if (remaining % 2 === 1) {
        ancestor = join(ancestor, "xx");
        remaining -= 3;
      }
      while (remaining > 256) {
        ancestor = join(ancestor, "x");
        remaining -= 2;
      }
      ancestor = join(ancestor, "x".repeat(remaining - 1));
      assert.equal(Buffer.byteLength(ancestor), desiredLength);
      await mkdir(ancestor, { recursive: true });
      const target = join(ancestor, "f");

      await assert.rejects(
        applyEditsToFile(
          { path: target, rewrite: "secret\n", onMissing: "create" },
          directory,
        ),
        new RegExp(
          `planned staging and cleanup.*safety margin below PATH_MAX ${limit}.*No changes were written`,
          "s",
        ),
      );
      await assert.rejects(lstat(target), /ENOENT/);
      assert.deepEqual(
        (await readdir(ancestor)).filter((name) => name.startsWith(".pi-apply-edits-")),
        [],
      );
    });
  },
);

test("replacement failure discloses an unverifiable recovery link", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const originalLstat = nodeFs.promises.lstat;
    let failed = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          if (basename(String(source)) === "replacement" && basename(String(target)) === "file") {
            failed = true;
            throw Object.assign(new Error("forced commit failure"), { code: "EACCES" });
          }
          return (originalRename as Function).call(this, source, target);
        }) as typeof promises.rename;
        promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (failed && basename(String(path)).endsWith(".tmp")) {
            throw Object.assign(new Error("forced verification failure"), { code: "EACCES" });
          }
          return (originalLstat as Function).call(this, path, ...args);
        }) as typeof promises.lstat;
      },
      async (module) => {
        await writeFile(join(directory, "file"), "before\n");
        await assert.rejects(
          module.applyEditsToFile({ path: "file", rewrite: "after\n" }, directory),
          /the pre-edit recovery link could not be verified or removed and may remain at .* or elsewhere, possibly hard-linked to the target/s,
        );
      },
      "../src/apply-edits.ts",
    );
    assert(failed);
    assert.equal(await readFile(join(directory, "file"), "utf8"), "before\n");
  });
});

test("successful create discloses an unverifiable temporary link", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalLink = nodeFs.promises.link;
    const originalMkdir = nodeFs.promises.mkdir;
    let published = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.link = (async function (this: unknown, source: string, target: string) {
          const result = await (originalLink as Function).call(this, source, target);
          if (basename(String(source)) === "create" && basename(String(target)) === "file") {
            published = true;
          }
          return result;
        }) as typeof promises.link;
        promises.mkdir = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (published && basename(String(path)).endsWith(".tmpdir")) {
            throw Object.assign(new Error("forced quarantine failure"), { code: "EACCES" });
          }
          return (originalMkdir as Function).call(this, path, ...args);
        }) as typeof promises.mkdir;
      },
      async (module) => {
        const result = await module.applyEditsToFile(
          { path: "file", rewrite: "secret\n", onMissing: "create" },
          directory,
        );
        const warnings = "warnings" in result.details ? result.details.warnings : [];
        assert.match(
          warnings.join("\n"),
          /temporary link could not be verified or removed and may remain at .* or elsewhere, possibly hard-linked to the created file/s,
        );
      },
      "../src/apply-edits.ts",
    );
    assert(published);
    assert.equal(await readFile(join(directory, "file"), "utf8"), "secret\n");
    assert.equal(Number((await stat(join(directory, "file"))).nlink), 2);
  });
});

test("create succeeds when realpath is unavailable for every ancestor", async () => {
  await inTemporaryDirectory(async (unresolved) => {
    // Resolve first: the walk crosses every ancestor, and a real symlink like /var would
    // correctly fail the dangling-link check before the root terminator is reached.
    const directory = await realpath(unresolved);
    const originalRealpath = nodeFs.promises.realpath;
    let walked = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.realpath = (async function (this: unknown, path: string, ...args: unknown[]) {
          // Fail every ancestor during key discovery so the walk reaches the root terminator;
          // later callers (planning, Pi's queue) see the real filesystem again.
          if (!walked) {
            if (String(path) === "/") walked = true;
            throw Object.assign(new Error("forced missing"), { code: "ENOENT" });
          }
          return (originalRealpath as Function).call(this, path, ...args);
        }) as typeof promises.realpath;
      },
      async (module) => {
        // Forces mutationQueueKeys onto its root-terminator branch: every ancestor, including
        // the filesystem root, reports missing, so the exact resolved path is the queue key.
        const result = await module.applyEditsToFile(
          { path: "sub/file.txt", rewrite: "rooted\n", onMissing: "create" },
          directory,
        );
        assert("operation" in result.details && result.details.operation === "create");
      },
      "../src/apply-edits.ts",
    );
    assert(walked); // the discovery walk really reached the filesystem root
    assert.equal(await readFile(join(directory, "sub", "file.txt"), "utf8"), "rooted\n");
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith(".pi-apply-edits-")),
      [],
    );
  });
});

test("simulated Windows path budget rejects in UTF-16 code units before any filesystem access", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRealpath = nodeFs.promises.realpath;
    const originalLstat = nodeFs.promises.lstat;
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert(platform);
    let touchedLongPath = false;
    const guard = (path: unknown) => {
      if (String(path).length > 5000) {
        touchedLongPath = true;
        throw Object.assign(new Error("forced missing"), { code: "ENOENT" });
      }
    };
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
        (promises) => {
          promises.realpath = (async function (this: unknown, path: string, ...args: unknown[]) {
            guard(path);
            return (originalRealpath as Function).call(this, path, ...args);
          }) as typeof promises.realpath;
          promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
            guard(path);
            return (originalLstat as Function).call(this, path, ...args);
          }) as typeof promises.lstat;
        },
        async (module) => {
          const target = join(directory, "x".repeat(33000));
          await assert.rejects(
            module.applyEditsToFile({ path: target, rewrite: "x\n", onMissing: "create" }, directory),
            /planned staging and cleanup require a \d+-character path, beyond the supported 32702 characters on Windows \(64-unit safety margin below PATH_MAX 32767\)\. No changes were written\./,
          );
        },
        "../src/apply-edits.ts",
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    assert(touchedLongPath); // key discovery consulted the mocks, never the real filesystem
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith(".pi-apply-edits-")),
      [],
    );
  });
});

test("create failure discloses an unverifiable temporary file", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalLink = nodeFs.promises.link;
    const originalLstat = nodeFs.promises.lstat;
    const originalOpen = nodeFs.promises.open;
    let failed = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.link = (async function (this: unknown, source: string, target: string) {
          if (basename(String(source)) === "create") {
            failed = true;
            throw Object.assign(new Error("forced link failure"), { code: "EACCES" });
          }
          return (originalLink as Function).call(this, source, target);
        }) as typeof promises.link;
        promises.open = (async function (this: unknown, path: string, flags: unknown, ...args: unknown[]) {
          if (failed && basename(String(path)) === "file" && flags === "wx") {
            throw Object.assign(new Error("forced fallback failure"), { code: "EACCES" });
          }
          return (originalOpen as Function).call(this, path, flags, ...args);
        }) as typeof promises.open;
        promises.lstat = (async function (this: unknown, path: string, ...args: unknown[]) {
          if (failed && basename(String(path)) === "create") {
            throw Object.assign(new Error("forced verification failure"), { code: "EACCES" });
          }
          return (originalLstat as Function).call(this, path, ...args);
        }) as typeof promises.lstat;
      },
      async (module) => {
        await assert.rejects(
          module.applyEditsToFile(
            { path: "file", rewrite: "secret\n", onMissing: "create" },
            directory,
          ),
          /the temporary create file could not be verified or removed and may remain at .* or elsewhere, possibly hard-linked to the created file/s,
        );
      },
      "../src/apply-edits.ts",
    );
    assert(failed);
  });
});

test("create failure discloses an escaped temporary file", async () => {
  await inTemporaryDirectory(async (directory) => {
    const escaped = join(directory, "escaped-temporary");
    const { publishNewFile } = await import("../src/file-system.ts");
    await assert.rejects(
      publishNewFile(join(directory, "file"), Buffer.from("secret\n"), undefined, undefined, {
        beforeFilePublish: async ({ temporary }) => {
          await rename(temporary, escaped);
        },
      }),
      /temporary create file is no longer at.*content may remain elsewhere/s,
    );
    assert.equal(await readFile(escaped, "utf8"), "secret\n");
    await assert.rejects(lstat(join(directory, "file")), /ENOENT/);
  });
});

test("replacement failure discloses an escaped recovery link", async () => {
  await inTemporaryDirectory(async (directory) => {
    const target = join(directory, "file");
    const escaped = join(directory, "escaped-recovery");
    await writeFile(target, "old\n");
    const { captureSnapshot, publishReplacement } = await import("../src/file-system.ts");
    const snapshot = await captureSnapshot(target);
    assert(snapshot);
    const controller = new AbortController();
    await assert.rejects(
      publishReplacement(snapshot, Buffer.from("new\n"), controller.signal, {
        beforeRename: async () => {
          const recoveryName = (await readdir(directory)).find((name) => name.endsWith(".tmp"));
          assert(recoveryName);
          await rename(join(directory, recoveryName), escaped);
          controller.abort();
        },
      }),
      /recovery link is no longer at.*target may remain hard-linked/s,
    );
    assert.equal(await readFile(target, "utf8"), "old\n");
    assert.equal(Number((await stat(target)).nlink), 2);
    assert.equal((await stat(target)).ino, (await stat(escaped)).ino);
  });
});

test("batch failure preserves warnings from completed files", async () => {
  await inTemporaryDirectory(async (directory) => {
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-temporary-link");
    const controller = new AbortController();
    let moved = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          if (
            !moved &&
            basename(String(source)) === "create" &&
            basename(String(target)) === "entry"
          ) {
            await (originalRename as Function).call(this, source, escaped);
            moved = true;
            controller.abort();
          }
          return (originalRename as Function).call(this, source, target);
        }) as typeof promises.rename;
      },
      async (module) => {
        await assert.rejects(
          module.applyEditsToFile(
            {
              files: [
                { path: "first", rewrite: "secret\n", onMissing: "create" },
                { path: "second", rewrite: "second\n", onMissing: "create" },
              ],
            },
            directory,
            controller.signal,
          ),
          /Earlier warnings from completed files:.*may remain hard-linked/s,
        );
      },
      "../src/apply-edits.ts",
    );
    assert(moved);
    assert.equal((await stat(join(directory, "first"))).ino, (await stat(escaped)).ino);
  });
});

test("summary deduplicates repeated warnings so unique ones stay visible", async () => {
  await inTemporaryDirectory(async (directory) => {
    for (let index = 0; index < 4; index++) {
      await writeFile(join(directory, `existing-${index}`), "a");
    }
    const originalRename = nodeFs.promises.rename;
    const escaped = join(directory, "escaped-temporary-link");
    let moved = false;
    await withRacingFileSystem<typeof import("../src/apply-edits.ts")>(
      (promises) => {
        promises.rename = (async function (this: unknown, source: string, target: string) {
          if (
            !moved &&
            basename(String(source)) === "create" &&
            basename(String(target)) === "entry"
          ) {
            await (originalRename as Function).call(this, source, escaped);
            moved = true;
          }
          return (originalRename as Function).call(this, source, target);
        }) as typeof promises.rename;
      },
      async (module) => {
        const files: object[] = Array.from({ length: 4 }, (_, index) => ({
          path: `existing-${index}`,
          edits: [{ oldText: "a", newText: "b", insert: "after" }],
        }));
        files.push({ path: "created", rewrite: "secret\n", onMissing: "create" });
        const result = await module.applyEditsToFile({ files } as never, directory);
        assert.match(result.summary, /may remain hard-linked/);
        assert.doesNotMatch(result.summary, / more\b/);
      },
      "../src/apply-edits.ts",
    );
    assert(moved);
  });
});
