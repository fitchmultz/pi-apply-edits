import assert from "node:assert/strict";
import nodeFs from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { applyPatchToFiles, replaceTextInFiles, writeFiles } from "../src/apply-edits.ts";
import { withRacingEditing } from "./racing.ts";

async function fixture(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pi-edit-contract-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const patch = (...operations: readonly string[]) =>
  `*** Begin Patch\n${operations.join("\n")}\n*** End Patch`;
const update = (path: string, before: string, after: string) =>
  `*** Update File: ${path}\n@@\n-${before}\n+${after}`;
const caseInsensitiveTmp = await (async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-case-"));
  try {
    await writeFile(join(directory, "probe"), "");
    return await lstat(join(directory, "PROBE")).then(
      () => true,
      () => false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

nodeTest(
  "patch plans and applies create/update/move/delete with verified absolute receipts",
  async (t) => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, "source"), "\uFEFFbefore\r\nlast");
    await chmod(join(cwd, "source"), 0o751);
    await writeFile(join(cwd, "obsolete"), "delete\n");
    await writeFile(join(cwd, "plain"), "old\n");
    const result = await applyPatchToFiles(
      patch(
        "*** Update File: source\n*** Move to: nested/moved\n@@\n-before\n+after",
        "*** Add File: nested/new\n+created",
        "*** Delete File: obsolete",
        update("plain", "old", "new"),
      ),
      cwd,
    );
    assert.equal(result.details.error, undefined, result.summary);
    assert.deepEqual(
      new Set(result.details.modifiedFiles),
      new Set(
        ["source", "nested/moved", "nested/new", "obsolete", "plain"].map((path) =>
          join(cwd, path),
        ),
      ),
    );
    assert.deepEqual(
      result.details.files.map((file) => [file.operation, file.status]),
      [
        ["move", "applied"],
        ["create", "applied"],
        ["delete", "applied"],
        ["patch", "applied"],
      ],
    );
    assert.equal(await readFile(join(cwd, "nested/moved"), "utf8"), "\uFEFFafter\r\nlast");
    assert.equal((await lstat(join(cwd, "nested/moved"))).mode & 0o777, 0o751);
    assert.equal(await readFile(join(cwd, "nested/new"), "utf8"), "created\n");
    await Promise.all(
      ["source", "obsolete"].map((name) => assert.rejects(lstat(join(cwd, name)), /ENOENT/)),
    );
  },
);

nodeTest("a patch naming one file twice gets patch-specific recovery advice", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "a.txt"), "old\n");
  for (const operations of [
    ["*** Delete File: a.txt", "*** Add File: a.txt\n+new"],
    [update("a.txt", "old", "mid"), update("a.txt", "mid", "new")],
  ]) {
    const result = await applyPatchToFiles(patch(...operations), cwd);
    assert.equal(
      result.details.error,
      `files[1] refers to the same file as files[0] (${join(cwd, "a.txt")}). A patch can name each file once. Use one Update File section, or write_files with mode: "replace" to rewrite a file.`,
    );
    assert.deepEqual(result.details.modifiedFiles, []);
  }
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "old\n");
});

nodeTest(
  "case-only moves respell the entry in place, with or without content changes",
  { skip: !caseInsensitiveTmp && "requires a case-insensitive temporary directory" },
  async (t) => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, "readme.md"), "# hi\n");
    await chmod(join(cwd, "readme.md"), 0o640);
    const before = await lstat(join(cwd, "readme.md"));
    const rename = patch("*** Update File: readme.md\n*** Move to: README.md");
    const preview = await applyPatchToFiles(rename, cwd, true);
    assert.equal(preview.details.error, undefined, preview.summary);
    assert.deepEqual(await readdir(cwd), ["readme.md"]);

    const moved = await applyPatchToFiles(rename, cwd);
    assert.equal(moved.summary, "Moved 1 file: readme.md \u2192 README.md.");
    assert.deepEqual(await readdir(cwd), ["README.md"]);
    const after = await lstat(join(cwd, "README.md"));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o640);

    const edited = await applyPatchToFiles(
      patch("*** Update File: README.md\n*** Move to: Readme.md\n@@\n-# hi\n+# hello"),
      cwd,
    );
    assert.equal(edited.details.error, undefined, edited.summary);
    assert.deepEqual(await readdir(cwd), ["Readme.md"]);
    assert.equal(await readFile(join(cwd, "Readme.md"), "utf8"), "# hello\n");
  },
);

