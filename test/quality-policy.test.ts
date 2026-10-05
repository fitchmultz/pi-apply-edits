import assert from "node:assert/strict";
import test from "node:test";
import { checkSuppressions } from "../scripts/suppression-policy.ts";
import { checkLanguageScope } from "../scripts/language-policy.ts";
import {
  effectiveConfig,
  expectDiagnostics,
  focusedConfig,
  inProbe,
  lint,
  policyRule,
} from "./quality-probe-support.ts";

const directives = [
  {
    source: 'export const fixture = "// oxlint-disable no-floating-promises";',
    path: "src/probe.ts",
    count: 0,
  },
  { source: '// oxlint-disable\nconsole.log("hidden");', path: "src/probe.ts", count: 1 },
  {
    source: '// eslint-disable-next-line no-await-in-loop\nconsole.log("legacy");',
    path: "src/probe.ts",
    count: 1,
  },
  { source: '// @ts-ignore\nconsole.log("hidden");', path: "src/probe.ts", count: 1 },
  { source: '// @ts-nocheck\nconsole.log("hidden");', path: "src/probe.ts", count: 1 },
  {
    source: '// @ts-expect-error the parameter is intentionally invalid\nconsole.log("hidden");',
    path: "src/probe.ts",
    count: 1,
  },
  {
    source: '// @ts-expect-error invalid parameter must be rejected\nconsole.log("type test");',
    path: "test/probe.test-d.ts",
    count: 0,
  },
  {
    source: '// @ts-expect-error short\nconsole.log("type test");',
    path: "test/probe.test-d.ts",
    count: 1,
  },
  {
    source: '// oxlint-disable-next-line no-await-in-loop\nconsole.log("unexplained");',
    path: "src/probe.ts",
    count: 1,
  },
  {
    source:
      "// The journal must commit each entry before its dependent successor.\n// oxlint-disable-next-line no-await-in-loop\nawait Promise.resolve();",
    path: "src/probe.ts",
    count: 0,
  },
  {
    source:
      "// This native single-line field rejects all escaped C0 controls and DEL.\n// oxlint-disable-next-line no-control-regex\nconst pattern = /[\\u0000-\\u001F\\u007F]/u;",
    path: "src/probe.ts",
    count: 0,
  },
  {
    source:
      "// The journal must commit each entry before its dependent successor.\n// oxlint-disable-next-line typescript/no-floating-promises\nPromise.resolve();",
    path: "src/probe.ts",
    count: 1,
  },
  {
    source:
      "// Callback results alone trigger the generic callable checker limitation.\n// oxlint-disable-next-line typescript/prefer-readonly-parameter-types\nfunction invoke<T>(operation: () => T): T { return operation(); }",
    path: "src/probe.ts",
    count: 0,
  },
  {
    source:
      "async function work(signal: AbortSignal): Promise<void> {\n// A cancellation callback can mutate the signal while the await is suspended.\n// oxlint-disable-next-line typescript/no-unnecessary-condition\nif (signal.aborted) { return; }\n}",
    path: "src/probe.ts",
    count: 0,
  },
  {
    source:
      "if (Math.random() > 0.5) {\n// All platform variants assert their distinct supported behavior exhaustively.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(output, expected);\n} else { assert.equal(output, fallback); }",
    path: "test/probe.test.ts",
    count: 0,
  },
  {
    source:
      '// All platform variants assert their distinct supported behavior exhaustively.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nconsole.log("not a test");',
    path: "src/probe.ts",
    count: 1,
  },
] satisfies readonly { readonly source: string; readonly path: string; readonly count: number }[];

for (const [index, directive] of directives.entries()) {
  test(`comment-aware suppression policy case ${index}`, () => {
    assert.equal(checkSuppressions(directive.path, directive.source).length, directive.count);
  });
}

test("language inventory fails closed on new unassigned source without reducing intentional checked JavaScript", () => {
  assert.equal(
    checkLanguageScope("src/new.ts", "export const value = 1;", { assigned: false, checkJs: false })
      .length,
    1,
  );
  assert.equal(
    checkLanguageScope("src/new.js", "export const value = 1;", { assigned: true, checkJs: true })
      .length,
    0,
  );
  assert.equal(
    checkLanguageScope("src/new.js", "// @ts-check\nexport const value = 1;", {
      assigned: true,
      checkJs: false,
    }).length,
    0,
  );
  assert.equal(
    checkLanguageScope("src/new.js", "export const value = 1;", { assigned: true, checkJs: false })
      .length,
    1,
  );
  assert.equal(
    checkLanguageScope("src/macos-acl.js", "// @ts-check\nexport const value = 1;", {
      assigned: true,
      checkJs: false,
    }).length,
    1,
  );
});

