import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { test as nodeTest } from "node:test";
import {
  effectiveConfig,
  expectDiagnostics,
  inProbe,
  lint,
  record,
} from "./quality-probe-support.ts";

const root = resolve(import.meta.dirname, "..");
const mainConfig = readFileSync(resolve(root, "tsconfig.json"), "utf8");
const declaration = readFileSync(resolve(root, "src/macos-acl-runtime.d.ts"), "utf8");
const validJxa = "function run() {\n/** @type {number} */\nconst count = 1;\nreturn count;\n}";
const projects = {
  ".oxlintrc.json": effectiveConfig(),
  "tsconfig.json": mainConfig,
  "tsconfig.jxa.json": readFileSync(resolve(root, "tsconfig.jxa.json"), "utf8"),
  "src/macos-acl-runtime.d.ts": declaration,
  "src/fs/acl-protocol.ts": readFileSync(resolve(root, "src/fs/acl-protocol.ts"), "utf8"),
  "src/macos-acl.js": validJxa,
};

function compile(directory: string, project: string): SpawnSyncReturns<string> {
  const result = spawnSync(
    resolve(root, "node_modules/.bin/tsc"),
    ["--noEmit", "--pretty", "false", "-p", project],
    {
      cwd: directory,
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  return result;
}

nodeTest(
  "the JXA entrypoint allowance retains unused-symbol checks at neighboring names and files",
  async () => {
    await inProbe(
      { ".oxlintrc.json": effectiveConfig(), "src/macos-acl.js": "function run() { return 1; }" },
      async (directory) => {
        expectDiagnostics(lint(directory, ["src/macos-acl.js"]), [], "src/macos-acl.js");
      },
    );
    await inProbe(
      {
        ".oxlintrc.json": effectiveConfig(),
        "src/macos-acl.js": "function run() { return 1; }\nfunction orphan() { return 2; }",
        "src/unrelated.js": "function run() { return 1; }",
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["src/macos-acl.js"]),
          [["eslint(no-unused-vars)", 2, 10]],
          "src/macos-acl.js",
        );
        expectDiagnostics(
          lint(directory, ["src/unrelated.js"]),
          [["eslint(no-unused-vars)", 1, 10]],
          "src/unrelated.js",
        );
      },
    );
  },
);

const contexts = [
  {
    path: "src/probe.ts",
    project: "tsconfig.json",
    invalid: 'export const count: number = "wrong";\nPromise.resolve();',
    valid: "export const count: number = 1;\nawait Promise.resolve();",
    semanticLine: 2,
    compilerError: /src\/probe\.ts\(1,14\): error TS2322:/u,
  },
  {
    path: "src/macos-acl.js",
    project: "tsconfig.jxa.json",
    invalid:
      'function run() {\n/** @type {number} */\nconst count = "wrong";\nPromise.resolve();\nreturn count;\n}',
    valid: validJxa,
    semanticLine: 4,
    compilerError: /src\/macos-acl\.js\(3,7\): error TS2322:/u,
  },
];
for (const context of contexts) {
  nodeTest(`semantic and canonical compiler gates both cover ${context.project}`, async () => {
    await inProbe({ ...projects, [context.path]: context.invalid }, async (directory) => {
      expectDiagnostics(
        lint(directory, [context.path]),
        [
          ["typescript(no-floating-promises)", context.semanticLine, 1],
          ["promise(catch-or-return)", context.semanticLine, 1],
        ],
        context.path,
      );
      const result = compile(directory, context.project);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, context.compilerError);
    });
    await inProbe({ ...projects, [context.path]: context.valid }, async (directory) => {
      expectDiagnostics(lint(directory, [context.path]), [], context.path);
      const result = compile(directory, context.project);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  });
}

nodeTest("JXA native pointer types reject an unwritten out-reference", async () => {
  await inProbe(
    { ...projects, "src/macos-acl.js": "function run() { $.acl_valid(Ref()[0]); }" },
    async (directory) => {
      const result = compile(directory, "tsconfig.jxa.json");
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /src\/macos-acl\.js\(1,30\): error TS2345:/u);
    },
  );
  await inProbe(
    {
      ...projects,
      "src/macos-acl.js":
        "function run() { const pointer = $.acl_init(0); try { return $.acl_valid(pointer); } finally { $.acl_free(pointer); } }",
    },
    async (directory) => {
      const result = compile(directory, "tsconfig.jxa.json");
      assert.equal(result.status, 0, result.stdout + result.stderr);
    },
  );
});

nodeTest(
  "the JXA declaration project checks its real handwritten bridge, not permissive substitutes",
  async () => {
    await inProbe(projects, async (directory) => {
      const result = compile(directory, "tsconfig.jxa.json");
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
    await inProbe(
      {
        ...projects,
        "src/macos-acl-runtime.d.ts": `${declaration}declare const invalid: MissingRuntimeType;\n`,
      },
      async (directory) => {
        const result = compile(directory, "tsconfig.jxa.json");
        assert.equal(result.status, 1, result.stdout + result.stderr);
        const line = declaration.split("\n").length;
        assert.match(
          result.stdout,
          new RegExp(
            `src/macos-acl-runtime\\.d\\.ts\\(${line},\\d+\\): error TS2304: Cannot find name 'MissingRuntimeType'`,
            "u",
          ),
        );
      },
    );
  },
);

nodeTest(
  "resolved compiler membership includes inherited checked JavaScript outside root globs",
  async () => {
    const config: unknown = JSON.parse(mainConfig);
    assert(record(config));
    assert(record(config.compilerOptions));
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
    assert(record(config));
    assert(record(config.compilerOptions));
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

nodeTest(
  "noImplicitReturns is enforced by the canonical compiler independently of semantic lint",
  async () => {
    await inProbe(
      {
        ...projects,
        "src/probe.ts":
          "export function incomplete(input: boolean): number | undefined { if (input) { return 1; } }",
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["src/probe.ts"]), [], "src/probe.ts");
        const result = compile(directory, "tsconfig.json");
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, /src\/probe\.ts\(1,45\): error TS7030:/u);
      },
    );
    await inProbe(
      {
        ...projects,
        "src/probe.ts":
          "export function complete(input: boolean): number | undefined { return input ? 1 : undefined; }",
      },
      async (directory) => {
        const result = compile(directory, "tsconfig.json");
        assert.equal(result.status, 0, result.stdout + result.stderr);
      },
    );
  },
);
