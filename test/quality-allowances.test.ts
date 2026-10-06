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

const floating = "typescript(no-floating-promises)";
const readonly = "typescript(prefer-readonly-parameter-types)";

test("framework registration allowances isolate declarations, aliases, packages, shadows and subtests", async () => {
  const config = focusedConfig({
    "typescript/no-floating-promises": policyRule("typescript/no-floating-promises"),
  });
  await inProbe(
    {
      ".oxlintrc.json": config,
      "probe.ts": [
        'import test, { it, describe, test as alias } from "node:test";',
        'test("owned", () => {});',
        'it("owned", () => {});',
        'describe("owned", () => {});',
        'alias("owned", () => {});',
        'import { renamed } from "./approved.ts";',
        'renamed("owned re-export", () => {});',
        "async function unrelated(): Promise<void> {}",
        "unrelated();",
        "function local() { const test = unrelated; test(); }",
        "local();",
        'import { test as otherFile } from "./other.ts";',
        "otherFile();",
        'import { test as otherPackage } from "other-package";',
        "otherPackage();",
        'test("parent", (context) => { context.test("unawaited subtest", () => {}); });',
        "Promise.resolve();",
        'import { test as nativeTest } from "node:test";',
        'function typedShadow(test: typeof nativeTest): void { test("unowned", () => {}); }',
      ].join("\n"),
      "approved.ts": 'export { test as renamed } from "node:test";',
      "other.ts": "export async function test(): Promise<void> {}",
      "node_modules/other-package/package.json": '{"name":"other-package","types":"index.d.ts"}',
      "node_modules/other-package/index.d.ts": "export function test(): Promise<void>;",
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [
        [floating, 9, 1],
        [floating, 10, 44],
        [floating, 13, 1],
        [floating, 15, 1],
        [floating, 16, 31],
        [floating, 17, 1],
        [floating, 19, 55],
      ]);
    },
  );
});

for (const path of ["./approved.ts", "./other.ts"]) {
  test(`file-qualified safe-call allowance isolates ${path}`, async () => {
    const files = {
      "probe.ts":
        'import { register } from "./approved.ts";\nregister();\nimport { register as foreign } from "./other.ts";\nforeign();\nfunction local() { const register = foreign; register(); }\nlocal();',
      "approved.ts": "export async function register(): Promise<void> {}",
      "other.ts": "export async function register(): Promise<void> {}",
    };
    const config = focusedConfig({
      "typescript/no-floating-promises": [
        "error",
        {
          checkThenables: true,
          ignoreVoid: false,
          ignoreIIFE: false,
          allowForKnownSafeCalls: [{ from: "file", name: "register", path }],
        },
      ],
    });
    await inProbe({ ...files, ".oxlintrc.json": config }, async (directory) => {
      expectDiagnostics(
        lint(directory, ["probe.ts"]),
        path === "./approved.ts"
          ? [
              [floating, 4],
              [floating, 5],
            ]
          : [
              [floating, 2],
              [floating, 5],
            ],
      );
    });
  });
}

const nativeCases = [
  ["Buffer", "node:buffer"],
  ["BigIntStats", "node:fs"],
  ["Stats", "node:fs"],
  ["FileHandle", "node:fs/promises"],
  ["TestContext", "node:test"],
  ["MockTracker", "node:test"],
  ["StatOptions", "node:fs"],
  ["MakeDirectoryOptions", "node:fs"],
  ["ObjectEncodingOptions", "node:fs"],
  ["RmOptions", "node:fs"],
  ["RmDirOptions", "node:fs"],
  ["URL", "node:url"],
  ["ExtensionAPI", "@earendil-works/pi-coding-agent"],
  ["ExtensionContext", "@earendil-works/pi-coding-agent"],
  ["ExtensionToolContext", "@earendil-works/pi-coding-agent"],
  ["ExtensionCommandContext", "@earendil-works/pi-coding-agent"],
  ["ExtensionUIContext", "@earendil-works/pi-coding-agent"],
  ["AgentSession", "@earendil-works/pi-coding-agent"],
  ["ModelRuntime", "@earendil-works/pi-coding-agent"],
  ["Theme", "@earendil-works/pi-coding-agent"],
  ["SessionManager", "@earendil-works/pi-coding-agent"],
  ["Tool", "@earendil-works/pi-ai"],
  ["TSchema", "typebox"],
] satisfies readonly (readonly [string, string])[];