nodeTest(
  "Unicode case respelling supports pure moves and verifies replacement bytes",
  { skip: !caseInsensitiveTmp && "requires a case-insensitive temporary directory" },
  async (t) => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, "café.md"), "old\n");
    const edited = await applyPatchToFiles(
      patch("*** Update File: café.md\n*** Move to: CAFÉ.md\n@@\n-old\n+requested"),
      cwd,
    );
    assert.equal(edited.details.error, undefined, edited.summary);
    assert.deepEqual(edited.details.modifiedFiles, [join(cwd, "café.md"), join(cwd, "CAFÉ.md")]);
    assert.equal(await readFile(join(cwd, "CAFÉ.md"), "utf8"), "requested\n");
    const before = await lstat(join(cwd, "CAFÉ.md"));
    const moved = await applyPatchToFiles(
      patch("*** Update File: CAFÉ.md\n*** Move to: Café.md"),
      cwd,
    );
    assert.equal(moved.details.error, undefined, moved.summary);
    assert.equal((await lstat(join(cwd, "Café.md"))).ino, before.ino);
    assert.deepEqual((await readdir(cwd)).map((name) => name.normalize("NFC")).sort(), ["Café.md"]);
    assert.equal(await readFile(join(cwd, "Café.md"), "utf8"), "requested\n");
  },
);

nodeTest(
  "content respelling reports interference after rename as uncertain, not success",
  { skip: !caseInsensitiveTmp && "requires a case-insensitive temporary directory" },
  async (t) => {
    const cwd = await fixture(t);
    const source = join(cwd, "readme.md");
    const target = join(cwd, "README.md");
    await writeFile(source, "old\n");
    const originalRename = nodeFs.promises.rename;
    await withRacingEditing(
      (mock) => {
        mock.method(
          nodeFs.promises,
          "rename",
          async (...args: Readonly<Parameters<typeof originalRename>>) => {
            await originalRename(...args);
            if (String(args[0]) === source && String(args[1]) === target) {
              await writeFile(target, "external\n");
            }
          },
        );
      },
      async (module) => {
        const result = await module.applyPatchToFiles(
          patch("*** Update File: readme.md\n*** Move to: README.md\n@@\n-old\n+requested"),
          cwd,
        );
        assert.match(result.details.error ?? "", /Move destination could not be verified/);
        assert.deepEqual(result.details.modifiedFiles, [source]);
        assert.equal(result.details.files[0]?.status, "uncertain");
        assert.ok(result.summary.includes(`Uncertain paths: ${target}`), result.summary);
      },
    );
    assert.deepEqual(await readdir(cwd), ["README.md"]);
    assert.equal(await readFile(target, "utf8"), "external\n");
  },
);

nodeTest(
  "a case-only move in an unreadable directory is refused before writing",
  {
    skip: caseInsensitiveTmp
      ? process.getuid?.() === 0 && "root reads every directory"
      : "requires a case-insensitive temporary directory",
  },
  async (t) => {
    const cwd = await fixture(t);
    const directory = join(cwd, "drop");
    await mkdir(directory);
    await writeFile(join(directory, "readme.md"), "# hi\n");
    await chmod(directory, 0o300);
    let result;
    try {
      result = await applyPatchToFiles(
        patch("*** Update File: drop/readme.md\n*** Move to: drop/README.md"),
        cwd,
      );
    } finally {
      await chmod(directory, 0o700);
    }
    assert.match(
      result.details.error ?? "",
      /requires a readable directory to verify the new name: .*\. No changes were written\.$/,
    );
    assert.deepEqual(result.details.modifiedFiles, []);
    assert.deepEqual(await readdir(directory), ["readme.md"]);
  },
);

