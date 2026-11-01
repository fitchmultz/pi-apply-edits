import { test as nodeTest } from "node:test";
import {
  expectDiagnostics,
  focusedConfig,
  inProbe,
  lint,
  policyRule,
} from "./quality-probe-support.ts";

nodeTest(
  "registration allowance keeps all six ownership controls and typed shadows isolated",
  async () => {
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig({
          "typescript/no-floating-promises": policyRule("typescript/no-floating-promises"),
        }),
        "probe.ts": [
          'import { test as nodeTest, describe } from "node:test";',
          'nodeTest("registration", () => {});',
          'await describe("suite", () => { nodeTest("registration", () => {}); });',
          'nodeTest("parent", (t) => { t.test("unawaited subtest", () => {}); });',
          "async function unrelated(): Promise<void> {}",
          "function local() { const nodeTest = unrelated; nodeTest(); } local();",
          'import { nodeTest as other } from "./other.ts"; other();',
          'nodeTest("floating body", () => { Promise.resolve(); });',
          "unrelated();",
          'function typedShadow(nodeTest: typeof import("node:test").test): void { nodeTest("unowned", () => {}); }',
          'nodeTest("owned subtest", async (t) => { await t.test("child", () => {}); });',
          'nodeTest("owned body", async () => { await Promise.resolve(); });',
        ].join("\n"),
        "other.ts": "export async function nodeTest(): Promise<void> {}",
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["probe.ts"]), [
          ["typescript(no-floating-promises)", 4, 29],
          ["typescript(no-floating-promises)", 6, 48],
          ["typescript(no-floating-promises)", 7, 49],
          ["typescript(no-floating-promises)", 8, 35],
          ["typescript(no-floating-promises)", 9, 1],
          ["typescript(no-floating-promises)", 10, 73],
        ]);
      },
    );
  },
);
