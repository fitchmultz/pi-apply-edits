import type { Scope } from "eslint";
import type { CallBinding } from "./test-flow.ts";

export interface ExpressionView {
  readonly type: string;
  readonly range?: readonly [number, number];
  readonly name?: string;
  readonly object?: ExpressionView;
  readonly property?: ExpressionView;
  readonly computed?: boolean;
  readonly value?: unknown;
}

export function calleeBinding(
  scope: Scope.Scope,
  input: ExpressionView,
): { readonly binding: CallBinding; readonly suffix: string } {
  let callee = input;
  const members: string[] = [];
  while (callee.type === "MemberExpression") {
    const member = callee.property;
    const name = callee.computed === true ? member?.value : member?.name;
    if (typeof name !== "string" || callee.object === undefined) {
      return { binding: { kind: "unknown", name: "" }, suffix: "" };
    }
    members.unshift(name);
    callee = callee.object;
  }
  const binding =
    callee.type === "Identifier" && callee.name !== undefined
      ? findBinding(scope, callee.name)
      : ({
          kind: "function",
          name: "",
          target: functionTarget(scope, callee),
        } satisfies CallBinding);
  return { binding, suffix: members.length > 0 ? `.${members.join(".")}` : "" };
}

export function functionTarget(scope: Scope.Scope, node: ExpressionView): number | undefined {
  if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
    return node.range?.[0];
  }
  if (node.type === "Identifier" && node.name !== undefined) {
    return findBinding(scope, node.name).target;
  }
  return;
}

interface VariableView extends ExpressionView {
  readonly init?: ExpressionView | null;
}
function variableTarget(scope: Scope.Scope, node: VariableView): number | undefined {
  if (node.init === null || node.init === undefined) {
    return;
  }
  return functionTarget(scope, node.init);
}

export function callbackTargets(
  scope: Scope.Scope,
  nodes: readonly ExpressionView[],
): ReadonlyMap<number, number> {
  const callbacks = new Map<number, number>();
  nodes.forEach((argument, index) => {
    const target = functionTarget(scope, argument);
    if (target !== undefined) {
      callbacks.set(index, target);
    }
  });
  return callbacks;
}

interface ImportView extends ExpressionView {
  readonly imported?: ExpressionView;
}
function importName(node: ImportView): string {
  if (node.type === "ImportNamespaceSpecifier") {
    return "*";
  }
  if (node.type !== "ImportSpecifier") {
    return "default";
  }
  return (
    node.imported?.name ?? (typeof node.imported?.value === "string" ? node.imported.value : "")
  );
}

function findBinding(initial: Scope.Scope, name: string): CallBinding {
  let scope: Scope.Scope | null = initial;
  let resolved = name;
  const seen = new Set<Scope.Variable>();
  while (scope !== null) {
    const variable = scope.set.get(resolved);
    if (variable === undefined) {
      scope = scope.upper;
      continue;
    }
    const definition = variable.defs.at(0);
    if (definition === undefined) {
      return { kind: "unknown", name };
    }
    if (variable.references.some((reference) => reference.isWrite() && !reference.init)) {
      return { kind: "unknown", name };
    }
    if (seen.has(variable)) {
      return { kind: "unknown", name };
    }
    seen.add(variable);
    if (definition.type === "Variable" && definition.node.init?.type === "Identifier") {
      resolved = definition.node.init.name;
      continue;
    }
    return declaredBinding(scope, resolved);
  }
  return { kind: "unknown", name };
}

function declaredBinding(scope: Scope.Scope, name: string): CallBinding {
  const definition = scope.set.get(name)?.defs.at(0);
  if (definition === undefined) {
    return { kind: "unknown", name };
  }
  switch (definition.type) {
    case "ImportBinding": {
      const imported = importName(definition.node);
      return {
        kind: "import",
        name: imported,
        source:
          typeof definition.parent.source.value === "string"
            ? definition.parent.source.value
            : undefined,
      };
    }
    case "FunctionName":
      return { kind: "function", name, target: definition.node.range?.[0] };
    case "Variable":
      return { kind: "function", name, target: variableTarget(scope, definition.node) };
    case "Parameter":
      return {
        kind: "parameter",
        name,
        owner: definition.node.range?.[0],
        parameter: definition.node.params.findIndex((parameter) => parameter === definition.name),
      };
    case "CatchClause":
    case "ClassName":
    case "ImplicitGlobalVariable":
    case "TDZ":
      return { kind: "unknown", name };
  }
}
