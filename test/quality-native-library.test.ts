import assert from "node:assert/strict";
import test from "node:test";
import {
  expectDiagnostics,
  focusedConfig,
  inProbe,
  lint,
  policyRule,
  record,
} from "./quality-probe-support.ts";

const options = policyRule("typescript/prefer-readonly-parameter-types");
assert(Array.isArray(options));
const ruleOptions: unknown = options[1];
assert(record(ruleOptions));
assert(Array.isArray(ruleOptions.allow));
const library: unknown = ruleOptions.allow.find(
  (entry: unknown) => record(entry) && entry.from === "lib",
);
assert(record(library));
assert(Array.isArray(library.name));
const generics = new Set(["Promise", "PromiseLike"]);

for (const name of library.name) {
  assert.equal(typeof name, "string");
  if (typeof name !== "string") {
    throw new Error("Invalid native type name");
  }
  test(`library declaration ${name} retains origin isolation`, async () => {
    const native = `globalThis.${name}${generics.has(name) ? "<void>" : ""}`;
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig(
          { "typescript/prefer-readonly-parameter-types": options },
          true,
        ),
        "probe.ts": `export function approved(input: ${native}): void { console.log(input); }\ninterface ${name} { value: string }\nexport function foreign(input: ${name}): void { console.log(input); }`,
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["probe.ts"]), [
          ["typescript(prefer-readonly-parameter-types)", 3],
        ]);
      },
    );
  });
}

for (const path of ["./approved.ts", "./other.ts"]) {
  test(`file-qualified readonly allowance isolates ${path}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig(
          {
            "typescript/prefer-readonly-parameter-types": [
              "error",
              {
                ignoreInferredTypes: true,
                treatMethodsAsReadonly: false,
                allow: [{ from: "file", name: "Native", path }],
              },
            ],
          },
          true,
        ),
        "approved.ts": "export interface Native { value: string }",
        "other.ts": "export interface Native { value: string }",
        "probe.ts":
          'import type { Native as Approved } from "./approved.ts";\nexport function first(input: Approved): void { console.log(input); }\nimport type { Native as Other } from "./other.ts";\nexport function other(input: Other): void { console.log(input); }\ninterface Native { value: string }\nexport function local(input: Native): void { console.log(input); }',
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["probe.ts"]),
          path === "./approved.ts"
            ? [
                ["typescript(prefer-readonly-parameter-types)", 4],
                ["typescript(prefer-readonly-parameter-types)", 6],
              ]
            : [
                ["typescript(prefer-readonly-parameter-types)", 2],
                ["typescript(prefer-readonly-parameter-types)", 6],
              ],
        );
      },
    );
  });
}
