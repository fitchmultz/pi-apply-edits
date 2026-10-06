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
  seen: ReadonlySet<unknown> = new Set(),
): { readonly binding: CallBinding; readonly suffix: string } {
  const { callee, members } = calleeParts(input);
  if (callee === undefined) {
    return { binding: { kind: "unknown", name: "" }, suffix: "" };
  }
  const binding =
    callee.type === "Identifier" && callee.name !== undefined
      ? findBinding(scope, callee.name, seen)
      : ({
          kind: "function",
          name: "",
          target: functionTarget(scope, callee),
        } satisfies CallBinding);
  return {
    binding,
    suffix: (binding.member ?? "") + (members.length > 0 ? `.${members.join(".")}` : ""),
  };
}

function calleeParts(input: ExpressionView): {
  readonly callee?: ExpressionView;
  readonly members: readonly string[];
} {
  let callee = input;
  const members: string[] = [];
  while (callee.type === "MemberExpression") {
    const member = callee.property;
    const name = callee.computed === true ? member?.value : member?.name;
    if (typeof name !== "string" || callee.object === undefined) {
      return { members };
    }
    members.unshift(name);
    callee = callee.object;
  }
  return { callee, members };
}

export function transparentExpression(
  node: ExpressionView & { readonly expression?: ExpressionView | boolean },
): ExpressionView | undefined {
  return [
    "TSAsExpression",
    "TSSatisfiesExpression",
    "TSNonNullExpression",
    "TSTypeAssertion",
    "ChainExpression",
  ].includes(node.type) && typeof node.expression !== "boolean"
    ? node.expression
    : undefined;
}

export function functionTarget(
  scope: Scope.Scope,
  node: ExpressionView & { readonly expression?: ExpressionView | boolean },
): number | undefined {
  const expression = transparentExpression(node);
  if (expression !== undefined) {
    return functionTarget(scope, expression);
  }
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
/** Only immutable local declarations can carry a saved call's identity. */
export function bindingValue(
  initial: Scope.Scope,
  name: string,
): { readonly scope: Scope.Scope; readonly value: ExpressionView } | undefined {
  let scope: Scope.Scope | null = initial;
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable === undefined) {
      scope = scope.upper;
      continue;
    }
    if (variable.references.some((reference) => reference.isWrite() && !reference.init)) {
      return;
    }
    return declarationValue(variable.scope, name);
  }
  return;
}

function declarationValue(
  scope: Scope.Scope,
  name: string,
): { readonly scope: Scope.Scope; readonly value: ExpressionView } | undefined {
  const definition = scope.set.get(name)?.defs.at(0);
  if (definition?.type === "Variable") {
    return definition.node.init === null || definition.node.init === undefined
      ? undefined
      : { scope, value: definition.node.init };
  }
  if (definition?.type === "Parameter") {
    return { scope, value: definition.name };
  }
  return definition?.type === "FunctionName" ? { scope, value: definition.node } : undefined;
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

function findBinding(
  initial: Scope.Scope,
  name: string,
  seen: ReadonlySet<unknown> = new Set(),
): CallBinding {
  let scope: Scope.Scope | null = initial;
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable === undefined) {
      scope = scope.upper;
      continue;
    }
    if (
      seen.has(variable) ||
      variable.references.some((reference) => reference.isWrite() && !reference.init)
    ) {
      return { kind: "unknown", name };
    }
    return variableBinding(scope, name, seen);
  }
  return { kind: name === "Promise" ? "native" : "unknown", name };
}

function variableBinding(
  scope: Scope.Scope,
  name: string,
  seen: ReadonlySet<unknown>,
): CallBinding {
  const variable = scope.set.get(name);
  if (variable === undefined) {
    return { kind: "unknown", name };
  }
  const definition = variable.defs.at(0);
  if (definition === undefined && name === "Promise") {
    return { kind: "native", name };
  }
  const visited = new Set(seen);
  visited.add(variable);
  if (
    definition?.type === "Variable" &&
    definition.node.init !== null &&
    definition.node.init !== undefined
  ) {
    const init = definition.node.init;
    if (init.type === "Identifier" || init.type === "MemberExpression") {
      const result = calleeBinding(variable.scope, init, visited);
      return { ...result.binding, member: result.suffix + patternMember(definition.node.id, name) };
    }
  }
  return declaredBinding(variable.scope, name);
}

function declaredBinding(scope: Scope.Scope, name: string): CallBinding {
  const definition = scope.set.get(name)?.defs.at(0);
  if (definition === undefined) {
    return { kind: "unknown", name };
  }
  switch (definition.type) {
    case "ImportBinding":
      return {
        kind: "import",
        name: importName(definition.node),
        source:
          typeof definition.parent.source.value === "string"
            ? definition.parent.source.value
            : undefined,
      };
    case "FunctionName":
      return { kind: "function", name, target: definition.node.range?.[0] };
    case "Variable":
      return { kind: "function", name, target: variableTarget(scope, definition.node) };
    case "Parameter":
      return parameterBinding(name, definition.node, definition.name);
    case "CatchClause":
    case "ClassName":
    case "ImplicitGlobalVariable":
    case "TDZ":
      return { kind: "unknown", name };
  }
  return { kind: "unknown", name };
}

interface ParameterOwner extends ExpressionView {
  readonly params: readonly ExpressionView[];
}
interface PatternView extends ExpressionView {
  readonly properties?: readonly {
    readonly type: string;
    readonly computed?: boolean;
    readonly key?: ExpressionView;
    readonly value?: ExpressionView;
  }[];
}

function patternMember(pattern: PatternView, name: string): string {
  const property = pattern.properties?.find(
    (entry) => entry.type === "Property" && entry.computed !== true && entry.value?.name === name,
  );
  return property?.key?.name === undefined ? "" : `.${property.key.name}`;
}

function parameterBinding(
  name: string,
  node: ParameterOwner,
  identifier: ExpressionView,
): CallBinding {
  const range = identifier.range;
  if (range === undefined) {
    return { kind: "unknown", name };
  }
  const parameter = node.params.findIndex(
    (entry) =>
      entry.range !== undefined && range[0] >= entry.range[0] && range[1] <= entry.range[1],
  );
  const pattern: PatternView | undefined = node.params.at(parameter);
  const property = pattern?.properties?.find(
    (entry) =>
      entry.type === "Property" && entry.computed !== true && entry.value?.range?.[0] === range[0],
  );
  return {
    kind: "parameter",
    name,
    owner: node.range?.[0],
    parameter,
    member: property?.key?.name === undefined ? undefined : `.${property.key.name}`,
  };
}
