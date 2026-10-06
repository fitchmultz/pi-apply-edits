import type { Rule, Scope } from "eslint";
import { bindingValue, calleeBinding, transparentExpression } from "./node-test-bindings.ts";
import type { ControlView } from "./test-controls.ts";

interface ArrayView extends ControlView {
  readonly argument?: ControlView | null;
  readonly elements?: readonly (ArrayView | null)[];
}

export function arrayLength(
  scope: Scope.Scope,
  node: ArrayView | undefined,
  seen: ReadonlySet<unknown> = new Set(),
): number | undefined {
  if (node === undefined || seen.has(node)) {
    return;
  }
  const visited = new Set(seen).add(node);
  const expression = transparentExpression(node);
  if (expression !== undefined) {
    return arrayLength(scope, expression, visited);
  }
  if (node.type === "Identifier" && node.name !== undefined) {
    const declaration = bindingValue(scope, node.name);
    return declaration === undefined
      ? undefined
      : arrayLength(declaration.scope, declaration.value, visited);
  }
  return node.type === "ArrayExpression"
    ? expandedLength(scope, node.elements ?? [], visited)
    : undefined;
}

function expandedLength(
  scope: Scope.Scope,
  elements: readonly (ArrayView | null)[],
  seen: ReadonlySet<unknown>,
): number | undefined {
  let length = 0;
  for (const element of elements) {
    const size =
      element?.type === "SpreadElement"
        ? arrayLength(scope, element.argument ?? undefined, seen)
        : 1;
    if (size === undefined) {
      return;
    }
    length += size;
  }
  return length;
}

// ponytail: Snapshot proof admits aggregate reads, aliases and spreads only;
// mutations or other escapes require element-flow analysis before restoring credit.
function arrayOrigin(
  scope: Scope.Scope,
  node: ControlView | undefined,
  seen: ReadonlySet<unknown> = new Set(),
): boolean {
  if (node === undefined || seen.has(node)) {
    return false;
  }
  if (node.type === "ArrayExpression") {
    return true;
  }
  const visited = new Set(seen).add(node);
  const expression = transparentExpression(node);
  if (expression !== undefined) {
    return arrayOrigin(scope, expression, visited);
  }
  if (node.type === "Identifier" && node.name !== undefined) {
    const declaration = bindingValue(scope, node.name);
    return declaration !== undefined && arrayOrigin(declaration.scope, declaration.value, visited);
  }
  return false;
}

export function arraySnapshotSafe(
  scope: Scope.Scope,
  node: ArrayView | undefined,
  context: Rule.RuleContext,
  seen: ReadonlySet<unknown> = new Set(),
): boolean {
  if (node === undefined || !arrayOrigin(scope, node)) {
    return true;
  }
  if (seen.has(node)) {
    return false;
  }
  const visited = new Set(seen).add(node);
  const expression = transparentExpression(node);
  if (expression !== undefined) {
    return arraySnapshotSafe(scope, expression, context, visited);
  }
  if (node.type === "ArrayExpression") {
    return spreadSnapshotsSafe(scope, node.elements ?? [], context, visited);
  }
  return identifierSnapshotSafe(scope, node, context, visited);
}

function identifierSnapshotSafe(
  scope: Scope.Scope,
  node: ArrayView,
  context: Rule.RuleContext,
  seen: ReadonlySet<unknown>,
): boolean {
  if (node.type !== "Identifier" || node.name === undefined) {
    return true;
  }
  const declaration = bindingValue(scope, node.name);
  return (
    declaration === undefined ||
    (referencesSafe(declaration.scope, node.name, context, seen) &&
      arraySnapshotSafe(declaration.scope, declaration.value, context, seen))
  );
}

function spreadSnapshotsSafe(
  scope: Scope.Scope,
  elements: readonly (ArrayView | null)[],
  context: Rule.RuleContext,
  seen: ReadonlySet<unknown>,
): boolean {
  return elements.every(
    (element) =>
      element?.type !== "SpreadElement" ||
      arraySnapshotSafe(scope, element.argument ?? undefined, context, seen),
  );
}

function referencesSafe(
  scope: Scope.Scope,
  name: string,
  context: Rule.RuleContext,
  seen: ReadonlySet<unknown>,
): boolean {
  const variable = bindingValue(scope, name)?.scope.set.get(name);
  if (variable === undefined) {
    return false;
  }
  if (seen.has(variable)) {
    return true;
  }
  const visited = new Set(seen).add(variable);
  return variable.references.every((reference) => {
    if (reference.init) {
      return true;
    }
    const parent = context.sourceCode
      .getAncestors(reference.identifier)
      .findLast(
        (node) =>
          ![
            "TSAsExpression",
            "TSSatisfiesExpression",
            "TSNonNullExpression",
            "TSTypeAssertion",
          ].includes(node.type),
      );
    if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") {
      return referencesSafe(context.sourceCode.getScope(parent), parent.id.name, context, visited);
    }
    if (parent?.type === "SpreadElement") {
      return true;
    }
    return (
      parent?.type === "CallExpression" &&
      aggregateArgument(
        calleeBinding(context.sourceCode.getScope(parent), parent.callee),
        parent.arguments[0]?.range,
        reference.identifier.range,
      )
    );
  });
}

function aggregateArgument(
  resolved: ReturnType<typeof calleeBinding>,
  argument: readonly [number, number] | undefined,
  reference: readonly [number, number] | undefined,
): boolean {
  return (
    resolved.binding.kind === "native" &&
    /^\.(?:all|allSettled|any|race|resolve)$/u.test(resolved.suffix) &&
    argument !== undefined &&
    reference !== undefined &&
    reference[0] >= argument[0] &&
    reference[1] <= argument[1]
  );
}
