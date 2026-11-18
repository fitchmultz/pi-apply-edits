import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { test as nodeTest } from "node:test";
import { isRecord } from "../src/editing/contracts.ts";
import { inProbe } from "./quality-probe-support.ts";

const root = resolve(import.meta.dirname, "..");
const mainConfig = readFileSync(resolve(root, "tsconfig.json"), "utf8");

nodeTest(
  "resolved compiler membership includes inherited checked JavaScript outside root globs",
  async () => {
    const config: unknown = JSON.parse(mainConfig);
    assert(isRecord(config));
    assert(isRecord(config.compilerOptions));
    await inProbe(
      {
        "base.json": JSON.stringify({
          ...config,
          compilerOptions: { ...config.compilerOptions, allowJs: true, checkJs: true },
        }),
        "tsconfig.json": '{"extends":"./base.json","files":["consumer.ts"]}',
        "consumer.ts": 'import { value } from "./imported.js"; export const observed = value;',
        "imported.js": "export const value = 1;",
      },
      async (directory) => {
        const module = resolve(root, "scripts/compiler-projects.ts");
        const imported = realpathSync(resolve(directory, "imported.js"));
        const script = `import { compilerProjects } from ${JSON.stringify(module)}; const [project] = compilerProjects(["tsconfig.json"]); console.log(JSON.stringify({checkJs:project.checkJs, imported:project.files.has(${JSON.stringify(imported)})}));`;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: directory,
          encoding: "utf8",
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { checkJs: true, imported: true });
      },
    );
  },
);

for (const downgrade of [
  {
    option: "noUncheckedIndexedAccess",
    value: false,
    message: "tsconfig.json must retain noUncheckedIndexedAccess: true",
  },
  { option: "noCheck", value: true, message: "tsconfig.json must retain noCheck: false" },
  {
    option: "strictBindCallApply",
    value: false,
    message: "tsconfig.json must not disable strictBindCallApply",
  },
]) {
  nodeTest(`compiler inventory rejects effective ${downgrade.option} weakening`, async () => {
    const config: unknown = JSON.parse(mainConfig);
    assert(isRecord(config));
    assert(isRecord(config.compilerOptions));
    await inProbe(
      {
        "tsconfig.json": JSON.stringify({
          ...config,
          compilerOptions: { ...config.compilerOptions, [downgrade.option]: downgrade.value },
        }),
        "src/probe.ts": "export const value = 1;",
      },
      async (directory) => {
        const module = new URL("../scripts/compiler-projects.ts", import.meta.url).href;
        const script = `import { compilerProjects } from ${JSON.stringify(module)}; compilerProjects(["tsconfig.json"]);`;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: directory,
          encoding: "utf8",
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert(result.stderr.includes(downgrade.message), result.stderr);
      },
    );
  });
}
