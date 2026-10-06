import test from "node:test";
import {
  expectDiagnostics,
  focusedConfig,
  inProbe,
  lint,
  policyRule,
} from "./quality-probe-support.ts";

const readonly = "typescript(prefer-readonly-parameter-types)";
const config = focusedConfig(
  {
    "typescript/prefer-readonly-parameter-types": policyRule(
      "typescript/prefer-readonly-parameter-types",
    ),
  },
  true,
);

for (const [name, namespace] of [
  ["RuleContext", "Rule"],
  ["Scope", "Scope"],
]) {
  test(`native eslint ${namespace}.${name} rejects local and foreign origins`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": config,
        "probe.ts": `import type { ${namespace} as Native } from "eslint";\nexport function approved(input: Native.${name}): void { console.log(input); }\ninterface ${name} { value: number }\nexport function local(input: ${name}): void { console.log(input); }\nimport type { ${name} as Foreign } from "other-package";\nexport function foreign(input: Foreign): void { console.log(input); }`,
        "node_modules/other-package/package.json": '{"name":"other-package","types":"index.d.ts"}',
        "node_modules/other-package/index.d.ts": `export interface ${name} { value: number }`,
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["probe.ts"]), [
          [readonly, 4],
          [readonly, 6],
        ]);
      },
    );
  });
}

for (const modifier of ["", "readonly "]) {
  test(`merged global native URL ${modifier.length === 0 ? "mutable " : modifier}application state stays checked`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": config,
        "probe.ts": `export {};\ndeclare global { interface URL { ${modifier}counter: number } }\nexport function augmented(input: URL): void { console.log(input); }`,
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["probe.ts"]),
          modifier.length === 0 ? [[readonly, 3]] : [],
        );
      },
    );
  });
  test(`merged SDK Theme ${modifier.length === 0 ? "mutable " : modifier}application state stays checked`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": config,
        "probe.ts": `import type { Theme } from "@earendil-works/pi-coding-agent";\ndeclare module "@earendil-works/pi-coding-agent" { interface Theme { ${modifier}counter: number } }\nexport function augmented(input: Theme): void { console.log(input); }`,
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["probe.ts"]),
          modifier.length === 0 ? [[readonly, 3]] : [],
        );
      },
    );
  });
}

for (const [field, mutable] of [
  ["counter: number", true],
  ["readonly counter: number", false],
  ["readonly application: { value: number }", true],
  ["readonly application: { readonly value: number }", false],
] as const) {
  test(`merged readonly array application state stays checked: ${field}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": config,
        "probe.ts": `export {};\ndeclare global { interface ReadonlyArray<T> { ${field} } }\nexport function augmented(input: readonly string[]): void { console.log(input); }`,
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["probe.ts"]), mutable ? [[readonly, 3]] : []);
      },
    );
  });
}
