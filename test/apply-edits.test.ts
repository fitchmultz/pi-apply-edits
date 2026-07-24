import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { applyEditsToFile, applyTargetedEdits, resolveInputPath, type ApplyEditsDetails } from "../src/apply-edits.ts";

function singleDetails(details: { files?: ApplyEditsDetails[] } | ApplyEditsDetails): ApplyEditsDetails {
  if (details && typeof details === "object" && "files" in details) {
    throw new Error("expected single-file details");
  }
  return details as ApplyEditsDetails;
}

import {
  captureSnapshot,
  publishNewFile,
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
    /overlapping normalized matches/,
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

test("empty, NUL, and no-op targeted edits fail", () => {
  assert.throws(() => applyTargetedEdits("x", [{ oldText: "", newText: "y" }], "f"), /must not be empty/);
  assert.throws(() => applyTargetedEdits("x", [{ oldText: "x", newText: "x" }], "f"), /no change/);
  assert.throws(() => applyTargetedEdits("x", [{ oldText: "x", newText: "\0" }], "f"), /NUL/);
  assert.throws(
    () => applyTargetedEdits("x", [{ oldText: "x", newText: "\ud800" }], "f"),
    /valid Unicode/,
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

test("targeted edits cannot duplicate or add a UTF-8 BOM", async () => {
  await inTemporaryDirectory(async (directory) => {
    const withBom = join(directory, "with-bom.txt");
    const withoutBom = join(directory, "without-bom.txt");
    await writeFile(withBom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\n")]));
    await writeFile(withoutBom, "one\n");

    await applyEditsToFile(
      { path: withBom, edits: [{ oldText: "one", newText: "\uFEFFtwo" }] },
      directory,
    );
    await applyEditsToFile(
      { path: withoutBom, edits: [{ oldText: "one", newText: "\uFEFFtwo" }] },
      directory,
    );

    assert.deepEqual(
      await readFile(withBom),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("two\n")]),
    );
    assert.equal(await readFile(withoutBom, "utf8"), "two\n");
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
    assert.match(warnings.join(" "), /recovery link remains/);
    assert.match(warnings.join(" "), /parent directory could not be synced/);
    await unlink(recovery);
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
    assert.throws(() => resolveInputPath("~", directory), /Ambiguous path/);
    assert.equal(resolveInputPath("./~", directory), literalTilde);
  });
});

test("invalid file URLs use an existing literal path or return a normalized error", async () => {
  await inTemporaryDirectory(async (directory) => {
    const literalDirectory = join(directory, "file:", "host");
    const literalPath = join(literalDirectory, "x.txt");
    await mkdir(literalDirectory, { recursive: true });
    await writeFile(literalPath, "literal\n");

    assert.equal(resolveInputPath("file://host/x.txt", directory), literalPath);
    assert.throws(
      () => resolveInputPath("file://missing/y.txt", directory),
      /Invalid file URL path/,
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
    assert.equal("files" in result.details, true);
    if (!("files" in result.details)) throw new Error("expected batch details");
    assert.equal(result.details.files.length, 2);
    assert.equal(await readFile(join(directory, "a.ts"), "utf8"), "const a = 2;\n");
    assert.equal(await readFile(join(directory, "b.ts"), "utf8"), "const b = 1;\nexport {};\n");
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

test("insert rejects when the text is already adjacent to the anchor", () => {
  assert.throws(
    () =>
      applyTargetedEdits(
        'import fs from "node:fs";\nimport path from "node:path";\n',
        [{
          oldText: 'import fs from "node:fs";',
          newText: '\nimport path from "node:path";',
          insert: "after",
        }],
        "a.ts",
      ),
    /already has the inserted text/,
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
    /overlapping normalized matches/,
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