nodeTest(
  "a filesystem that keeps the old spelling fails the case-only move determinately",
  { skip: !caseInsensitiveTmp && "requires a case-insensitive temporary directory" },
  async (t) => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, "readme.md"), "# hi\n");
    const originalRename = nodeFs.promises.rename;
    await withRacingEditing(
      (mock) => {
        // Linux vfat treats a respelling as a rename onto the same file and keeps the old name.
        mock.method(
          nodeFs.promises,
          "rename",
          async (...args: Readonly<Parameters<typeof originalRename>>) => {
            const from = String(args[0]);
            const to = String(args[1]);
            if (
              from !== to &&
              dirname(from) === dirname(to) &&
              basename(from).toLowerCase() === basename(to).toLowerCase()
            ) {
              return;
            }
            await originalRename(...args);
          },
        );
      },
      async (module) => {
        // The patch may address the source by another spelling than the stored one.
        const pure = await module.applyPatchToFiles(
          patch("*** Update File: README.md\n*** Move to: Readme.md"),
          cwd,
        );
        assert.match(
          pure.details.error ?? "",
          /kept the name .*readme\.md; it cannot change only the spelling of a name\. No changes were written\./,
        );
        assert.deepEqual(pure.details.modifiedFiles, []);
        assert.doesNotMatch(pure.summary, /Uncertain paths: (?!none)/);

        const edited = await module.applyPatchToFiles(
          patch("*** Update File: readme.md\n*** Move to: README.md\n@@\n-# hi\n+# hello"),
          cwd,
        );
        assert.match(
          edited.details.error ?? "",
          /The content change was published under the original name\./,
        );
        assert.deepEqual(edited.details.modifiedFiles, [join(cwd, "readme.md")]);
        assert.doesNotMatch(edited.summary, /Uncertain paths: (?!none)/);
      },
    );
    assert.deepEqual(await readdir(cwd), ["readme.md"]);
    assert.equal(await readFile(join(cwd, "readme.md"), "utf8"), "# hello\n");
  },
);

nodeTest("patch BOM rejection leaves update and move sources untouched", async (t) => {
  const cwd = await fixture(t);
  const original = "heading\n\uFEFFpayload\n";
  await writeFile(join(cwd, "source"), original);
  async function verifyBomRejection(preview: boolean, move: string): Promise<void> {
    const result = await applyPatchToFiles(
      patch(`*** Update File: source\n${move}-heading`),
      cwd,
      preview,
    );
    assert(result.details.error !== undefined);
    assert.match(result.details.error, /U\+FEFF/);
    assert.deepEqual(result.details.modifiedFiles, []);
    assert.equal(await readFile(join(cwd, "source"), "utf8"), original);
    assert.deepEqual(await readdir(cwd), ["source"]);
  }
  for (const preview of [false, true]) {
    for (const move of ["", "*** Move to: moved\n"]) {
      // Both variants reuse the source and must verify its retained bytes before the next attempt.
      await verifyBomRejection(preview, move);
    }
  }
});

nodeTest(
  "pure moves and deletes operate on link entries, including dangling links",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, "target"), "untouched\n");
    await symlink("target", join(cwd, "link"));
    await symlink("absent", join(cwd, "dangling"));
    const result = await applyPatchToFiles(
      patch("*** Update File: link\n*** Move to: moved", "*** Delete File: dangling"),
      cwd,
    );
    assert.equal(result.details.error, undefined, result.summary);
    assert.equal(await readlink(join(cwd, "moved")), "target");
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "untouched\n");
    assert.deepEqual(
      result.details.files.map((file) => [
        file.bytesBefore,
        file.bytesAfter,
        file.addedLines,
        file.deletedLines,
      ]),
      [
        [6, 6, undefined, undefined],
        [6, 0, undefined, undefined],
      ],
    );
    assert.deepEqual(
      new Set(result.details.modifiedFiles),
      new Set(["link", "moved", "dangling"].map((path) => join(cwd, path))),
    );
    const reject = await applyPatchToFiles(
      patch("*** Update File: moved\n*** Move to: elsewhere\n@@\n-untouched\n+wrong"),
      cwd,
    );
    assert.match(reject.summary, /link-target content/);
    assert.deepEqual(reject.details.modifiedFiles, []);
  },
);

