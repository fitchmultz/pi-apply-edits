import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { PolicyFinding } from "./suppression-policy.ts";

const lintStructure = Type.Object({
  plugins: Type.Array(Type.String()),
  rules: Type.Record(Type.String(), Type.Unknown()),
  overrides: Type.Array(
    Type.Object({
      files: Type.Array(Type.String()),
      rules: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
});
const floatingStructure = Type.Tuple([
  Type.Literal("error"),
  Type.Record(Type.String(), Type.Unknown()),
]);
const frameworkOptions = {
  assertFunctionNames: [{ source: "./test/quality-probe-support.ts", name: "expectDiagnostics" }],
  wrappers: [
    { source: "./test/quality-probe-support.ts", name: "inProbe", callback: 1 },
    { source: "./test/racing.ts", name: "withRacingFileSystem", callback: 1 },
    { source: "./test/racing.ts", name: "withRacingEditing", callback: 1 },
  ],
};
const jxaProfile = {
  files: ["src/macos-acl.js"],
  env: { node: false },
  globals: { ObjC: "readonly", $: "readonly", Ref: "readonly" },
  rules: { "no-unused-vars": ["error", { varsIgnorePattern: "^run$" }] },
};

/** Appendix A remains the baseline; this function owns only the repository's mappings. */
function expectedLint(): Record<string, unknown> {
  const standard = readFileSync("docs/engineering-standard.md", "utf8");
  const appendix = standard.slice(standard.indexOf("## Appendix A:"));
  const source = /```json\n([\s\S]+?)\n```/u.exec(appendix)?.[1];
  if (source === undefined) {
    throw new Error("Cannot find Appendix A's JSON configuration");
  }
  const base: unknown = JSON.parse(source);
  if (!Value.Check(lintStructure, base)) {
    throw new Error("Invalid Appendix A configuration");
  }
  const tests = base.overrides[0];
  const floating = base.rules["typescript/no-floating-promises"];
  if (tests === undefined || !Value.Check(floatingStructure, floating)) {
    throw new Error("Invalid Appendix A profiles or floating-Promise options");
  }
  return {
    ...base,
    plugins: [...base.plugins, "node"],
    jsPlugins: [{ name: "node-test", specifier: "./scripts/node-test-plugin.ts" }],
    env: { node: true },
    rules: {
      ...base.rules,
      "typescript/no-floating-promises": [
        "error",
        {
          ...floating[1],
          allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["nodeTest"] }],
        },
      ],
    },
    overrides: [
      jxaProfile,
      {
        ...tests,
        files: ["test/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}", ...tests.files],
        rules: {
          ...tests.rules,
          "node-test/expect-assertions": ["error", frameworkOptions],
          "node-test/valid-exceptions": ["error", frameworkOptions],
          "node-test/no-conditional-assertions": ["error", frameworkOptions],
        },
      },
      ...base.overrides.slice(1),
    ],
  };
}

function checkFormatter(): readonly PolicyFinding[] {
  const format: unknown = JSON.parse(readFileSync(".oxfmtrc.json", "utf8"));
  const expected = {
    $schema: "./node_modules/oxfmt/configuration_schema.json",
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    endOfLine: "lf",
    insertFinalNewline: true,
    sortImports: false,
    sortPackageJson: false,
    sortTailwindcss: false,
    jsdoc: false,
    ignorePatterns: ["package-lock.json"],
    overrides: [{ files: ["**/*.yml", "**/*.yaml"], options: { singleQuote: true } }],
  };
  return isDeepStrictEqual(format, expected)
    ? []
    : [
        {
          path: ".oxfmtrc.json",
          line: 1,
          message: "Restore the section 7.1 formatter settings and recorded npm/YAML ownership",
        },
      ];
}

function checkComposition(files: readonly string[]): readonly PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const path of files) {
    if (
      /(?:^|\/)\.ox(?:lint|fmt)(?:rc|ignore)/u.test(path) &&
      ![".oxlintrc.json", ".oxfmtrc.json"].includes(path)
    ) {
      findings.push({
        path,
        line: 1,
        message:
          "Nested quality configuration and additional ignore files require a reviewed mapping",
      });
    }
    if (
      /(?:^|\/)(?:ts|js)config(?:\.[^/]+)?\.json$/u.test(path) &&
      !["tsconfig.json", "tsconfig.jxa.json"].includes(path)
    ) {
      findings.push({
        path,
        line: 1,
        message:
          "Add the compiler project to the real acceptance gates before assigning source to it",
      });
    }
  }
  const ignores = readFileSync(".gitignore", "utf8").trim().split(/\r?\n/u);
  if (
    !isDeepStrictEqual(ignores, [
      "node_modules/",
      "*.tgz",
      ".DS_Store",
      "coverage/",
      ".dogfood/",
      "review-*.md",
    ])
  ) {
    findings.push({
      path: ".gitignore",
      line: 1,
      message: "Source ignore changes require an explicit coverage mapping",
    });
  }
  return findings;
}

function checkCommands(): readonly PolicyFinding[] {
  const structure = Type.Object({ scripts: Type.Record(Type.String(), Type.String()) });
  const packageJson: unknown = JSON.parse(readFileSync("package.json", "utf8"));
  if (!Value.Check(structure, packageJson)) {
    throw new Error("Missing package acceptance scripts");
  }
  const commands = {
    lint: "oxlint --deny-warnings .",
    "format:check": "oxfmt --check .",
    typecheck: "tsc --noEmit",
    "typecheck:jxa": "tsc --noEmit -p tsconfig.jxa.json",
    "policy:check": "node scripts/check-policy.ts",
    test: "node --test test/*.test.ts",
    "pack:check": "npm pack --dry-run",
    check: "node scripts/check.ts",
    "check:compat": "npm run check",
    prepublishOnly: "npm run check",
  };
  return Object.entries(commands)
    .filter(([name, command]) => packageJson.scripts[name] !== command)
    .map(([name, command]) => ({
      path: "package.json",
      line: 1,
      message: `Restore the required ${name} command: ${command}`,
    }));
}

export function checkQualityConfig(files: readonly string[]): readonly PolicyFinding[] {
  const lint: unknown = JSON.parse(readFileSync(".oxlintrc.json", "utf8"));
  const findings: PolicyFinding[] = isDeepStrictEqual(lint, expectedLint())
    ? []
    : [
        {
          path: ".oxlintrc.json",
          line: 1,
          message:
            "Restore Appendix A and the recorded QX-001, QX-004, and node:test mappings in scripts/quality-config.ts",
        },
      ];
  return [...findings, ...checkFormatter(), ...checkComposition(files), ...checkCommands()];
}