for (const [name, module] of nativeCases) {
  test(`readonly ${module}:${name} allowance rejects local and other-package names`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig(
          {
            "typescript/prefer-readonly-parameter-types": policyRule(
              "typescript/prefer-readonly-parameter-types",
            ),
          },
          true,
        ),
        "probe.ts":
          `import type { ${name} as Native } from "${module}";\nexport function approved(input: Native): void { console.log(input); }\ninterface ${name} { value: string }\nexport function unrelated(input: ${name}): void { console.log(input); }\nimport type { ${name} as Foreign } from "other-package";\nexport function foreign(input: Foreign): void { console.log(input); }` +
          (name === "SessionManager"
            ? "\nexport function projected(input: Readonly<Native>): void { console.log(input); }"
            : ""),
        "node_modules/other-package/package.json": '{"name":"other-package","types":"index.d.ts"}',
        "node_modules/other-package/index.d.ts": `export interface ${name} { value: string }`,
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

test("library readonly allowances reject local names and keep ordinary Promise ownership strict", async () => {
  await inProbe(
    {
      ".oxlintrc.json": focusedConfig({
        "typescript/prefer-readonly-parameter-types": policyRule(
          "typescript/prefer-readonly-parameter-types",
        ),
        "typescript/no-floating-promises": policyRule("typescript/no-floating-promises"),
      }),
      "probe.ts":
        "export function native(input: URL): string { return input.href; }\ninterface URL { href: string }\nexport function local(input: URL): string { return input.href; }\nPromise.resolve();",
    },
    async (directory) => {
      // A local declaration shadows both annotations: neither receives lib permission.
      expectDiagnostics(lint(directory, ["probe.ts"]), [
        [readonly, 1],
        [readonly, 3],
        [floating, 4],
      ]);
    },
  );
  await inProbe(
    {
      ".oxlintrc.json": focusedConfig(
        {
          "typescript/prefer-readonly-parameter-types": policyRule(
            "typescript/prefer-readonly-parameter-types",
          ),
        },
        true,
      ),
      "probe.ts":
        "export function native(input: URL, promise: Promise<void>, signal: AbortSignal): void { console.log(input.href, promise, signal.aborted); }",
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), []);
    },
  );
});

test("readonly contracts retain mutable-container, mapped-wrapper and nested-value checks without blanket generic allowances", async () => {
  await inProbe(
    {
      ".oxlintrc.json": focusedConfig(
        {
          "typescript/prefer-readonly-parameter-types": policyRule(
            "typescript/prefer-readonly-parameter-types",
          ),
        },
        true,
      ),
      "probe.ts":
        "export function immutable(input: ReadonlyMap<string, number>): void { console.log(input); }\nexport function mutable(input: Map<string, number>): void { console.log(input); }\nexport function nested(input: ReadonlyMap<string, { value: string }>): void { console.log(input); }\nexport function data(input: { readonly values: readonly string[] }): void { console.log(input); }\nexport function mutableWrapper(input: Readonly<Map<string, number>>): void { console.log(input); }\nexport function nestedWrapper(input: Readonly<ReadonlyMap<string, { value: string }>>): void { console.log(input); }\nexport function set(input: ReadonlySet<string>): void { console.log(input); }\nexport function mutableSet(input: Set<string>): void { console.log(input); }\nexport function mutableSetWrapper(input: Readonly<Set<string>>): void { console.log(input); }\nexport function attached(input: ReadonlyMap<string, number> & { value: string }): void { console.log(input); }\nconst immutableArray: readonly number[] = [1]; immutableArray.flatMap((value, index, array) => { array.push(value); return [index]; });\nconst mutableArray: number[] = [1]; mutableArray.flatMap((value, index, array) => { array.push(value); return [index]; });",
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [
        [readonly, 2],
        [readonly, 3],
        [readonly, 5],
        [readonly, 6],
        [readonly, 8],
        [readonly, 9],
        [readonly, 10],
        ["typescript(TS2339)", 11],
      ]);
    },
  );
});

