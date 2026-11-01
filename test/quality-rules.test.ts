import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import {
  expectDiagnostics,
  effectiveConfig,
  focusedConfig,
  inProbe,
  lint,
  policyRule,
} from "./quality-probe-support.ts";

nodeTest("installed Node checks protect CommonJS export ownership", async () => {
  await inProbe(
    {
      ".oxlintrc.json": effectiveConfig(),
      "probe.cjs": "exports = { value: 1 }; console.log(exports);",
      "valid.cjs": "exports.value = 1; console.log(exports);",
    },
    async (directory) => {
      expectDiagnostics(lint(directory, ["valid.cjs"]), [], "valid.cjs");
      expectDiagnostics(
        lint(directory, ["probe.cjs"]),
        [["node(no-exports-assign)", 1]],
        "probe.cjs",
      );
    },
  );
});

const scopes = [
  {
    path: "probe.ts",
    invalid: 'new Error("unused");',
    valid: 'export const error = new Error("retained");',
    expected: [
      ["eslint(no-new)", 1],
      ["oxc(missing-throw)", 1],
    ],
  },
  {
    path: "test/probe.test.ts",
    invalid:
      'import { test as nodeTest } from "node:test";\nnodeTest("missing assertions", () => { new Error("unused"); Promise.resolve(); });',
    valid:
      'import { test as nodeTest } from "node:test";\nimport assert from "node:assert/strict";\nnodeTest("owned assertion", async () => { assert.equal(await Promise.resolve(1), 1); });',
    expected: [
      ["eslint(no-new)", 2],
      ["oxc(missing-throw)", 2],
      ["typescript(no-floating-promises)", 2],
      ["promise(catch-or-return)", 2],
      ["node-test(expect-assertions)", 2],
    ],
  },
  {
    path: "src/macos-acl.js",
    invalid: 'function run() { new Error("unused"); }',
    valid: 'function run() { return new Error("retained"); }',
    expected: [
      ["eslint(no-new)", 1],
      ["oxc(missing-throw)", 1],
    ],
  },
] satisfies readonly {
  readonly path: string;
  readonly invalid: string;
  readonly valid: string;
  readonly expected: readonly (readonly [string, number])[];
}[];
for (const scope of scopes) {
  nodeTest(
    `effective composition retains category and applicable explicit/framework checks in ${scope.path}`,
    async () => {
      await inProbe(
        { ".oxlintrc.json": effectiveConfig(), [scope.path]: scope.invalid },
        async (directory) => {
          expectDiagnostics(lint(directory, [scope.path]), scope.expected, scope.path);
        },
      );
      await inProbe(
        { ".oxlintrc.json": effectiveConfig(), [scope.path]: scope.valid },
        async (directory) => {
          expectDiagnostics(lint(directory, [scope.path]), [], scope.path);
        },
      );
    },
  );
}