nodeTest(
  "batch refuses to delete a link used by another requested path",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await fixture(t);
    await mkdir(join(cwd, "real"));
    await symlink("real", join(cwd, "alias"));
    await symlink("alias", join(cwd, "pointer"));
    const deletion = "*** Delete File: alias";
    async function verifyTraversalRejection(operations: readonly string[]): Promise<void> {
      const result = await applyPatchToFiles(patch(...operations), cwd);
      assert.match(result.summary, /traverses symbolic link/);
      assert.deepEqual(result.details.modifiedFiles, []);
      assert.equal(await readlink(join(cwd, "alias")), "real");
      await assert.rejects(lstat(join(cwd, "real/child.txt")), /ENOENT/);
    }
    for (const name of ["alias", "pointer"]) {
      const creation = `*** Add File: ${name}/child.txt\n+content`;
      for (const operations of [
        [deletion, creation],
        [creation, deletion],
      ]) {
        // Each order is attempted against the same link and must verify no publication first.
        await verifyTraversalRejection(operations);
      }
    }
  },
);

nodeTest(
  "batch refuses to delete a link before deleting an entry through it",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await fixture(t);
    await mkdir(join(cwd, "real"));
    await writeFile(join(cwd, "real/child.txt"), "retained\n");
    await symlink("real", join(cwd, "alias"));
    const result = await applyPatchToFiles(
      patch("*** Delete File: alias", "*** Delete File: alias/child.txt"),
      cwd,
    );
    assert.match(result.summary, /traverses symbolic link/);
    assert.deepEqual(result.details.modifiedFiles, []);
    assert.equal(await readlink(join(cwd, "alias")), "real");
    assert.equal(await readFile(join(cwd, "real/child.txt"), "utf8"), "retained\n");

    await symlink("alias/child.txt", join(cwd, "file-link"));
    const edit = await applyPatchToFiles(
      patch("*** Delete File: alias", "*** Update File: file-link\n@@\n-retained\n+changed"),
      cwd,
    );
    assert.match(edit.summary, /traverses symbolic link/);
    assert.deepEqual(edit.details.modifiedFiles, []);
    assert.equal(await readFile(join(cwd, "real/child.txt"), "utf8"), "retained\n");

    const independent = await applyPatchToFiles(
      patch("*** Delete File: alias", "*** Delete File: file-link"),
      cwd,
    );
    assert.equal(independent.details.error, undefined, independent.summary);
    await Promise.all(
      ["alias", "file-link"].map((name) => assert.rejects(lstat(join(cwd, name)), /ENOENT/)),
    );
    assert.equal(await readFile(join(cwd, "real/child.txt"), "utf8"), "retained\n");
  },
);

nodeTest(
  "a planning failure publishes no earlier file and identifies unattempted operations",
  async (t) => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, "first"), "before\n");
    await writeFile(join(cwd, "second"), "actual\n");
    const result = await applyPatchToFiles(
      patch(
        update("first", "before", "after"),
        update("second", "wrong", "after"),
        "*** Add File: third\n+new",
      ),
      cwd,
    );
    assert(result.details.error !== undefined && result.details.error.length > 0);
    assert.deepEqual(result.details.modifiedFiles, []);
    assert.deepEqual(
      result.details.files.map((file) => file.status),
      ["unattempted", "failed", "unattempted"],
    );
    assert.equal(await readFile(join(cwd, "first"), "utf8"), "before\n");
    assert.deepEqual((await readdir(cwd)).sort(), ["first", "second"]);
  },
);

