import test from "node:test";
import {
  expectDiagnostics,
  focusedConfig,
  inProbe,
  lint,
  policyRule,
} from "./quality-probe-support.ts";

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
    source: "export function read(value: unknown): string { return String(value); }",
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
    lines: [1],
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
    lines: [1],
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
    rule: "typescript/prefer-readonly-parameter-types",
    source: "export function read(input: { value: string }): string { return input.value; }",
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
    lines: [1],
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
    lines: [1],
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

for (const [name, first, second] of [
  [
    "static",
    'import { other } from "./other.ts"; export const value = other;',
    'import { value } from "./probe.ts"; export const other = value;',
  ],
  [
    "type-only",
    'import type { Other } from "./other.ts"; export interface Value { readonly other: Other }',
    'import type { Value } from "./probe.ts"; export interface Other { readonly value: Value }',
  ],
]) {
  test(`installed import/no-cycle keeps ${name} dependencies checked`, async () => {
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
  });
}

for (const external of [false, true]) {
  for (const ignoreExternal of [false, true]) {
    test(`installed import/no-cycle physical external=${external}, ignoreExternal=${ignoreExternal}`, async () => {
      const path = external ? "node_modules/other-package/index.ts" : "external/index.ts";
      const back = external ? "../../probe.ts" : "../probe.ts";
      await inProbe(
        {
          ".oxlintrc.json": focusedConfig({
            "import/no-cycle": [
              "error",
              { ignoreTypes: false, ignoreExternal, allowUnsafeDynamicCyclicDependency: false },
            ],
          }),
          "probe.ts": `import { other } from "./${path}"; export const value = other;`,
          [path]: `import { value } from "${back}"; export const other = value;`,
          "node_modules/other-package/package.json":
            '{"name":"other-package","main":"index.ts","types":"index.ts"}',
        },
        async (directory) => {
          expectDiagnostics(
            lint(directory, ["probe.ts"]),
            external && ignoreExternal ? [] : [["import(no-cycle)", 1]],
          );
        },
      );
    });
  }
}

for (const allowUnsafeDynamicCyclicDependency of [false, true]) {
  test(`installed import/no-cycle dynamic option ${allowUnsafeDynamicCyclicDependency}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig({
          "import/no-cycle": allowUnsafeDynamicCyclicDependency
            ? [
                "error",
                { ignoreTypes: false, ignoreExternal: false, allowUnsafeDynamicCyclicDependency },
              ]
            : policyRule("import/no-cycle"),
        }),
        "probe.ts": 'import { other } from "./other.ts"; export const value = other;',
        "other.ts": 'export const other = import("./probe.ts");',
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["probe.ts"]),
          allowUnsafeDynamicCyclicDependency ? [] : [["import(no-cycle)", 1]],
        );
      },
    );
  });
}

for (const [index, probe] of probes.entries()) {
  test(`installed ${probe.rule} option probe ${index}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": focusedConfig({ [probe.rule]: policyRule(probe.rule) }),
        [probe.rule === "no-with" ? "probe.cjs" : "probe.ts"]: probe.source,
      },
      async (directory) => {
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
