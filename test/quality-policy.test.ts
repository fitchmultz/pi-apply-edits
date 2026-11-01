import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { checkSuppressions } from "../scripts/suppression-policy.ts";
import { checkLanguageScope, checkSourceProfiles } from "../scripts/language-policy.ts";
import { effectiveConfig, expectDiagnostics, inProbe, lint } from "./quality-probe-support.ts";

const unauthorized = "Unauthorized directive: use a recorded QX ID at its exact file and operation";
const compilerSuppression = "Compiler suppression is forbidden in maintained source";
const expectedError =
  "Expected compiler errors require a dedicated type test and a description of at least 10 characters";
const directives = [
  {
    source: 'export const fixture = "// oxlint-disable no-floating-promises";',
    path: "src/probe.ts",
    expected: [],
  },
  {
    source: '// oxlint-disable\nconsole.log("hidden");',
    path: "src/probe.ts",
    expected: [unauthorized],
  },
  {
    source: '// eslint-disable-next-line no-await-in-loop\nconsole.log("legacy");',
    path: "src/probe.ts",
    expected: [unauthorized],
  },
  {
    source: '// @ts-ignore\nconsole.log("hidden");',
    path: "src/probe.ts",
    expected: [compilerSuppression],
  },
  {
    source: "/**\n * @ts-nocheck\n */\nexport const value = 1;",
    path: "src/probe.ts",
    expected: [compilerSuppression],
  },
  {
    source: '// @ts-expect-error invalid parameter must be rejected\nconsole.log("hidden");',
    path: "src/probe.ts",
    expected: [expectedError],
  },
  {
    source: '// @ts-expect-error invalid parameter must be rejected\nconsole.log("type test");',
    path: "test/probe.test-d.ts",
    expected: [],
  },
  {
    source: '// @ts-expect-error short\nconsole.log("type test");',
    path: "test/probe.test-d.ts",
    expected: [expectedError],
  },
  {
    source:
      "// oxlint-disable-next-line no-await-in-loop -- QX-001: Intentional sequencing.\nawait Promise.resolve();",
    path: "src/probe.ts",
    expected: [unauthorized],
  },
  {
    source:
      "// oxlint-disable-next-line max-params, complexity -- QX-002: Public API.\nexport function read(): void {}",
    path: "src/probe.ts",
    expected: [unauthorized],
  },
] satisfies readonly {
  readonly source: string;
  readonly path: string;
  readonly expected: readonly string[];
}[];

for (const [index, directive] of directives.entries()) {
  nodeTest(`comment-aware suppression policy case ${index}`, () => {
    assert.deepEqual(
      checkSuppressions(directive.path, directive.source).map((finding) => finding.message),
      directive.expected,
    );
  });
}

nodeTest(
  "exception authorization binds the actual file and operation, not ID or total count",
  () => {
    const path = "src/apply-edits.ts";
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.deepEqual(checkSuppressions(path, source), []);
    assert.match(
      checkSuppressions("src/copied.ts", source)[0]?.message ?? "",
      /Unauthorized directive/u,
    );
    const moved = source.replace("async function applyPatchToFiles(", "async function movedPatch(");
    assert.match(checkSuppressions(path, moved)[0]?.message ?? "", /Unauthorized directive/u);
    const replaced = source.replace("-- QX-002:", "-- QX-999:");
    assert.match(checkSuppressions(path, replaced)[0]?.message ?? "", /Unauthorized directive/u);
    const start = source.indexOf("// oxlint-disable-next-line max-params");
    const signature = source.slice(start, source.indexOf("{\n", start));
    const duplicate = `${source}\nnamespace Copied {\n${signature}{ throw new Error("fixture"); }\n}`;
    const findings = checkSuppressions(path, duplicate);
    assert.equal(
      findings.some((finding) => finding.message.startsWith("Cannot audit invalid source")),
      false,
    );
    assert.match(findings[0]?.message ?? "", /Stale or duplicated QX-002.*expected 1, found 2/u);
    const stale = source.replace(/\/\/ oxlint-disable-next-line max-params[^\n]*\n/u, "");
    assert.match(checkSuppressions(path, stale)[0]?.message ?? "", /Stale or duplicated QX-002/u);
  },
);

