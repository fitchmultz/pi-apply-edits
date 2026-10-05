import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import {
  effectiveConfig,
  expectDiagnostics,
  inProbe,
  lint,
  lintExecutable,
  record,
} from "./quality-probe-support.ts";

const floating = "typescript(no-floating-promises)";
const chain = "promise(catch-or-return)";

test("effective scope covers TypeScript, inherited checkJs and per-file ts-check without semantic lint on unchecked JXA", async () => {
  await inProbe(
    {
      ".oxlintrc.json": effectiveConfig(),
      "base.json":
        '{"compilerOptions":{"strict":true,"allowJs":true,"checkJs":false,"noEmit":true,"target":"ES2024","module":"NodeNext","moduleResolution":"NodeNext","types":["node"]}}',
      "tsconfig.json": '{"extends":"./base.json","include":["**/*.ts","**/*.js"]}',
      "checked/tsconfig.json":
        '{"extends":"../base.json","compilerOptions":{"checkJs":true},"include":["*.js"]}',
      "probe.ts": "Promise.resolve();",
      "checked/probe.js": "Promise.resolve();",
      "directive.js": "// @ts-check\nPromise.resolve();",
      "src/macos-acl.js":
        'Promise.resolve();\nif (Math.random() > 0.5) console.log("syntax remains checked");',
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [
        [floating, 1],
        [chain, 1],
      ]);
      expectDiagnostics(
        lint(directory, ["checked/probe.js"]),
        [
          [floating, 1],
          [chain, 1],
        ],
        "checked/probe.js",
      );
      expectDiagnostics(
        lint(directory, ["directive.js"]),
        [
          [floating, 2],
          [chain, 2],
        ],
        "directive.js",
      );
      expectDiagnostics(
        lint(directory, ["src/macos-acl.js"]),
        [
          [chain, 1],
          ["eslint(curly)", 2],
        ],
        "src/macos-acl.js",
      );
    },
  );
});

test("unchecked JavaScript stays available for checked consumer-side safety", async () => {
  await inProbe(
    {
      ".oxlintrc.json": effectiveConfig(),
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"allowJs":true,"checkJs":false,"noEmit":true,"target":"ES2024","module":"NodeNext","moduleResolution":"NodeNext","types":["node"]},"include":["**/*.ts","**/*.js"]}',
      "src/macos-acl.js": 'export function read() { return JSON.parse("{}"); }',
      "probe.ts":
        'import { read } from "./src/macos-acl.js";\nexport const output: string = read();',
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [["typescript(no-unsafe-assignment)", 2]]);
      expectDiagnostics(lint(directory, ["src/macos-acl.js"]), [], "src/macos-acl.js");
    },
  );
});

test("unchecked JavaScript tests retain assertion, Promise and test complexity checks without semantic rules", async () => {
  const configuration: unknown = JSON.parse(effectiveConfig());
  assert(record(configuration));
  assert(Array.isArray(configuration.overrides));
  const language: unknown = configuration.overrides.find(
    (value: unknown) =>
      record(value) && Array.isArray(value.files) && value.files.includes("src/macos-acl.js"),
  );
  assert(record(language));
  const overrides: readonly unknown[] = configuration.overrides;
  const config = JSON.stringify({
    ...configuration,
    overrides: [...overrides, { ...language, files: ["test/probe.test.js"] }],
  });
  await inProbe(
    {
      ".oxlintrc.json": config,
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"allowJs":true,"checkJs":false,"noEmit":true,"target":"ES2024","module":"NodeNext","moduleResolution":"NodeNext","types":["node"]},"include":["**/*.ts","**/*.js"]}',
      "test/probe.test.js":
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("unchecked", () => { Promise.resolve(); assert.equal(1, 1); });\nexport function branches(input) { ' +
        Array.from(
          { length: 15 },
          (_, index) => `if (input === ${index}) { console.log(input); }`,
        ).join(" ") +
        " }",
    },
    async (directory) => {
      expectDiagnostics(
        lint(directory, ["test/probe.test.js"]),
        [
          [chain, 3],
          ["eslint(complexity)", 4],
        ],
        "test/probe.test.js",
      );
    },
  );
});

