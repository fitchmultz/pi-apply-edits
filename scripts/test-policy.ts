import { parseSync, Visitor } from "oxc-parser";
import type { PolicyFinding } from "./suppression-policy.ts";

const equalityAssertions = new Set(["equal", "strictEqual"]);

interface Span {
  readonly start: number;
  readonly end: number;
}
interface Assertion extends Span {
  readonly arguments: readonly string[];
  readonly hardEquality: boolean;
}
interface Branch extends Span {
  readonly compared: readonly string[];
  readonly guardStart: number;
}
interface Evidence {
  readonly registrations: readonly Span[];
  readonly assertions: readonly Assertion[];
  readonly helpers: readonly Span[];
  readonly branches: readonly Branch[];
}

export function checkTestAssertions(
  path: string,
  source: string,
  assertionHelpers: readonly string[] = [],
): readonly PolicyFinding[] {
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) {
    return [];
  }
  const evidence = collectEvidence(path, source, assertionHelpers);
  const findings: PolicyFinding[] = [];
  for (const registration of evidence.registrations) {
    const local = [...evidence.assertions, ...evidence.helpers].filter((assertion) =>
      within(assertion, registration),
    );
    if (local.length === 0) {
      findings.push(
        finding(path, source, registration.start, {
          rule: "node-test/expect-assertions",
          message: "node:test callback must execute assertions or a real assertion helper",
        }),
      );
    }
    for (const assertion of local) {
      const branch = evidence.branches.find((candidate) => within(assertion, candidate));
      if (
        branch !== undefined &&
        !provedBranch(branch, evidence.assertions, registration, source)
      ) {
        findings.push(
          finding(path, source, assertion.start, {
            rule: "node-test/no-conditional-assertions",
            message:
              "Conditional assertions must fail closed; throw before payload assertions or assert the same discriminator immediately before its equality guard",
          }),
        );
      }
    }
  }
  return findings;
}

function importedNames(
  path: string,
  source: string,
): { readonly tests: ReadonlySet<string>; readonly asserts: ReadonlySet<string> } {
  const tests = new Set<string>();
  const asserts = new Set<string>();
  new Visitor({
    ImportDeclaration(node) {
      for (const specifier of node.specifiers) {
        if (node.source.value === "node:test" && specifier.type !== "ImportNamespaceSpecifier") {
          const imported =
            specifier.type === "ImportSpecifier"
              ? source.slice(specifier.imported.start, specifier.imported.end)
              : "test";
          if (["test", "it", "default"].includes(imported)) {
            tests.add(specifier.local.name);
          }
        }
        if (node.source.value.startsWith("node:assert")) {
          asserts.add(specifier.local.name);
        }
      }
    },
  }).visit(parseSync(path, source).program);
  return { tests, asserts };
}

function collectEvidence(
  path: string,
  source: string,
  assertionHelpers: readonly string[],
): Evidence {
  const { registrations, assertions, calls } = collectCalls(path, source);
  const declarations: Array<{ readonly name: string; readonly body: Span }> = [];
  const branches: Branch[] = [];
  const text = (span: Span): string => source.slice(span.start, span.end).replace(/\s+/gu, "");
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id !== null && node.body !== null) {
        declarations.push({ name: node.id.name, body: node.body });
      }
    },
    IfStatement(node) {
      const compared =
        node.test.type === "BinaryExpression" && node.test.operator === "==="
          ? [text(node.test.left), text(node.test.right)]
          : [];
      branches.push({
        start: node.consequent.start,
        end: node.consequent.end,
        compared,
        guardStart: node.start,
      });
      if (node.alternate !== null) {
        branches.push({ ...node.alternate, compared: [], guardStart: node.start });
      }
    },
    ConditionalExpression(node) {
      branches.push({
        start: node.consequent.start,
        end: node.alternate.end,
        compared: [],
        guardStart: node.start,
      });
    },
    LogicalExpression(node) {
      branches.push({ ...node.right, compared: [], guardStart: node.start });
    },
    SwitchCase(node) {
      branches.push({ ...node, compared: [], guardStart: node.start });
    },
  }).visit(parseSync(path, source).program);
  const helperNames = new Set(
    declarations
      .filter((declaration) =>
        assertions.some(
          (assertion) =>
            within(assertion, declaration.body) &&
            !branches.some((branch) => within(assertion, branch)),
        ),
      )
      .map((declaration) => declaration.name),
  );
  return {
    registrations,
    assertions,
    branches,
    helpers: calls.filter(
      (call) => helperNames.has(call.name) || assertionHelpers.includes(call.name),
    ),
  };
}

function collectCalls(
  path: string,
  source: string,
): {
  readonly registrations: readonly Span[];
  readonly assertions: readonly Assertion[];
  readonly calls: readonly (Span & { readonly name: string })[];
} {
  const names = importedNames(path, source);
  const registrations: Span[] = [];
  const assertions: Assertion[] = [];
  const calls: Array<Span & { readonly name: string }> = [];
  const text = (span: Span): string => source.slice(span.start, span.end).replace(/\s+/gu, "");
  new Visitor({
    CallExpression(node) {
      const name = node.callee.type === "Identifier" ? node.callee.name : text(node.callee);
      calls.push({ start: node.start, end: node.end, name });
      const root = name.split(".")[0] ?? "";
      if (names.asserts.has(root)) {
        assertions.push({
          start: node.start,
          end: node.end,
          arguments: node.arguments.map(text),
          hardEquality: equalityAssertions.has(name.slice(name.lastIndexOf(".") + 1)),
        });
      }
      if (!names.tests.has(root) && !name.endsWith(".test")) {
        return;
      }
      const callback = node.arguments.at(-1);
      if (
        callback === undefined ||
        (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression")
      ) {
        return;
      }
      if (callback.body !== null) {
        registrations.push(callback.body);
      }
    },
  }).visit(parseSync(path, source).program);
  return { registrations, assertions, calls };
}

function within(inner: Span, outer: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function provedBranch(
  branch: Branch,
  assertions: readonly Assertion[],
  registration: Span,
  source: string,
): boolean {
  return (
    branch.compared.length === 2 &&
    assertions.some(
      (assertion) =>
        within(assertion, registration) &&
        assertion.end < branch.guardStart &&
        source.slice(assertion.end, branch.guardStart).trim() === ";" &&
        assertion.hardEquality &&
        assertion.arguments[0] === branch.compared[0] &&
        assertion.arguments[1] === branch.compared[1],
    )
  );
}

function finding(
  path: string,
  source: string,
  offset: number,
  detail: { readonly rule: string; readonly message: string },
): PolicyFinding {
  return { path, line: source.slice(0, offset).split("\n").length, ...detail };
}
