import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const script = fileURLToPath(new URL("../src/macos-acl.js", import.meta.url));

async function acl(path: string): Promise<string> {
  const result = await execFile("/bin/ls", ["-lde", path], { encoding: "utf8" });
  return result.stdout.split("\n").slice(1).join("\n");
}

nodeTest(
  "macOS ACL worker validates requests before transfer and preserves valid CLI behavior",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-acl-protocol-"));
    try {
      const source = join(directory, "source");
      const target = join(directory, "target");
      await writeFile(source, "source");
      await writeFile(target, "target");
      await execFile("/bin/chmod", ["+a", "user:_www allow read", source]);
      await execFile("/bin/chmod", ["-N", target]);
      const original = await acl(target);
      const expected = await acl(source);
      assert.notEqual(expected, original);
      const valid = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", script], {
        input: `${JSON.stringify({ id: 1, mode: "copy", source, target })}\n`,
        encoding: "utf8",
      });
      assert.equal(valid.error, undefined);
      assert.equal(valid.status, 0, valid.stderr);
      const reply: unknown = JSON.parse(valid.stdout);
      assert.deepEqual(reply, { id: 1 });
      assert.equal(await acl(target), expected);
      await execFile("/bin/chmod", ["-N", target]);

      for (const request of [
        { id: "wrong", mode: "copy", source, target },
        { id: 1, mode: "wrong", source, target },
        { id: 1, mode: "copy", source: 123, target },
        { id: 1, mode: "copy", source },
      ]) {
        const invalid = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", script], {
          input: `${JSON.stringify(request)}\n`,
          encoding: "utf8",
        });
        assert.equal(invalid.error, undefined);
        assert.equal(invalid.status, 1, invalid.stderr);
        assert.match(invalid.stderr, /Invalid ACL request/u);
        assert.equal(invalid.stdout, "");
        assert.equal(await acl(target), original);
      }
      for (const args of [["copy"], ["copy", source]]) {
        const invalid = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", script, ...args], {
          encoding: "utf8",
        });
        assert.equal(invalid.error, undefined);
        assert.equal(invalid.status, 1, invalid.stderr);
        assert.match(invalid.stderr, /Expected ACL mode, source, and target/u);
        assert.equal(await acl(target), original);
      }
      const fallback = spawnSync(
        "/usr/bin/osascript",
        ["-l", "JavaScript", script, "legacy-copy", source, target],
        { encoding: "utf8" },
      );
      assert.equal(fallback.error, undefined);
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.equal(await acl(target), expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
