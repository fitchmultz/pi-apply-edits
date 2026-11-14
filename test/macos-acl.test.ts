import assert from "node:assert/strict";
import nodeChildProcess, {
  execFile as execFileCallback,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import {
  MacosAclSession,
  releaseMacosAclHelper,
  retainMacosAclHelper,
} from "../src/fs/macos-acl.ts";

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

nodeTest(
  "duplicate retains for one owner still end the idle helper on release",
  { skip: process.platform !== "darwin", timeout: 20_000 },
  async (t) => {
    const helpers: ChildProcess[] = [];
    const originalSpawn = nodeChildProcess.spawn;
    const spawn = t.mock.method(
      nodeChildProcess,
      "spawn",
      (...args: Readonly<[string, readonly string[]]>) => {
        const child = originalSpawn(...args);
        if (args[0] === "/usr/bin/osascript") {
          helpers.push(child);
        }
        return child;
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      spawn.mock.restore();
      syncBuiltinESMExports();
    });
    const directory = await mkdtemp(join(tmpdir(), "pi-acl-retain-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, "source");
    const target = join(directory, "target");
    await writeFile(source, "source");
    await writeFile(target, "target");
    await execFile("/bin/chmod", ["+a", "user:_www allow read", source]);
    const owner = {};
    // Pi can start one run's loop more than once; retains for the same owner are idempotent.
    retainMacosAclHelper(owner);
    retainMacosAclHelper(owner);
    const session = new MacosAclSession();
    await session.run(() => session.transfer("copy", source, target));
    await session.close();
    assert.equal(helpers.length, 1);
    const helper = helpers[0];
    assert(helper !== undefined);
    await releaseMacosAclHelper(owner);
    const deadline = Date.now() + 5_000;
    while (helper.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    assert.equal(helper.exitCode, 0);
  },
);

nodeTest(
  "retained macOS ACL helper resets its idle timer on reuse, exits after 15s idle, and restarts on demand",
  { skip: process.platform !== "darwin", timeout: 20_000 },
  async (t) => {
    const helpers: ChildProcess[] = [];
    const originalSpawn = nodeChildProcess.spawn;
    const spawn = t.mock.method(
      nodeChildProcess,
      "spawn",
      (...args: Readonly<[string, readonly string[]]>) => {
        const child = originalSpawn(...args);
        if (args[0] === "/usr/bin/osascript") {
          helpers.push(child);
        }
        return child;
      },
    );
    syncBuiltinESMExports();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const directory = await mkdtemp(join(tmpdir(), "pi-acl-idle-"));
    const owner = {};
    t.after(async () => {
      t.mock.timers.reset();
      await releaseMacosAclHelper(owner);
      spawn.mock.restore();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    });
    const source = join(directory, "source");
    const target1 = join(directory, "target-1");
    const target2 = join(directory, "target-2");
    const target3 = join(directory, "target-3");
    await writeFile(source, "source");
    await writeFile(target1, "target-1");
    await writeFile(target2, "target-2");
    await writeFile(target3, "target-3");
    await execFile("/bin/chmod", ["+a", "user:_www allow read", source]);
    await execFile("/bin/chmod", ["-N", target3]);
    const expected = await acl(source);

    retainMacosAclHelper(owner);
    const firstSession = new MacosAclSession();
    await firstSession.run(() => firstSession.transfer("copy", source, target1));
    await firstSession.close();
    assert.equal(helpers.length, 1);
    const first = helpers[0];
    assert(first !== undefined);
    assert.equal(first.exitCode, null);

    t.mock.timers.tick(10_000);
    assert.equal(first.exitCode, null);
    const secondSession = new MacosAclSession();
    await secondSession.run(() => secondSession.transfer("copy", source, target2));
    await secondSession.close();
    assert.equal(helpers.length, 1);

    t.mock.timers.tick(10_000);
    await setImmediate();
    assert.equal(first.exitCode, null);

    t.mock.timers.tick(5_000);
    await once(first, "close", { signal: AbortSignal.timeout(2_000) });
    assert.equal(first.exitCode, 0);

    const thirdSession = new MacosAclSession();
    await thirdSession.run(() => thirdSession.transfer("copy", source, target3));
    await thirdSession.close();
    assert.equal(helpers.length, 2);
    assert.equal(await acl(target3), expected);
    const second = helpers[1];
    assert(second !== undefined);
    assert.equal(second.exitCode, null);

    t.mock.timers.tick(15_000);
    await releaseMacosAclHelper(owner);
    assert.equal(second.exitCode, 0);
  },
);
