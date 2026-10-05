import type { Rule } from "eslint";
import { checkTestAssertions } from "./test-policy.ts";

function assertionRule(rule: string): Rule.RuleModule {
  return {
    meta: {
      type: "problem",
      schema: [
        {
          type: "object",
          properties: { assertFunctionNames: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      return {
        Program() {
          for (const finding of checkTestAssertions(
            context.filename,
            context.sourceCode.text,
            assertionNames(context.options[0]),
          )) {
            if (finding.rule === rule) {
              context.report({ loc: { line: finding.line, column: 0 }, message: finding.message });
            }
          }
        },
      };
    },
  };
}

function assertionNames(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || !("assertFunctionNames" in value)) {
    return [];
  }
  const names: unknown = value.assertFunctionNames;
  if (!Array.isArray(names)) {
    return [];
  }
  return names.filter((name: unknown): name is string => typeof name === "string");
}

export default {
  meta: { name: "node-test" },
  rules: {
    "expect-assertions": assertionRule("node-test/expect-assertions"),
    "no-conditional-assertions": assertionRule("node-test/no-conditional-assertions"),
  },
};
