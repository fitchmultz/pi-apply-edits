import type { Rule } from "eslint";
import { NodeTestCollector } from "./node-test-collector.ts";
import type { TestWrapper, AssertionHelper } from "./test-flow.ts";

function assertionRule(rule: string): Rule.RuleModule {
  return {
    meta: {
      type: "problem",
      schema: [
        {
          type: "object",
          properties: {
            assertFunctionNames: {
              type: "array",
              items: {
                type: "object",
                properties: { source: { type: "string" }, name: { type: "string" } },
                required: ["source", "name"],
                additionalProperties: false,
              },
            },
            wrappers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  name: { type: "string" },
                  callback: { type: "integer", minimum: 0 },
                },
                required: ["source", "name", "callback"],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      return new NodeTestCollector(
        context,
        assertionNames(context.options[0]),
        rule,
        wrappers(context.options[0]),
      ).listeners();
    },
  };
}

function wrappers(value: unknown): readonly TestWrapper[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("wrappers" in value) ||
    !Array.isArray(value.wrappers)
  ) {
    return [];
  }
  return value.wrappers.filter(isWrapper);
}
function isWrapper(value: unknown): value is TestWrapper {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "source" in value &&
    typeof value.source === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "callback" in value &&
    typeof value.callback === "number"
  );
}

function isAssertionHelper(value: unknown): value is AssertionHelper {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof value.source === "string" &&
    "name" in value &&
    typeof value.name === "string"
  );
}

function assertionNames(value: unknown): readonly AssertionHelper[] {
  if (typeof value !== "object" || value === null || !("assertFunctionNames" in value)) {
    return [];
  }
  const names: unknown = value.assertFunctionNames;
  if (!Array.isArray(names)) {
    return [];
  }
  return names.filter(isAssertionHelper);
}

export default {
  meta: { name: "node-test" },
  rules: {
    "expect-assertions": assertionRule("node-test/expect-assertions"),
    "no-conditional-assertions": assertionRule("node-test/no-conditional-assertions"),
    "valid-exceptions": assertionRule("node-test/valid-exceptions"),
  },
};