interface RuleProbe {
  readonly rule: string;
  readonly source: string;
  readonly lines: readonly number[];
}
const probes: readonly RuleProbe[] = [
  { rule: "typescript/no-explicit-any", source: "export type Unsafe = any;", lines: [1] },
  {
    rule: "typescript/no-non-null-assertion",
    source: "export function read(value: string | undefined): string { return value!; }",
    lines: [1],
  },
  {
    rule: "typescript/no-unsafe-type-assertion",
    source: "export function read(value: unknown): string { return value as string; }",
    lines: [1],
  },
  {
    rule: "typescript/no-unnecessary-type-assertion",
    source: 'export const literal = "x" as const;',
    lines: [1],
  },
  {
    rule: "typescript/consistent-type-assertions",
    source: "export const data = { value: 1 } as { value: number };",
    lines: [1],
  },
  {
    rule: "typescript/no-unsafe-argument",
    source:
      "declare const input: any; function accept(value: string): void { console.log(value); } accept(input);",
    lines: [1],
  },
  {
    rule: "typescript/no-unsafe-assignment",
    source: "declare const input: any; export const result: string = input;",
    lines: [1],
  },
  { rule: "typescript/no-unsafe-call", source: "declare const input: any; input();", lines: [1] },
  {
    rule: "typescript/no-unsafe-member-access",
    source: "declare const input: any; input.value;",
    lines: [1],
  },
  {
    rule: "typescript/no-unsafe-return",
    source: "declare const input: any; export function read(): string { return input; }",
    lines: [1],
  },
  { rule: "typescript/no-empty-object-type", source: "export type Empty = {};", lines: [1] },
  {
    rule: "typescript/no-unsafe-function-type",
    source: "export type Unsafe = Function;",
    lines: [1],
  },
  {
    rule: "typescript/no-wrapper-object-types",
    source: "export type Unsafe = String;",
    lines: [1],
  },
  { rule: "typescript/no-invalid-void-type", source: "export type Invalid = void;", lines: [1] },
  {
    rule: "typescript/no-invalid-void-type",
    source: "export type Valid = Promise<void>;",
    lines: [],
  },
  {
    rule: "typescript/no-unnecessary-type-parameters",
    source: "export function read<T>(input: T): void { console.log(input); }",
    lines: [1],
  },
  {
    rule: "typescript/no-deprecated",
    source:
      "/** @deprecated use a replacement */\nexport function old(): number { return 1; }\nold();",
    lines: [3],
  },
  {
    rule: "typescript/unbound-method",
    source:
      "class Counter { value = 0; increment(): void { this.value += 1; } } export const method = new Counter().increment;",
    lines: [1],
  },
  {
    rule: "typescript/no-misused-spread",
    source: "export const result = { ...Promise.resolve(1) };",
    lines: [1],
  },
  {
    rule: "typescript/no-for-in-array",
    source: "for (const index in [1, 2]) { console.log(index); }",
    lines: [1],
  },
  { rule: "typescript/require-array-sort-compare", source: "[2, 10].sort();", lines: [1] },
  {
    rule: "typescript/ban-ts-comment",
    source: "// @ts-ignore\nexport const value: number = 'x';",
    lines: [1],
  },
  {
    rule: "typescript/strict-boolean-expressions",
    source:
      "export function read(value: number): boolean { if (value) { return true; } return false; }",
    lines: [1],
  },
  {
    rule: "typescript/strict-boolean-expressions",
    source:
      "export function read(value: { readonly key: string } | undefined): boolean { if (value) { return true; } return false; }",
    lines: [],
  },
  {
    rule: "typescript/no-unnecessary-condition",
    source:
      "export function read(value: string): string { if (value !== undefined) { return value; } return ''; }",
    lines: [1],
  },
  {
    rule: "typescript/no-unnecessary-condition",
    source: "while (true) { console.log('poll'); break; }",
    lines: [],
  },
  {
    rule: "typescript/switch-exhaustiveness-check",
    source:
      "export function read(value: 'a' | 'b'): void { switch (value) { case 'a': break; default: break; } }",
    lines: [1],
  },
  {
    rule: "eqeqeq",
    source: "export function read(a: unknown, b: unknown): boolean { return a == b; }",
    lines: [1],
  },
  {
    rule: "no-implicit-coercion",
    source: "export function read(value: unknown): boolean { return !!value; }",
    lines: [1],
  },
  {
    rule: "typescript/restrict-plus-operands",
    source: "export const result = 1 + 'a';",
    lines: [1],
  },
  {
    rule: "typescript/restrict-template-expressions",
    source: "export const result = `${[1, 2]}`;",
    lines: [1],
  },
  {
    rule: "typescript/restrict-template-expressions",
    source: "export const result = `${true} ${2}`;",
    lines: [],
  },
  {
    rule: "typescript/no-base-to-string",
    source: "export function read(value: object): string { return String(value); }",
    lines: [1],
  },
  { rule: "typescript/no-floating-promises", source: "void Promise.resolve();", lines: [1] },
  {
    rule: "typescript/no-floating-promises",
    source: "(async () => { console.log('owned?'); })();",
    lines: [1],
  },
  {
    rule: "typescript/no-floating-promises",
    source: "declare const pending: PromiseLike<void>; pending;",
    lines: [1],
  },
  {
    rule: "typescript/no-misused-promises",
    source:
      "export async function read(): Promise<void> { if (Promise.resolve(true)) { console.log('x'); } }",
    lines: [1],
  },
  { rule: "typescript/await-thenable", source: "await 1; export {};", lines: [1] },
  {
    rule: "typescript/return-await",
    source:
      "export async function read(): Promise<number> { try { return Promise.resolve(1); } catch { return 0; } }",
    lines: [1],
  },
  {
    rule: "typescript/strict-void-return",
    source: "export const callback: () => void = () => 1;",
    lines: [],
  },
  {
    rule: "typescript/strict-void-return",
    source: "export const callback: () => void = () => { console.log('discarded'); };",
    lines: [],
  },
  {
    rule: "typescript/no-confusing-void-expression",
    source: "export const result = console.log('void');",
    lines: [1],
  },
  {
    rule: "typescript/no-confusing-void-expression",
    source: "export const callback = () => console.log('genuine void shorthand');",
    lines: [],
  },
  {
    rule: "typescript/no-meaningless-void-operator",
    source: "void console.log('already void');",
    lines: [1],
  },
  {
    rule: "promise/always-return",
    source: "Promise.resolve(1).then((value) => { console.log(value); }).then((value) => value);",
    lines: [1],
  },
  {
    rule: "promise/always-return",
    source: "Promise.resolve(1).then((value) => { console.log(value); });",
    lines: [],
  },
  { rule: "promise/catch-or-return", source: "Promise.resolve().then(() => 1);", lines: [1] },
  {
    rule: "no-await-in-loop",
    source:
      "export async function read(): Promise<void> { for (const value of [1, 2]) { await Promise.resolve(value); } }",
    lines: [],
  },
  { rule: "typescript/only-throw-error", source: "throw 'failure';", lines: [1] },
  {
    rule: "typescript/only-throw-error",
    source: "try { console.log('work'); } catch (error) { throw error; }",
    lines: [],
  },
  {
    rule: "typescript/use-unknown-in-catch-callback-variable",
    source: "Promise.resolve().catch((error) => { console.log(error); });",
    lines: [1],
  },
  { rule: "typescript/prefer-promise-reject-errors", source: "Promise.reject();", lines: [1] },
  {
    rule: "typescript/prefer-promise-reject-errors",
    source: 'Promise.reject("failure");',
    lines: [1],
  },
  {
    rule: "typescript/prefer-promise-reject-errors",
    source: "declare const error: any; Promise.reject(error);",
    lines: [1],
  },
  {
    rule: "no-useless-catch",
    source: "try { console.log('work'); } catch (error) { throw error; }",
    lines: [1],
  },
  {
    rule: "no-param-reassign",
    source: "export function read(input: { value: string }): void { input.value = 'mutated'; }",
    lines: [1],
  },
  {
    rule: "typescript/prefer-readonly",
    source: "export class Owned { private value = 1; read(): number { return this.value; } }",
    lines: [1],
  },
  {
    rule: "typescript/explicit-module-boundary-types",
    source: "export function read() { return 1; }",
    lines: [1],
  },
  {
    rule: "typescript/method-signature-style",
    source: "export interface Contract { read(): string }",
    lines: [1],
  },
  {
    rule: "typescript/consistent-type-imports",
    source: "import { Stats } from 'node:fs'; export type Data = Stats;",
    lines: [1],
  },
  {
    rule: "typescript/consistent-type-exports",
    source: "import type { Stats } from 'node:fs'; export { Stats };",
    lines: [1],
  },
  {
    rule: "typescript/no-import-type-side-effects",
    source: "import { type Stats } from 'node:fs'; export type Data = Stats;",
    lines: [1],
  },
  { rule: "import/no-self-import", source: "import './probe.ts';", lines: [1] },
  { rule: "import/no-duplicates", source: "import 'node:fs';\nimport 'node:fs';", lines: [1] },
  { rule: "import/no-mutable-exports", source: "export let value = 1;", lines: [1] },
  { rule: "curly", source: "if (Math.random() > 0.5) console.log('x');", lines: [1] },
  { rule: "no-var", source: "var value = 1; console.log(value);", lines: [1] },
  { rule: "prefer-const", source: "let value = 1; console.log(value);", lines: [1] },
  {
    rule: "no-nested-ternary",
    source: "console.log(Math.random() > 0.5 ? 1 : Math.random() > 0.5 ? 2 : 3);",
    lines: [1],
  },
  {
    rule: "no-return-assign",
    source: "export function read(): number { let value = 0; return value = 1; }",
    lines: [1],
  },
  {
    rule: "no-sequences",
    source: "let left = 1; let right = 2; left++, right++; console.log(left, right);",
    lines: [1],
  },
  { rule: "no-multi-assign", source: "let a; let b; a = b = 1; console.log(a, b);", lines: [1] },
  {
    rule: "no-else-return",
    source:
      "export function read(value: boolean): number { if (value) { return 1; } else { return 2; } }",
    lines: [1],
  },
  { rule: "no-eval", source: "eval('1');", lines: [1] },
  { rule: "no-implied-eval", source: "setTimeout('danger', 1);", lines: [1] },
  { rule: "no-new-func", source: "new Function('return 1');", lines: [1] },
  { rule: "no-with", source: "with (console) { log('danger'); }", lines: [1] },
  { rule: "no-debugger", source: "debugger;", lines: [1] },
  {
    rule: "no-control-regex",
    source: "export const pattern = /[\\u0000-\\u001F\\u007F]/u;",
    lines: [],
  },
  { rule: "no-empty", source: "try { console.log('work'); } catch {}", lines: [1] },
  { rule: "no-empty-function", source: "export function sink(): void {}", lines: [1] },
  {
    rule: "no-empty-function",
    source: "export function sink(): void { /* This telemetry sink owns no buffered work. */ }",
    lines: [],
  },
  {
    rule: "unicorn/no-useless-undefined",
    source: "console.log(undefined);",
    lines: [1],
  },
  {
    rule: "typescript/no-invalid-void-type",
    source: "export function valid(this: void): void { console.log('native void contract'); }",
    lines: [],
  },
  {
    rule: "typescript/no-invalid-void-type",
    source: "export const pending = Promise.withResolvers<void>();",
    lines: [1],
  },
  {
    rule: "typescript/strict-void-return",
    source: "declare const value: any; export const callback: () => void = () => value;",
    lines: [],
  },
  {
    rule: "unicorn/no-abusive-eslint-disable",
    source: "/* eslint-disable */\nconsole.log('blanket');",
    lines: [1],
  },
  {
    rule: "typescript/no-invalid-void-type",
    source: "export const pending: PromiseWithResolvers<void> = Promise.withResolvers();",
    lines: [],
  },
];

