import type { Scope } from "eslint";
import { bindingValue, calleeBinding, callbackTargets } from "./node-test-bindings.ts";
import { nonemptyLiteral, type ControlView } from "./test-controls.ts";

interface PromiseView extends ControlView {
  readonly init?: PromiseView | null;
  readonly async?: boolean;
  readonly typeAnnotation?: {
    readonly typeAnnotation?: {
      readonly returnType?: {
        readonly typeAnnotation?: { readonly type: string };
      };
    };
  };
}

interface ScopedCall {
  readonly scope: Scope.Scope;
  readonly node: PromiseView;
}

/** Follow actual immutable declarations, never a same-named global or a rewritten binding. */
export function callChain(
  scope: Scope.Scope,
  node: PromiseView | undefined,
  seen: ReadonlySet<unknown> = new Set(),
): readonly ScopedCall[] {
  if (node === undefined || seen.has(node)) {
    return [];
  }
  const visited = new Set(seen).add(node);
  const expression = transparentExpression(node);
  if (expression !== undefined) {
    return callChain(scope, expression, visited);
  }
  if (node.type === "Identifier" && node.name !== undefined) {
    const declaration = bindingValue(scope, node.name);
    return declaration === undefined
      ? []
      : callChain(declaration.scope, declaration.value, visited);
  }
  if (node.type !== "CallExpression") {
    return [];
  }
  return [
    { scope, node },
    ...callChain(scope, node.callee?.object, visited),
    ...parallelInputs(scope, node).flatMap((input) =>
      callChain(scope, input ?? undefined, visited),
    ),
  ];
}

export function promiseExpression(
  scope: Scope.Scope,
  node: PromiseView | undefined,
  seen: ReadonlySet<unknown> = new Set(),
): boolean {
  if (node === undefined || seen.has(node)) {
    return false;
  }
  const visited = new Set(seen).add(node);
  const expression = transparentExpression(node);
  if (expression !== undefined) {
    return promiseExpression(scope, expression, visited);
  }
  if (node.type === "Identifier" && node.name !== undefined) {
    const declaration = bindingValue(scope, node.name);
    return (
      declaration !== undefined && promiseExpression(declaration.scope, declaration.value, visited)
    );
  }
  if (node.callee === undefined) {
    return false;
  }
  const { binding, suffix } = calleeBinding(scope, node.callee);
  return promiseCall(scope, node, { binding, suffix }, visited);
}

function promiseCall(
  scope: Scope.Scope,
  node: PromiseView,
  resolved: ReturnType<typeof calleeBinding>,
  seen: ReadonlySet<unknown>,
): boolean {
  const { binding, suffix } = resolved;
  if (binding.kind === "native") {
    return (
      node.type === "NewExpression" ||
      /^\.(?:resolve|reject|all|allSettled|race|any)$/u.test(suffix)
    );
  }
  if (promiseMethod(node) !== undefined) {
    return promiseExpression(scope, node.callee?.object, seen);
  }
  if (nativeAsyncAssertion(resolved)) {
    return true;
  }
  if (binding.kind === "parameter" && suffix === "") {
    return parameterPromise(scope, node.callee?.name ?? "");
  }
  return asyncFunction(scope, node.callee);
}

function parameterPromise(scope: Scope.Scope, name: string): boolean {
  const parameter: PromiseView | undefined = bindingValue(scope, name)?.value;
  const type = parameter?.typeAnnotation?.typeAnnotation?.returnType?.typeAnnotation?.type;
  return ![
    "TSVoidKeyword",
    "TSNeverKeyword",
    "TSUndefinedKeyword",
    "TSNumberKeyword",
    "TSStringKeyword",
    "TSBooleanKeyword",
    "TSNullKeyword",
  ].includes(type ?? "");
}

function asyncFunction(
  scope: Scope.Scope,
  node: PromiseView | undefined,
  seen: ReadonlySet<unknown> = new Set(),
): boolean {
  if (node === undefined || seen.has(node)) {
    return false;
  }
  if (node.type === "Identifier" && node.name !== undefined) {
    const declaration = bindingValue(scope, node.name);
    return (
      declaration !== undefined &&
      asyncFunction(declaration.scope, declaration.value, new Set(seen).add(node))
    );
  }
  return node.async === true;
}

