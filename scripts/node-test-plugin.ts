import type { Rule } from "eslint";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { NodeTestCollector } from "./node-test-collector.ts";

const optionsSchema = Type.Object(
  {
    assertFunctionNames: Type.Optional(
      Type.Array(
        Type.Object(
          { source: Type.String(), name: Type.String() },
          { additionalProperties: false },
        ),
      ),
    ),
    wrappers: Type.Optional(
      Type.Array(
        Type.Object(
          {
            source: Type.String(),
            name: Type.String(),
            callback: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

function assertionRule(rule: string): Rule.RuleModule {
  return {
    meta: {
      type: "problem",
      schema: [optionsSchema],
    },
    create(context) {
      const options = Value.Check(optionsSchema, context.options[0]) ? context.options[0] : {};
      return new NodeTestCollector(
        context,
        options.assertFunctionNames ?? [],
        rule,
        options.wrappers ?? [],
      ).listeners();
    },
  };
}

export default {
  meta: { name: "node-test" },
  rules: {
    "expect-assertions": assertionRule("node-test/expect-assertions"),
    "no-conditional-assertions": assertionRule("node-test/no-conditional-assertions"),
    "valid-exceptions": assertionRule("node-test/valid-exceptions"),
  },
};
