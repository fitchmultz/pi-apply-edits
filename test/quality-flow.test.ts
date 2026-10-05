import test from "node:test";
import { expectDiagnostics, frameworkConfig, inProbe, lint } from "./quality-probe-support.ts";

const missing = "node-test(expect-assertions)";
const conditional = "node-test(no-conditional-assertions)";
const cases = [
  {
    name: "same-named foreign assertion helper",
    body: 'import { expectDiagnostics } from "./foreign.ts"; test("empty", () => { expectDiagnostics(); });',
    expected: [[missing, 3]],
  },
  {
    name: "entry assertion survives loop back-edges",
    body: 'test("loop", () => { assert.equal(process.argv.length > 0, true); for (const value of process.argv) { console.log(value); } });',
    expected: [],
  },
  {
    name: "cohesive asynchronous lifecycle with owned cleanup",
    body: 'test("lifecycle", async () => { let state = "pending"; let closed = false; try { await Promise.resolve(); state = "running"; assert.equal(state, "running"); } finally { closed = true; } assert.equal(closed, true); });',
    expected: [],
  },
  {
    name: "early passing return",
    body: 'test("empty", () => { if (process.env.SKIP !== undefined) { return; } assert.equal(1, 1); });',
    expected: [[missing, 3]],
  },
  {
    name: "zero-iteration loop",
    body: 'test("empty", () => { for (const value of process.argv.slice(99)) { assert.equal(value, "expected"); } });',
    expected: [[missing, 3]],
  },
  {
    name: "catch-only assertion",
    body: 'test("empty", () => { try { console.log("can succeed"); } catch { assert.equal(1, 1); } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "swallowed assertion",
    body: 'test("empty", () => { try { assert.equal(1, 2); } catch { console.log("hidden failure"); } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "helper early return",
    body: 'function verify(): void { if (process.env.SKIP !== undefined) { return; } assert.equal(1, 1); } test("empty", () => { verify(); });',
    expected: [[missing, 3]],
  },
  {
    name: "named callback",
    body: 'function body(): void { console.log("empty"); } test("empty", body);',
    expected: [[missing, 3]],
  },
  {
    name: "namespace it",
    body: 'import * as runner from "node:test"; runner.it("empty", () => { console.log("empty"); });',
    expected: [[missing, 3]],
  },
  {
    name: "assertion method properties are not assertions",
    body: 'test("empty", () => { assert.equal.toString(); });',
    expected: [[missing, 3]],
  },
  {
    name: "unrelated test property",
    body: "const api = { test: (run: () => number): number => run() }; api.test(() => 42);",
    expected: [],
  },
  {
    name: "named asserting callback",
    body: 'function body(): void { assert.equal(1, 1); } test("asserted", body);',
    expected: [],
  },
  {
    name: "constant callback alias",
    body: 'const body = (): void => { assert.equal(1, 1); }; const alias = body; test("asserted", alias);',
    expected: [],
  },
  {
    name: "helper assertion ownership",
    body: 'function verify(): void { assert.equal(1, 1); } test("asserted", () => { verify(); });',
    expected: [],
  },
  {
    name: "dormant nested function",
    body: 'test("empty", () => { function dormant(): void { assert.equal(1, 1); } console.log(dormant); });',
    expected: [[missing, 3]],
  },
  {
    name: "all passing branches assert",
    body: 'test("branches", () => { if (process.env.MODE === "left") { assert.equal(1, 1); } else { assert.equal(2, 2); } });',
    expected: [
      [conditional, 3],
      [conditional, 3],
    ],
  },
  {
    name: "explicit native test skip",
    body: 'test("platform", (context) => { if (process.platform !== "darwin") { context.skip("Requires macOS"); return; } assert.equal(1, 1); });',
    expected: [],
  },
  {
    name: "unrelated skip method",
    body: 'test("empty", () => { const context = { skip: (why: string): void => { console.log(why); } }; context.skip("not native"); });',
    expected: [[missing, 3]],
  },
  {
    name: "local callback wrapper",
    body: 'function run(body: () => void): void { body(); } test("wrapped", () => { run(() => { assert.equal(1, 1); }); });',
    expected: [],
  },
  {
    name: "optional local callback wrapper",
    body: 'function run(body: () => void): void { if (process.env.SKIP === undefined) { body(); } } test("wrapped", () => { run(() => { assert.equal(1, 1); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "unconfigured foreign wrapper",
    body: 'import { inProbe } from "./foreign.ts"; test("wrapped", () => { inProbe({}, () => { assert.equal(1, 1); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "reassigned callback cannot retain assertion ownership",
    body: 'let body = (): void => { assert.equal(1, 1); }; body = (): void => { console.log("empty"); }; test("empty", body);',
    expected: [[missing, 3]],
  },
  {
    name: "cyclic callback references fail closed",
    body: 'const first = second; const second = first; test("empty", first);',
    expected: [[missing, 3]],
  },
] satisfies readonly {
  readonly name: string;
  readonly body: string;
  readonly expected: readonly (readonly [string, number])[];
}[];

for (const probe of cases) {
  test(`native scope/code-path assertion ownership: ${probe.name}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": frameworkConfig(),
        "test/probe.test.ts": `import test from "node:test";\nimport assert from "node:assert/strict";\n${probe.body}`,
        "test/foreign.ts":
          "export function inProbe(_files: unknown, _run: () => void): void {} export function expectDiagnostics(): void {}",
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["test/probe.test.ts"]),
          probe.expected,
          "test/probe.test.ts",
        );
      },
    );
  });
}

const exceptionCases = [
  {
    name: "exhaustive switch variants",
    body: 'test("variants", () => { switch (process.env.MODE) { case "left":\n// Exhaustive variants validate this distinct payload before leaving its arm.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(1, 1); break;\ndefault:\n// Exhaustive variants validate the fallback payload before leaving its arm.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(2, 2); break;\n} });',
    expected: [],
  },
  {
    name: "optional assertion with generic explanation",
    body: 'test("optional", () => { assert.equal(1, 1); if (process.env.MAYBE !== undefined) {\n// Exhaustive platform variants need this assertion boundary for their native contracts.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(2, 2);\n} });',
    expected: [["node-test(valid-exceptions)", 6]],
  },
  {
    name: "exhaustive arms",
    body: 'test("variants", () => { if (process.env.MODE === "left") {\n// Exhaustive variants validate both payloads and cannot skip their assertions.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(1, 1);\n} else {\n// Exhaustive variants validate both payloads and cannot skip their assertions.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(2, 2);\n} });',
    expected: [],
  },
  {
    name: "unconditional assertion does not make empty variant exhaustive",
    body: 'test("variants", () => { assert.equal(1, 1); if (process.env.MODE === "left") {\n// Exhaustive variants supposedly validate every payload without optional branches.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(2, 2);\n} else { console.log("unchecked payload"); } });',
    expected: [["node-test(valid-exceptions)", 6]],
  },
] satisfies readonly {
  readonly name: string;
  readonly body: string;
  readonly expected: readonly (readonly [string, number])[];
}[];

for (const probe of exceptionCases) {
  test(`conditional exception proof: ${probe.name}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": frameworkConfig(),
        "test/probe.test.ts": `import test from "node:test";\nimport assert from "node:assert/strict";\n${probe.body}`,
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["test/probe.test.ts"]),
          probe.expected,
          "test/probe.test.ts",
        );
      },
    );
  });
}
