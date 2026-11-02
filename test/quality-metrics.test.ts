import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
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
    allowed: 9,
    rejectedLine: 1,
    source: (count: number): string =>
      `export function choose(input: number): void { ${Array.from({ length: count }, (_, index) => `if (input === ${index}) { console.log(input); }`).join(" ")} }`,
  },
  {
    rule: "max-depth",
    allowed: 3,
    rejectedLine: 1,
    source: (count: number): string =>
      `export function choose(input: number): void { ${Array.from({ length: count }, (_, index) => `if (input > ${index}) {`).join(" ")} console.log(input); ${"}".repeat(count)} }`,
  },
  {
    rule: "max-params",
    allowed: 4,
    rejectedLine: 1,
    source: (count: number): string => {
      const names = Array.from({ length: count }, (_, index) => `p${index}`);
      return `export function choose(${names.map((name) => `${name}: number`).join(", ")}): void { console.log(${names.join(", ")}); }`;
    },
  },
  {
    rule: "max-statements",
    allowed: 40,
    rejectedLine: 1,
    source: (count: number): string =>
      `export function write(): void {\n${Array.from({ length: count }, (_, index) => `console.log(${index});`).join("\n")}\n}`,
  },
  {
    rule: "max-lines-per-function",
    allowed: 78,
    rejectedLine: 1,
    source: (count: number): string =>
      `export function write(): void {\n${Array.from({ length: count }, (_, index) => `console.log(${index});`).join("\n")}\n}`,
  },
  {
    rule: "max-lines",
    allowed: 500,
    rejectedLine: 501,
    source: (count: number): string =>
      Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`).join(
        "\n",
      ),
  },
];
for (const metric of metrics) {
  for (const probe of [
    { name: "allowed", count: metric.allowed, lines: [] },
    { name: "rejected", count: metric.allowed + 1, lines: [metric.rejectedLine] },
  ]) {
    nodeTest(`production ${metric.rule} boundary (${probe.name})`, async () => {
      await inProbe(
        { ".oxlintrc.json": metricConfig(metric.rule), "probe.ts": metric.source(probe.count) },
        async (directory) => {
          expectDiagnostics(
            lint(directory, ["probe.ts"]),
            probe.lines.map((line) => [`eslint(${metric.rule})`, line]),
          );
        },
      );
    });
  }
}

nodeTest("production function-line limits include IIFEs", async () => {
  await inProbe(
    {
      ".oxlintrc.json": metricConfig("max-lines-per-function"),
      "valid.ts": `(() => {\n${Array.from({ length: 78 }, (_, index) => `console.log(${index});`).join("\n")}\n})();`,
      "probe.ts": `(() => {\n${Array.from({ length: 79 }, (_, index) => `console.log(${index});`).join("\n")}\n})();`,
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["valid.ts"]), [], "valid.ts");
      expectDiagnostics(lint(directory, ["probe.ts"]), [["eslint(max-lines-per-function)", 1]]);
    },
  );
});

nodeTest("modified complexity counts a multi-case switch as one branch", async () => {
  await inProbe(
    {
      ".oxlintrc.json": metricConfig("complexity"),
      "probe.ts": `export function choose(input: number): number { switch (input) { ${Array.from({ length: 20 }, (_, index) => `case ${index}: return ${index};`).join(" ")} default: return -1; } }`,
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), []);
    },
  );
});

nodeTest(
  "test helpers keep size exemptions while branching, depth and parameter limits remain active",
  async () => {
    await inProbe(
      {
        ".oxlintrc.json": effectiveConfig(),
        "test/size.ts": `export function lifecycle(): void {\n${Array.from({ length: 501 }, (_, index) => `console.log(${index});`).join("\n")}\n}`,
        "test/branches-valid.ts": `export function branching(input: number): void { ${Array.from({ length: 14 }, (_, index) => `if (input === ${index}) { console.log(input); }`).join(" ")} }`,
        "test/depth-valid.ts":
          "export function deep(input: number): void { if (input > 0) { if (input > 1) { if (input > 2) { if (input > 3) { console.log(input); } } } } }",
        "test/params-valid.ts":
          "export function params(a: number, b: number, c: number, d: number, e: number, f: number): void { console.log(a, b, c, d, e, f); }",
        "test/branches.ts": `export function branching(input: number): void { ${Array.from({ length: 15 }, (_, index) => `if (input === ${index}) { console.log(input); }`).join(" ")} }`,
        "test/depth.ts":
          "export function deep(input: number): void { if (input > 0) { if (input > 1) { if (input > 2) { if (input > 3) { if (input > 4) { console.log(input); } } } } } }",
        "test/params.ts":
          "export function params(a: number, b: number, c: number, d: number, e: number, f: number, g: number): void { console.log(a, b, c, d, e, f, g); }",
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["test/size.ts"]), [], "test/size.ts");
        expectDiagnostics(
          lint(directory, ["test/branches-valid.ts"]),
          [],
          "test/branches-valid.ts",
        );
        expectDiagnostics(lint(directory, ["test/depth-valid.ts"]), [], "test/depth-valid.ts");
        expectDiagnostics(lint(directory, ["test/params-valid.ts"]), [], "test/params-valid.ts");
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
  },
);