nodeTest(
  "the native unused-disable check rejects an authorized ID on a compliant operation",
  async () => {
    await inProbe(
      {
        ".oxlintrc.json": effectiveConfig(),
        "probe.ts":
          "// oxlint-disable-next-line max-params -- QX-002: Preserve the public positional editing API.\nexport function read(value: number): number { return value; }",
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["probe.ts"]), [
          ["Unused oxlint-disable directive (no problems were reported).", 1, 1],
        ]);
      },
    );
  },
);

nodeTest(
  "every maintained language needs project-wide checking and new source fails closed",
  () => {
    assert.deepEqual(checkLanguageScope("src/new.ts", { assigned: true, checkJs: false }), []);
    assert.match(
      checkLanguageScope("src/new.ts", { assigned: false, checkJs: false })[0]?.message ?? "",
      /must belong to a checked compiler project/u,
    );
    assert.deepEqual(checkLanguageScope("src/macos-acl.js", { assigned: true, checkJs: true }), []);
    assert.match(
      checkLanguageScope("src/macos-acl.js", { assigned: true, checkJs: false })[0]?.message ?? "",
      /project-wide allowJs and checkJs/u,
    );
  },
);

const imports = [
  'import { value } from "../test/support.ts";',
  'export { value } from "../test/support.ts";',
  'export * from "../test/support.ts";',
  'export const value = import("../test/support.ts");',
];
for (const source of imports) {
  nodeTest(`production cannot acquire test-only coverage through ${source}`, () => {
    assert.deepEqual(checkSourceProfiles("test/consumer.ts", source), []);
    assert.deepEqual(checkSourceProfiles("src/consumer.ts", source.replace("../test/", "./")), []);
    assert.match(
      checkSourceProfiles("src/consumer.ts", source)[0]?.message ?? "",
      /Production source cannot depend on test-only support/u,
    );
  });
}

const assertionCases = [
  {
    body: 'nodeTest("empty", () => { console.log(assert); });',
    expected: [["node-test(expect-assertions)", 3]],
  },
  { body: 'nodeTest("asserted", () => { assert.equal(1, 1); });', expected: [] },
  {
    body: 'nodeTest("conditional", () => { if (Math.random() > 0.5) { assert.equal(1, 1); } });',
    expected: [
      ["node-test(no-conditional-assertions)", 3],
      ["node-test(expect-assertions)", 3],
    ],
  },
  {
    body: 'nodeTest("fail-fast", () => { const result = { type: "message", content: "ok" }; if (result.type !== "message") { throw new Error("Wrong variant"); } assert.equal(result.content, "ok"); });',
    expected: [],
  },
  {
    body: 'nodeTest("hard-discriminator", () => { const result = { type: "message", content: "ok" }; const type = result.type; assert.equal(type, "message"); if (type === "message") { assert.equal(result.content, "ok"); } });',
    expected: [["typescript(no-unnecessary-condition)", 3]],
  },
  {
    body: 'nodeTest("mutated-discriminator", () => { const result = { type: "message", content: "ok" }; assert.equal(result.type, "message"); result.type = "other"; if (result.type === "message") { assert.equal(result.content, "ok"); } });',
    expected: [["node-test(no-conditional-assertions)", 3]],
  },
  {
    body: 'nodeTest("dormant", () => { const neverRun = (): void => { assert.equal(1, 1); }; console.log(neverRun); });',
    expected: [["node-test(expect-assertions)", 3]],
  },
  {
    body: 'function verify(value: number): void { assert.equal(value, 1); } nodeTest("helper", () => { verify(1); });',
    expected: [],
  },
] satisfies readonly {
  readonly body: string;
  readonly expected: readonly (readonly [string, number])[];
}[];

for (const [index, probe] of assertionCases.entries()) {
  nodeTest(`node:test assertion ownership case ${index}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": effectiveConfig(),
        "test/probe.test.ts": `import { test as nodeTest } from "node:test";\nimport assert from "node:assert/strict";\n${probe.body}`,
      },
      async (directory) => {
        const result = lint(directory, ["test/probe.test.ts"]);
        // Ordinary non-assertion diagnostics are never hidden by this framework probe.
        expectDiagnostics(result, probe.expected, "test/probe.test.ts");
      },
    );
  });
}