const validSources: Readonly<Record<string, string>> = {
  "typescript/no-explicit-any": "export type Input = unknown;",
  "typescript/no-non-null-assertion":
    'export function read(value: string | undefined): string { return value ?? "fallback"; }',
  "typescript/no-unsafe-type-assertion":
    'export function read(value: unknown): string { if (typeof value === "string") { return value; } throw new Error("Expected text"); }',
  "typescript/no-unnecessary-type-assertion": 'export const tuple = [1, "x"] as const;',
  "typescript/consistent-type-assertions":
    "export const data = { value: 1 } satisfies { value: number };",
  "typescript/no-unsafe-argument":
    'declare const input: unknown; function accept(value: string): void { console.log(value); } if (typeof input === "string") { accept(input); }',
  "typescript/no-unsafe-assignment":
    'declare const input: unknown; if (typeof input === "string") { const result: string = input; console.log(result); }',
  "typescript/no-unsafe-call": "declare const input: () => void; input();",
  "typescript/no-unsafe-member-access":
    "declare const input: { readonly value: string }; export const result = input.value;",
  "typescript/no-unsafe-return":
    "declare const input: string; export function read(): string { return input; }",
  "typescript/no-empty-object-type": "export type Dictionary = Record<string, unknown>;",
  "typescript/no-unsafe-function-type": "export type Callback = () => void;",
  "typescript/no-wrapper-object-types": "export type Text = string;",
  "typescript/no-invalid-void-type": "export type Completion = Promise<void>;",
  "typescript/no-unnecessary-type-parameters":
    "export function identity<T>(input: T): T { return input; }",
  "typescript/no-deprecated": "export function replacement(): number { return 1; } replacement();",
  "typescript/unbound-method":
    "class Counter { value = 0; increment(): void { this.value += 1; } } const counter = new Counter(); export const method = (): void => { counter.increment(); };",
  "typescript/no-misused-spread":
    "const source = { value: 1 }; export const result = { ...source, other: 2 };",
  "typescript/no-for-in-array": "for (const value of [1, 2]) { console.log(value); }",
  "typescript/require-array-sort-compare": "[2, 10].sort((left, right) => left - right);",
  "typescript/ban-ts-comment": "// @ts-check\nexport const value = 1;",
  "typescript/strict-boolean-expressions":
    "export function read(value: number): boolean { return value !== 0; }",
  "typescript/no-unnecessary-condition":
    'export function read(value: string | undefined): string { if (value !== undefined) { return value; } return ""; }',
  "typescript/switch-exhaustiveness-check":
    'export function read(value: "a" | "b"): void { switch (value) { case "a": break; case "b": break; } }',
  eqeqeq: "export function read(a: unknown, b: unknown): boolean { return a === b; }",
  "no-implicit-coercion":
    "export function read(value: unknown): boolean { return Boolean(value); }",
  "typescript/restrict-plus-operands": "export const result = 1 + 2;",
  "typescript/restrict-template-expressions": "export const result = `${true} ${2}`;",
  "typescript/no-base-to-string":
    "export function read(value: unknown): string { return String(value); }",
  "typescript/no-floating-promises":
    'declare const pending: PromiseLike<void>; await pending; await Promise.resolve(); await (async () => { console.log("owned"); })();',
  "typescript/no-misused-promises":
    'export async function read(): Promise<void> { if (await Promise.resolve(true)) { console.log("ready"); } }',
  "typescript/await-thenable": "await Promise.resolve(1);",
  "typescript/return-await":
    "export async function read(): Promise<number> { try { return await Promise.resolve(1); } catch { return 0; } }",
  "typescript/strict-void-return": "export const callback: () => void = () => 1;",
  "typescript/no-confusing-void-expression":
    'export function read(): number { console.log("work"); return 1; }',
  "typescript/no-meaningless-void-operator": 'console.log("already void");',
  "promise/always-return": "Promise.resolve(1).then((value) => value + 1).then((value) => value);",
  "promise/catch-or-return":
    "export function read(): Promise<number> { return Promise.resolve(1).then((value) => value + 1); }",
  "no-await-in-loop":
    "export async function read(): Promise<void> { for (const value of [1, 2]) { await Promise.resolve(value); } }",
  "typescript/only-throw-error": 'throw new Error("failure");',
  "typescript/use-unknown-in-catch-callback-variable":
    "Promise.resolve().catch((error: unknown) => { console.log(error); });",
  "typescript/prefer-promise-reject-errors":
    'export const failure = Promise.reject(new Error("failure")); export function forward(error: unknown): Promise<never> { return Promise.reject(error); }',
  "no-useless-catch":
    'try { console.log("work"); } catch (error) { console.log(error); throw error; }',
  "no-param-reassign":
    "export function read(input: { readonly value: string }): string { return input.value; }",
  "typescript/prefer-readonly":
    "export class Owned { private readonly value = 1; read(): number { return this.value; } }",
  "typescript/explicit-module-boundary-types": "export function read(): number { return 1; }",
  "typescript/method-signature-style": "export interface Contract { readonly read: () => string }",
  "typescript/consistent-type-imports":
    'import type { Stats } from "node:fs"; export type Data = Stats;',
  "typescript/consistent-type-exports": 'export type { Stats } from "node:fs";',
  "typescript/no-import-type-side-effects":
    'import type { Stats } from "node:fs"; export type Data = Stats;',
  "import/no-self-import": 'import "node:fs";',
  "import/no-duplicates": 'import "node:fs";',
  "import/no-mutable-exports": "export const value = 1;",
  curly: 'if (Math.random() > 0.5) { console.log("x"); }',
  "no-var": "const value = 1; console.log(value);",
  "prefer-const": "const value = 1; console.log(value);",
  "no-nested-ternary": "export const value = Math.random() > 0.5 ? 1 : 2;",
  "no-return-assign": "export function read(): number { let value = 0; value = 1; return value; }",
  "no-sequences": "let left = 1; let right = 2; left++; right++; console.log(left, right);",
  "no-multi-assign": "let a; let b; a = 1; b = a; console.log(a, b);",
  "no-else-return":
    "export function read(value: boolean): number { if (value) { return 1; } return 2; }",
  "no-eval": 'export const value: unknown = JSON.parse("1");',
  "no-implied-eval": 'setTimeout(() => { console.log("work"); }, 1);',
  "no-new-func": "export function read(): number { return 1; }",
  "no-with": 'console.log("work");',
  "no-debugger": 'console.log("work");',
  "no-control-regex": "export const pattern = /[\\u0000-\\u001F\\u007F]/u;",
  "no-empty": 'try { console.log("work"); } catch (error) { console.log(error); }',
  "no-empty-function":
    "export function sink(): void { /* This telemetry sink owns no buffered work. */ }",
  "unicorn/no-useless-undefined": 'console.log("value");',
  "unicorn/no-abusive-eslint-disable": '// This operation remains checked.\nconsole.log("work");',
};