const readonlySuppressionCases = [
  {
    code: "export function invoke<T>(callback: () => T): T { return callback(); } export type Bad = (state: { value: number }) => void;",
    count: 1,
  },
  {
    code: "export function invoke<T>(callback: () => T): (state: { value: number }) => T {\n  return (state) => { console.log(state.value); return callback(); };\n}",
    count: 1,
  },
  {
    code: "export function invoke<T>(callback: () => T): T { function unsafe(input: { value: number }): void { console.log(input); } unsafe({ value: 0 }); return callback(); }",
    count: 1,
  },
  {
    code: "export function invoke<T>(callback: (state: { value: number }) => T): T { return callback({ value: 0 }); }",
    count: 1,
  },
  {
    code: "export function invoke<T>(callback: (() => T) & { state: number }): T { return callback(); }",
    count: 1,
  },
  {
    code: 'export function invoke<T>(state: { value: number }): () => T { throw new Error("not a callback parameter"); }',
    count: 1,
  },
  {
    code: "export function invoke<T>(callback: () => T, state: { value: number }): T { console.log(state); return callback(); }",
    count: 1,
  },
  { code: "export const invoke = <T>(callback: () => T): T => callback();", count: 0 },
] satisfies readonly { readonly code: string; readonly count: number }[];
for (const [index, probe] of readonlySuppressionCases.entries()) {
  test(`readonly directive protects actual callback parameter shape ${index}`, () => {
    const source = `// This plain generic callback result needs the isolated checker limitation exception.\n// oxlint-disable-next-line typescript/prefer-readonly-parameter-types\n${probe.code}`;
    assert.equal(checkSuppressions("src/probe.ts", source).length, probe.count);
  });
}

test("language classification recognizes only effective leading pragmas and inherited JXA checking", () => {
  const project = { assigned: true, checkJs: false };
  assert.equal(
    checkLanguageScope("src/probe.js", "export const n = 1;\n// @ts-check", project).length,
    1,
  );
  assert.equal(
    checkLanguageScope("src/probe.js", "/* @ts-check */\nexport const n = 1;", project).length,
    1,
  );
  assert.equal(
    checkLanguageScope("src/macos-acl.js", "export const n = 1;", { assigned: true, checkJs: true })
      .length,
    1,
  );
  assert.equal(
    checkSuppressions("src/probe.ts", "/**\n * @ts-nocheck\n */\nexport const n = 1;").length,
    1,
  );
});

const signatureSites = [
  { code: "export function invoke<T>(callback: () => T): T { return callback(); }", findings: 0 },
  {
    code: "export function invoke<T>(callback: () => T): (state: { value: number }) => T {\n  return (state) => { console.log(state.value); return callback(); };\n}",
    findings: 1,
  },
  {
    code: "export function invoke<T>(callback: () => T): T { return callback(); } export type Bad = (state: { value: number }) => void;",
    findings: 1,
  },
] satisfies readonly { readonly code: string; readonly findings: number }[];
for (const [index, probe] of signatureSites.entries()) {
  test(`installed readonly directive cannot hide signature inputs ${index}`, async () => {
    const source = `// This generic callback result needs its isolated readonly checker exception.\n// oxlint-disable-next-line typescript/prefer-readonly-parameter-types\n${probe.code}`;
    assert.equal(checkSuppressions("src/probe.ts", source).length, probe.findings);
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig({
          "typescript/prefer-readonly-parameter-types": policyRule(
            "typescript/prefer-readonly-parameter-types",
          ),
        }),
        "src/probe.ts": source,
      },
      async (directory) => {
        // The native line directive hides all sites; the independent policy must reject unsafe signatures.
        expectDiagnostics(lint(directory, ["src/probe.ts"]), [], "src/probe.ts");
      },
    );
  });
}

const assertionCases = [
  {
    body: 'test("empty", () => { console.log(assert); });',
    expected: [["node-test(expect-assertions)", 3]],
  },
  { body: 'test("asserted", () => { assert.equal(1, 1); });', expected: [] },
  {
    body: 'test("conditional", () => { if (Math.random() > 0.5) { assert.equal(1, 1); } });',
    expected: [
      ["node-test(no-conditional-assertions)", 3],
      ["node-test(expect-assertions)", 3],
    ],
  },
  {
    body: 'test("fail-fast", () => { const result = { type: "message", content: "ok" }; if (result.type !== "message") { throw new Error("Wrong variant"); } assert.equal(result.content, "ok"); });',
    expected: [],
  },
  {
    body: 'test("hard-discriminator", () => { const result = { type: "message", content: "ok" }; const type = result.type; assert.equal(type, "message"); if (type === "message") { assert.equal(result.content, "ok"); } });',
    expected: [["typescript(no-unnecessary-condition)", 3]],
  },
  {
    body: 'test("mutated-discriminator", () => { const result = { type: "message", content: "ok" }; assert.equal(result.type, "message"); result.type = "other"; if (result.type === "message") { assert.equal(result.content, "ok"); } });',
    expected: [["node-test(no-conditional-assertions)", 3]],
  },
  {
    body: 'test("dormant", () => { const neverRun = (): void => { assert.equal(1, 1); }; console.log(neverRun); });',
    expected: [["node-test(expect-assertions)", 3]],
  },
  {
    body: 'function verify(value: number): void { assert.equal(value, 1); } test("helper", () => { verify(1); });',
    expected: [],
  },
] satisfies readonly {
  readonly body: string;
  readonly expected: readonly (readonly [string, number])[];
}[];

for (const [index, probe] of assertionCases.entries()) {
  test(`node:test assertion ownership case ${index}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": effectiveConfig(),
        "test/probe.test.ts": `import test from "node:test";\nimport assert from "node:assert/strict";\n${probe.body}`,
      },
      async (directory) => {
        const result = lint(directory, ["test/probe.test.ts"]);
        // Ordinary non-assertion diagnostics are never hidden by this framework probe.
        expectDiagnostics(result, probe.expected, "test/probe.test.ts");
      },
    );
  });
}
