import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveConfig,
  expectDiagnostics,
  inProbe,
  lint,
  policyRule,
  record,
} from "./quality-probe-support.ts";

function metricConfig(rule: string): string {
  const original: unknown = JSON.parse(effectiveConfig());
  assert(record(original));
  return JSON.stringify({
    ...original,
    categories: {
      correctness: "off",
      suspicious: "off",
      perf: "off",
      restriction: "off",
      style: "off",
      pedantic: "off",
      nursery: "off",
    },
    rules: { [rule]: policyRule(rule) },
  });
}

const metrics = [
  {
    rule: "complexity",
    source: `export function choose(input: number): void { ${Array.from({ length: 10 }, (_, index) => `if (input === ${index}) { console.log(input); }`).join(" ")} }`,
    lines: [1],
  },
  {
    rule: "complexity",
    source: `export function choose(input: number): number { switch (input) { ${Array.from({ length: 20 }, (_, index) => `case ${index}: return ${index};`).join(" ")} default: return -1; } }`,
    lines: [],
  },
  {
    rule: "max-depth",
    source:
      "export function choose(input: number): void { if (input > 0) { if (input > 1) { if (input > 2) { if (input > 3) { console.log(input); } } } } }",
    lines: [1],
  },
  {
    rule: "max-params",
    source:
      "export function choose(a: number, b: number, c: number, d: number, e: number): void { console.log(a, b, c, d, e); }",
    lines: [1],
  },
  {
    rule: "max-statements",
    source: `export function write(): void {\n${Array.from({ length: 41 }, (_, index) => `console.log(${index});`).join("\n")}\n}`,
    lines: [1],
  },
  {
    rule: "max-lines-per-function",
    source: `export function write(): void {\n${Array.from({ length: 79 }, (_, index) => `console.log(${index});`).join("\n")}\n}`,
    lines: [1],
  },
  {
    rule: "max-lines",
    source: Array.from(
      { length: 501 },
      (_, index) => `export const value${index} = ${index};`,
    ).join("\n"),
    lines: [501],
  },
] satisfies readonly {
  readonly rule: string;
  readonly source: string;
  readonly lines: readonly number[];
}[];

for (const metric of metrics) {
  test(`production ${metric.rule} boundary (${metric.lines.length > 0 ? "rejected" : "allowed"})`, async () => {
    await inProbe(
      { ".oxlintrc.json": metricConfig(metric.rule), "probe.ts": metric.source },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["probe.ts"]),
          metric.lines.map((line) => [`eslint(${metric.rule})`, line]),
        );
      },
    );
  });
}

test("test helpers keep size exemptions while branching, depth and parameter limits remain active", async () => {
  await inProbe(
    {
      ".oxlintrc.json": effectiveConfig(),
      "test/size.ts": `export function lifecycle(): void {\n${Array.from({ length: 501 }, (_, index) => `console.log(${index});`).join("\n")}\n}`,
      "test/branches.ts": `export function branching(input: number): void { ${Array.from({ length: 15 }, (_, index) => `if (input === ${index}) { console.log(input); }`).join(" ")} }`,
      "test/depth.ts":
        "export function deep(input: number): void { if (input > 0) { if (input > 1) { if (input > 2) { if (input > 3) { if (input > 4) { console.log(input); } } } } } }",
      "test/params.ts":
        "export function params(a: number, b: number, c: number, d: number, e: number, f: number, g: number): void { console.log(a, b, c, d, e, f, g); }",
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["test/size.ts"]), [], "test/size.ts");
      expectDiagnostics(
        lint(directory, ["test/branches.ts"]),
        [["eslint(complexity)", 1]],
        "test/branches.ts",
      );
      expectDiagnostics(
        lint(directory, ["test/depth.ts"]),
        [["eslint(max-depth)", 1]],
        "test/depth.ts",
      );
      expectDiagnostics(
        lint(directory, ["test/params.ts"]),
        [["eslint(max-params)", 1]],
        "test/params.ts",
      );
    },
  );
});