test("partial native collection views audit every exposed data channel", async () => {
  const cases = [
    ['Pick<ReadonlyMap<string, { value: number }>, "values">', true],
    ['Pick<ReadonlyMap<{ value: number }, number>, "keys">', true],
    ['Pick<ReadonlyMap<{ value: number }, number>, "entries">', true],
    ['Pick<ReadonlyMap<string, { value: number }>, "forEach">', true],
    ['Omit<ReadonlyMap<string, { value: number }>, "get">', true],
    ['Pick<ReadonlyMap<string, { value: number }>, "get" | "values">', true],
    ["Pick<ReadonlyMap<string, { value: number }>, typeof Symbol.iterator>", true],
    ['Pick<ReadonlySet<{ value: number }>, "values">', true],
    ['Pick<ReadonlySet<{ value: number }>, "entries">', true],
    ['Pick<ReadonlySet<{ value: number }>, "union">', true],
    ['Pick<ReadonlyMap<string, [number, number]>, "values">', true],
    ['Pick<ReadonlyMap<{ value: number }, number>, "forEach">', true],
    ['Pick<ReadonlyMap<string, { readonly value: number }>, "values">', false],
    ['Pick<ReadonlyMap<{ readonly value: number }, number>, "keys">', false],
    ['Pick<ReadonlyMap<string, number>, "entries">', false],
    ["Pick<ReadonlyMap<string, number>, typeof Symbol.iterator>", false],
    ['Pick<ReadonlyMap<string, number>, "forEach">', false],
    ['Pick<ReadonlySet<{ readonly value: number }>, "values">', false],
    ['Pick<ReadonlySet<number>, "entries" | "union">', false],
    ['Pick<ReadonlyMap<string, { value: number }>, "size">', false],
    ['Readonly<Pick<Map<string, number>, "get" | "has" | "size">>', false],
    ["Partial<ReadonlyMap<string, number>>", false],
    ["Partial<ReadonlySet<string>>", false],
    ['Partial<Pick<ReadonlyMap<string, { readonly value: number }>, "values">>', false],
    ['Readonly<Partial<Pick<Map<string, number>, "get" | "has" | "size">>>', false],
    ["Partial<ReadonlyMap<string, { value: number }>>", true],
    ["Partial<ReadonlySet<{ value: number }>>", true],
    ['Pick<Map<string, number>, "get">', true],
    ['Partial<Pick<Map<string, number>, "get">>', true],
    ['Pick<Set<number>, "has">', true],
    ['Partial<Pick<Set<number>, "has">>', true],
    ['Pick<ReadonlyMap<string, number>, "get">', false],
    ['Partial<Pick<ReadonlySet<number>, "has">>', false],
    ['Readonly<Partial<Pick<Set<number>, "has">>>', false],
    ['Pick<MutableMethods, "get">', true],
    ['Partial<Pick<MutableMethods, "get">>', true],
    ['Readonly<Partial<Pick<MutableMethods, "get">>>', false],
    ['Partial<Pick<ForeignMethods, "get">>', true],
    ['Readonly<Partial<Pick<ForeignMethods, "get">>>', false],
    ['Pick<ReadonlySet<{ value: number }>, "isSubsetOf">', true],
    ['Pick<ReadonlySet<{ value: number }>, "isDisjointFrom">', true],
    ['Pick<ReadonlySet<{ value: number }>, "isSupersetOf">', false],
    ['Pick<ReadonlySet<{ readonly value: number }>, "isSubsetOf" | "isDisjointFrom">', false],
    ['Partial<Pick<ReadonlySet<{ value: number }>, "isSubsetOf">>', true],
    ['Partial<Pick<ReadonlySet<number>, "isDisjointFrom">>', false],
    ["readonly number[]", false],
    ["readonly { readonly value: number }[]", false],
    ['Pick<readonly number[], "map" | "length">', false],
    ['Partial<Pick<readonly number[], "map">>', false],
    ["readonly { value: number }[]", true],
    ['Pick<readonly { value: number }[], "map" | "length">', true],
    ['Partial<Pick<readonly { value: number }[], "map">>', true],
  ] satisfies readonly (readonly [string, boolean])[];
  await inProbe(
    {
      ".oxlintrc.json": focusedConfig(
        {
          "typescript/prefer-readonly-parameter-types": policyRule(
            "typescript/prefer-readonly-parameter-types",
          ),
        },
        true,
      ),
      "probe.ts":
        '/// <reference lib="esnext.collection" />\n' +
        'import type { MutableMethods as ForeignMethods } from "other-package";\n' +
        "interface MutableMethods { get(): number }\n" +
        cases
          .map(
            ([type], index) =>
              `export function view${index}(input: ${type}): void { console.log(input); }`,
          )
          .join("\n"),
      "node_modules/other-package/package.json": '{"name":"other-package","types":"index.d.ts"}',
      "node_modules/other-package/index.d.ts": "export interface MutableMethods { get(): number }",
    },
    async (directory) => {
      expectDiagnostics(
        lint(directory, ["probe.ts"]),
        cases.flatMap(([, mutable], index) => (mutable ? [[readonly, index + 4]] : [])),
      );
    },
  );
});