function transparentExpression(node: ControlView): ControlView | undefined {
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

function parallelInputs(scope: Scope.Scope, node: PromiseView): readonly (ControlView | null)[] {
  const resolved = node.callee === undefined ? undefined : calleeBinding(scope, node.callee);
  return resolved?.binding.kind === "native" && resolved.suffix === ".all"
    ? (node.arguments?.[0]?.elements ?? [])
    : [];
}

function nativeAsyncAssertion({ binding, suffix }: ReturnType<typeof calleeBinding>): boolean {
  if (
    binding.kind !== "import" ||
    !["node:assert", "node:assert/strict"].includes(binding.source ?? "")
  ) {
    return false;
  }
  return (
    (["rejects", "doesNotReject"].includes(binding.name) && suffix === "") ||
    (["default", "*"].includes(binding.name) &&
      /^\.(?:strict\.)?(?:rejects|doesNotReject)$/u.test(suffix))
  );
}

function promiseMethod(node: PromiseView): string | undefined {
  const callee = node.callee;
  const name = callee?.computed === true ? callee.property?.value : callee?.property?.name;
  return callee?.type === "MemberExpression" &&
    typeof name === "string" &&
    ["then", "catch", "finally"].includes(name)
    ? name
    : undefined;
}

export function promiseCallbacks(scope: Scope.Scope, node: PromiseView): readonly number[] {
  const method = promiseMethod(node);
  if (method === undefined || !promiseExpression(scope, node.callee?.object)) {
    return [];
  }
  const callbacks = callbackTargets(scope, node.arguments ?? []);
  return (method === "then" ? [0, 1] : [0]).flatMap((index) => {
    const target = callbacks.get(index);
    return target === undefined ? [] : [target];
  });
}

export function promiseSources(scope: Scope.Scope, node: PromiseView): readonly number[] {
  if (promiseMethod(node) === undefined) {
    return [];
  }
  return callChain(scope, node.callee?.object).flatMap((call) => {
    const target =
      call.node.callee === undefined
        ? undefined
        : calleeBinding(call.scope, call.node.callee).binding.target;
    return target === undefined ? [] : [target];
  });
}

export function savedPromise(
  scope: Scope.Scope,
  node: PromiseView,
  ancestors: readonly PromiseView[],
): boolean {
  const local =
    node.callee === undefined ? undefined : calleeBinding(scope, node.callee).binding.target;
  return ancestors.some(
    (ancestor) =>
      ancestor.type === "VariableDeclarator" &&
      ancestor.init !== null &&
      (promiseExpression(scope, ancestor.init) || local !== undefined) &&
      callChain(scope, ancestor.init).some((call) => call.node.range?.[0] === node.range?.[0]),
  );
}

export function rejectionHandlers(
  scope: Scope.Scope,
  nodes: readonly ControlView[],
): readonly number[] {
  return nodes.flatMap((node) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression") {
      return [];
    }
    const method = calleeBinding(scope, node.callee).suffix;
    const index = rejectionIndex(method);
    const handler = node.arguments?.[index];
    if (index < 0 || absentHandler(handler)) {
      return [];
    }
    return [callbackTargets(scope, node.arguments ?? []).get(index) ?? -1];
  });
}

function rejectionIndex(method: string): number {
  if (method.endsWith(".catch")) {
    return 0;
  }
  return method.endsWith(".then") ? 1 : -1;
}

function absentHandler(handler: ControlView | undefined): boolean {
  return handler === undefined || handler.value === null || handler.name === "undefined";
}

export function parallelTarget(
  scope: Scope.Scope,
  node: ControlView,
  resolved: { readonly binding: { readonly kind: string }; readonly suffix: string },
  ancestors: readonly ControlView[],
): number | undefined {
  if (resolved.binding.kind !== "native" || resolved.suffix !== ".all") {
    return;
  }
  const parent = ancestors.at(-1);
  if (parent === undefined || !["AwaitExpression", "ReturnStatement"].includes(parent.type)) {
    return;
  }
  return mappedTarget(scope, node.arguments?.[0]);
}

function mappedTarget(scope: Scope.Scope, input: ControlView | undefined): number | undefined {
  if (
    input?.type !== "CallExpression" ||
    input.callee?.type !== "MemberExpression" ||
    input.callee.property?.name !== "map" ||
    !nonemptyLiteral(input.callee.object)
  ) {
    return;
  }
  return callbackTargets(scope, input.arguments ?? []).get(0);
}