test("compiler diagnostics are separate from semantic lint and respect checked-JavaScript ownership", async () => {
  const compilerOnly = JSON.stringify({
    plugins: ["typescript"],
    categories: { correctness: "off" },
    options: { typeAware: true, typeCheck: true },
  });
  await inProbe(
    {
      ".oxlintrc.json": compilerOnly,
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"allowJs":true,"checkJs":false,"noEmit":true,"target":"ES2024","module":"NodeNext","moduleResolution":"NodeNext","types":["node"]},"include":["**/*.ts","**/*.js"]}',
      "probe.ts": 'export const count: number = "wrong";',
      "checked.js": '// @ts-check\n/** @type {number} */\nexport const count = "wrong";',
      "unchecked.js": '/** @type {number} */\nexport const count = "wrong";',
      "late.js": 'export {};\n// @ts-check\n/** @type {number} */\nexport const count = "wrong";',
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [["typescript(TS2322)", 1]]);
      expectDiagnostics(lint(directory, ["checked.js"]), [["typescript(TS2322)", 3]], "checked.js");
      expectDiagnostics(lint(directory, ["unchecked.js"]), [], "unchecked.js");
      expectDiagnostics(lint(directory, ["late.js"]), [], "late.js");
    },
  );
});

test("compiler scope includes checked imported JavaScript outside root-file globs", async () => {
  const module = resolve(import.meta.dirname, "../scripts/compiler-projects.ts");
  await inProbe(
    {
      "base.json":
        '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"allowJs":true,"checkJs":true,"noEmit":true,"skipLibCheck":true,"module":"NodeNext","moduleResolution":"NodeNext"}}',
      "tsconfig.json": '{"extends":"./base.json","files":["consumer.ts"]}',
      "consumer.ts": 'import { value } from "./imported.js"; export const observed = value;',
      "imported.js": "export const value = 1;",
    },
    async (directory) => {
      const script = `import { compilerProjects } from ${JSON.stringify(module)}; const [project] = compilerProjects(["tsconfig.json"]); console.log(JSON.stringify({checkJs:project.checkJs, imported:project.files.has(${JSON.stringify(realpathSync(resolve(directory, "imported.js")))})}));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { checkJs: true, imported: true });
    },
  );
});

test("the compiler keeps noImplicitReturns independently of lint return-path policy", async () => {
  await inProbe(
    {
      ".oxlintrc.json": JSON.stringify({
        plugins: ["typescript"],
        categories: { correctness: "off" },
        options: { typeAware: true, typeCheck: true },
      }),
      "probe.ts":
        "export function incomplete(input: boolean): number | undefined { if (input) { return 1; } }",
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [["typescript(TS7030)", 1]]);
    },
  );
});

test("unchecked language override disables every installed type-aware rule, not just selected namespaces", async () => {
  const metadataResult = spawnSync(lintExecutable, ["--rules", "--format=json"], {
    encoding: "utf8",
  });
  assert.equal(metadataResult.status, 0, metadataResult.stderr);
  const metadata: unknown = JSON.parse(metadataResult.stdout);
  assert(Array.isArray(metadata));
  const configuration: unknown = JSON.parse(effectiveConfig());
  assert(record(configuration));
  assert(Array.isArray(configuration.overrides));
  const language: unknown = configuration.overrides.find(
    (value: unknown) =>
      record(value) && Array.isArray(value.files) && value.files.includes("src/macos-acl.js"),
  );
  assert(record(language));
  assert(record(language.rules));
  for (const rule of metadata) {
    assert(record(rule));
    if (rule.type_aware !== true) {
      continue;
    }
    assert.equal(typeof rule.scope, "string");
    assert.equal(typeof rule.value, "string");
    if (typeof rule.scope !== "string" || typeof rule.value !== "string") {
      throw new Error("Invalid rule metadata");
    }
    assert.equal(
      language.rules[`${rule.scope}/${rule.value}`],
      "off",
      `Unchecked JavaScript acquired ${rule.scope}/${rule.value}`,
    );
  }
});