for (const [name, first, second, acyclic] of [
  [
    "static",
    'import { other } from "./other.ts"; export const value = other;',
    'import { value } from "./probe.ts"; export const other = value;',
    "export const other = 1;",
  ],
  [
    "type-only",
    'import type { Other } from "./other.ts"; export interface Value { readonly other: Other }',
    'import type { Value } from "./probe.ts"; export interface Other { readonly value: Value }',
    "export interface Other { readonly value: number }",
  ],
] as const) {
  nodeTest(`installed import/no-cycle keeps ${name} dependencies checked`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig({ "import/no-cycle": policyRule("import/no-cycle") }),
        "probe.ts": first,
        "other.ts": second,
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["probe.ts"]), [["import(no-cycle)", 1]]);
      },
    );
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig({ "import/no-cycle": policyRule("import/no-cycle") }),
        "probe.ts": first,
        "other.ts": acyclic,
      },
      async (directory) => {
        expectDiagnostics(lint(directory, ["probe.ts"]), []);
      },
    );
  });
}

for (const [index, probe] of probes.entries()) {
  nodeTest(`installed ${probe.rule} option probe ${index}`, async () => {
    const valid = validSources[probe.rule];
    assert(valid !== undefined, `${probe.rule} needs its valid counterpart`);
    const validFile = probe.rule === "no-with" ? "valid.cjs" : "valid.ts";
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig({ [probe.rule]: policyRule(probe.rule) }),
        [probe.rule === "no-with" ? "probe.cjs" : "probe.ts"]: probe.source,
        [validFile]: validFile.endsWith(".ts") ? `${valid}\nexport {};` : valid,
      },
      async (directory) => {
        expectDiagnostics(lint(directory, [validFile]), [], validFile);
        const code = probe.rule.includes("/")
          ? probe.rule.replace("/", "(") + ")"
          : `eslint(${probe.rule})`;
        const filename = probe.rule === "no-with" ? "probe.cjs" : "probe.ts";
        expectDiagnostics(
          lint(directory, [filename]),
          probe.lines.map((line) => [code, line]),
          filename,
        );
      },
    );
  });
}