nodeTest(
  "cancellation retains earlier committed receipts and never misreports a final committed write",
  async (t) => {
    const cwd = await fixture(t);
    await Promise.all(["a", "b", "c"].map((path) => writeFile(join(cwd, path), "before\n")));
    const controller = new AbortController();
    const result = await writeFiles(
      { files: ["a", "b", "c"].map((path) => ({ path, content: "after\n", mode: "replace" })) },
      cwd,
      controller.signal,
      (summary) => {
        if (summary.startsWith("Completed 1/")) {
          controller.abort();
        }
      },
    );
    assert(result.details.error !== undefined && result.details.error.length > 0);
    assert.deepEqual(result.details.modifiedFiles, [join(cwd, "a")]);
    assert.deepEqual(
      result.details.files.map((file) => file.status),
      ["applied", "failed", "unattempted"],
    );
    assert.equal(await readFile(join(cwd, "b"), "utf8"), "before\n");
    const finalAbort = new AbortController();
    const last = await writeFiles(
      { files: [{ path: "b", content: "after\n", mode: "replace" }] },
      cwd,
      finalAbort.signal,
      (summary) => {
        if (summary.startsWith("Completed")) {
          finalAbort.abort();
        }
      },
    );
    assert.equal(last.details.error, undefined, last.summary);
    assert.deepEqual(last.details.modifiedFiles, [join(cwd, "b")]);
  },
);

nodeTest(
  "compact replacements, exact writes, and unchanged receipts share the publication path",
  async (t) => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, "file"), "\uFEFFold\r\nSTART\r\nlarge body\r\nEND\r\nold\n");
    const replaced = await replaceTextInFiles(
      {
        files: [
          {
            path: "file",
            edits: [
              { oldText: "old", newText: "new", all: true },
              { oldText: "START", endText: "END", newText: "range" },
            ],
          },
        ],
      },
      cwd,
    );
    assert.equal(replaced.details.error, undefined, replaced.summary);
    assert.equal(await readFile(join(cwd, "file"), "utf8"), "\uFEFFnew\r\nrange\r\nnew\n");
    const content = "exact\nbytes\r\n";
    const exact = await writeFiles(
      { files: [{ path: "file", content, mode: "replace", preserveFormatting: false }] },
      cwd,
    );
    assert.equal(exact.details.error, undefined, exact.summary);
    assert.equal(await readFile(join(cwd, "file"), "utf8"), content);
    const unchanged = await writeFiles(
      { files: [{ path: "file", content, mode: "replace", preserveFormatting: false }] },
      cwd,
    );
    assert.equal(unchanged.details.files[0]?.status, "unchanged");
    assert.deepEqual(unchanged.details.modifiedFiles, []);
    const createConflict = await writeFiles(
      { files: [{ path: "file", content: "bad", mode: "create" }] },
      cwd,
    );
    assert(createConflict.details.error !== undefined && createConflict.details.error.length > 0);
    assert.equal(await readFile(join(cwd, "file"), "utf8"), content);
  },
);

nodeTest(
  "preview does not stage directories or delete entries and does not cache a plan",
  async (t) => {
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
    assert(applied.details.error !== undefined && applied.details.error.length > 0);
    assert.deepEqual(applied.details.modifiedFiles, []);
    assert.deepEqual(await readdir(cwd), ["file"]);
    const deletion = await applyPatchToFiles(patch("*** Delete File: file"), cwd, true);
    assert.equal(deletion.details.error, undefined, deletion.summary);
    assert.equal(await readFile(join(cwd, "file"), "utf8"), "changed\n");
  },
);

nodeTest("overlapping patch and structured calls observe invocation order", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "file"), "one\n");
  const results = await Promise.all([
    applyPatchToFiles(patch(update("file", "one", "two")), cwd),
    replaceTextInFiles(
      { files: [{ path: "file", edits: [{ oldText: "two", newText: "three" }] }] },
      cwd,
    ),
  ]);
  for (const result of results) {
    assert.equal(result.details.error, undefined, result.summary);
  }
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "three\n");
});