test("plain generic callbacks pass while mutable attached state stays detectable", async () => {
  await inProbe(
    {
      ".oxlintrc.json": focusedConfig(
        {
          "typescript/prefer-readonly-parameter-types": policyRule(
            "typescript/prefer-readonly-parameter-types",
          ),
        },
        true,
      ),
      "probe.ts":
        "export function generic<T>(operation: () => T): T { return operation(); }\nexport function attached(operation: (() => number) & { state: string }): number { return operation(); }\nexport function mutableInputs<T>(operation: (state: { value: number }) => T): T { return operation({ value: 0 }); }",
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [
        [readonly, 2],
        [readonly, 3],
      ]);
    },
  );
});

test("local container-shaped names cannot acquire native readonly origin treatment", async () => {
  await inProbe(
    {
      ".oxlintrc.json": focusedConfig(
        {
          "typescript/prefer-readonly-parameter-types": policyRule(
            "typescript/prefer-readonly-parameter-types",
          ),
        },
        true,
      ),
      "probe.ts":
        "interface ReadonlyMap<K, V> { value: V; key: K }\nexport function foreign(input: ReadonlyMap<string, number>): void { console.log(input); }\ninterface ReadonlySet<V> { value: V }\nexport function foreignSet(input: ReadonlySet<string>): void { console.log(input); }",
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [
        [readonly, 2],
        [readonly, 4],
      ]);
    },
  );
});

test("native allowances cannot launder attached mutable application state or unsafe union members", async () => {
  await inProbe(
    {
      ".oxlintrc.json": focusedConfig(
        {
          "typescript/prefer-readonly-parameter-types": policyRule(
            "typescript/prefer-readonly-parameter-types",
          ),
        },
        true,
      ),
      "probe.ts":
        'import type { Theme } from "@earendil-works/pi-coding-agent";\nexport function attached(input: Theme & { counter: number }): void { console.log(input); }\nexport function immutable(input: Theme & { readonly counter: number }): void { console.log(input); }\nexport function union(input: Theme | { counter: number }): void { console.log(input); }\nexport function envelope(input: { readonly theme: Theme; readonly labels: Readonly<Record<string, string>> }): void { console.log(input); }\nexport function libAttached(input: URL & { counter: number }): void { console.log(input); }\nexport function libUnion(input: URL | { counter: number }): void { console.log(input); }',
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["probe.ts"]), [
        [readonly, 2],
        [readonly, 4],
        [readonly, 6],
        [readonly, 7],
      ]);
    },
  );
});

test("every declaration allowance is qualified and generic containers are never blanket-safe", () => {
  const options = policyRule("typescript/prefer-readonly-parameter-types");
  assert(Array.isArray(options));
  const ruleOptions: unknown = options[1];
  assert(record(ruleOptions));
  assert(Array.isArray(ruleOptions.allow));
  for (const entry of ruleOptions.allow) {
    assert(record(entry));
    assert(typeof entry.from === "string" && ["lib", "package", "file"].includes(entry.from));
    assert(Array.isArray(entry.name));
    assert(
      !entry.name.some(
        (name: unknown) =>
          typeof name === "string" && ["Map", "ReadonlyMap", "Record", "Readonly"].includes(name),
      ),
    );
  }
});
