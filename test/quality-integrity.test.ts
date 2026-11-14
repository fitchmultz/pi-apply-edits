import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { isRecord } from "../src/editing/contracts.ts";
import { inProbe } from "./quality-probe-support.ts";

const assets = Object.fromEntries(
  [
    ".oxlintrc.json",
    ".oxfmtrc.json",
    ".gitignore",
    "package.json",
    "docs/engineering-standard.md",
  ].map((path) => [path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8")]),
);
const config: unknown = JSON.parse(
  readFileSync(new URL("../.oxlintrc.json", import.meta.url), "utf8"),
);
assert(isRecord(config));
assert(isRecord(config.rules));
assert(isRecord(config.categories));
assert(isRecord(config.options));
const rules = config.rules;
const categories = config.categories;
const options = config.options;
const manifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
assert(isRecord(manifest));
assert(isRecord(manifest.scripts));
const scripts = manifest.scripts;

const cases = [
  { name: "baseline", inputs: {}, expected: [] },
  {
    name: "explicit rule disable",
    inputs: {
      ".oxlintrc.json": JSON.stringify({
        ...config,
        rules: { ...rules, "typescript/no-floating-promises": "off" },
      }),
    },
    expected: [
      {
        path: ".oxlintrc.json",
        line: 1,
        message:
          "Restore Appendix A and the recorded QX-001, QX-004, and node:test mappings in scripts/quality-config.ts",
      },
    ],
  },
  {
    name: "category-only coverage",
    inputs: {
      ".oxlintrc.json": JSON.stringify({ ...config, categories: { ...categories, perf: "off" } }),
    },
    expected: [
      {
        path: ".oxlintrc.json",
        line: 1,
        message:
          "Restore Appendix A and the recorded QX-001, QX-004, and node:test mappings in scripts/quality-config.ts",
      },
    ],
  },
  {
    name: "semantic analysis",
    inputs: {
      ".oxlintrc.json": JSON.stringify({ ...config, options: { ...options, typeAware: false } }),
    },
    expected: [
      {
        path: ".oxlintrc.json",
        line: 1,
        message:
          "Restore Appendix A and the recorded QX-001, QX-004, and node:test mappings in scripts/quality-config.ts",
      },
    ],
  },
  {
    name: "structural threshold",
    inputs: {
      ".oxlintrc.json": JSON.stringify({
        ...config,
        rules: { ...rules, complexity: ["error", { max: 11, variant: "modified" }] },
      }),
    },
    expected: [
      {
        path: ".oxlintrc.json",
        line: 1,
        message:
          "Restore Appendix A and the recorded QX-001, QX-004, and node:test mappings in scripts/quality-config.ts",
      },
    ],
  },
  {
    name: "nested configuration",
    inputs: { "src/.oxlintrc.json": "{}" },
    expected: [
      {
        path: "src/.oxlintrc.json",
        line: 1,
        message:
          "Nested quality configuration and additional ignore files require a reviewed mapping",
      },
    ],
  },
  {
    name: "formatter ownership",
    inputs: { ".oxfmtrc.json": '{"ignorePatterns":["src/**"]}' },
    expected: [
      {
        path: ".oxfmtrc.json",
        line: 1,
        message: "Restore the section 7.1 formatter settings and recorded npm/YAML ownership",
      },
    ],
  },
  {
    name: "reduced command scope",
    inputs: {
      "package.json": JSON.stringify({ ...manifest, scripts: { ...scripts, lint: "oxlint src" } }),
    },
    expected: [
      {
        path: "package.json",
        line: 1,
        message: "Restore the required lint command: oxlint --deny-warnings .",
      },
    ],
  },
];

for (const probe of cases) {
  nodeTest(`configuration integrity: ${probe.name}`, async () => {
    const files = { ...assets, ...probe.inputs };
    await inProbe(files, async (directory) => {
      const module = new URL("../scripts/quality-config.ts", import.meta.url).href;
      const script = `import { checkQualityConfig } from ${JSON.stringify(module)}; const findings = checkQualityConfig(${JSON.stringify(Object.keys(files))}); console.log(JSON.stringify(findings)); process.exitCode = findings.length === 0 ? 0 : 1;`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, probe.expected.length === 0 ? 0 : 1, result.stderr);
      const output: unknown = JSON.parse(result.stdout);
      assert.deepEqual(output, probe.expected);
    });
  });
}
