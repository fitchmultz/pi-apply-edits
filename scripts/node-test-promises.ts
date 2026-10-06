import type { Rule, Scope } from "eslint";
import {
  bindingValue,
  calleeBinding,
  callbackTargets,
  transparentExpression,
} from "./node-test-bindings.ts";
import { arrayLength, arraySnapshotSafe } from "./node-test-arrays.ts";
import { nonemptyLiteral, type ControlView } from "./test-controls.ts";

interface PromiseView extends ControlView {
  readonly init?: PromiseView | null;
  readonly async?: boolean;
  readonly argument?: ControlView | null;
  readonly typeAnnotation?: {
    readonly typeAnnotation?: {
      readonly returnType?: {
        readonly typeAnnotation?: { readonly type: string; readonly typeName?: ControlView };
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
  return expressionCalls(scope, node, visited);
}

function expressionCalls(
  scope: Scope.Scope,
  node: PromiseView,
  visited: ReadonlySet<unknown>,
): readonly ScopedCall[] {
  if (node.type === "ArrayExpression") {
    return (node.elements ?? []).flatMap((element) =>
      callChain(scope, element ?? undefined, visited),
    );
  }
  if (node.type === "SpreadElement") {
    return callChain(scope, node.argument ?? undefined, visited);
  }
  if (node.type !== "CallExpression") {
    return [];
  }
  return [
    { scope, node },
    ...callChain(scope, node.callee?.object, visited),
    ...consumedInputs(scope, node, visited),
  ];
}

export function promiseReturnFacts(
  scope: Scope.Scope,
  argument: ControlView | undefined,
  owner: number,
): {
  readonly promise: boolean;
  readonly returns: readonly number[];
  readonly parameters: readonly number[];
} {
  const calls = arrayLength(scope, argument) === undefined ? callChain(scope, argument) : [];
  return {
    promise: promiseExpression(scope, argument),
    returns: calls.flatMap((call) => (call.node.range === undefined ? [] : [call.node.range[0]])),
    parameters: calls.flatMap((call) => returnedParameter(call, owner)),
  };
}

function returnedParameter(call: ScopedCall, owner: number): readonly number[] {
  const binding =
    call.node.callee === undefined
      ? undefined
      : calleeBinding(call.scope, call.node.callee).binding;
  return binding?.kind === "parameter" && binding.owner === owner && binding.parameter !== undefined
    ? [binding.parameter]
    : [];
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
  const type = parameter?.typeAnnotation?.typeAnnotation?.returnType?.typeAnnotation;
  return (
    type?.type === "TSTypeReference" &&
    type.typeName?.name === "Promise" &&
    calleeBinding(scope, type.typeName).binding.kind === "native"
  );
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

function consumedInputs(
  scope: Scope.Scope,
  node: PromiseView,
  seen: ReadonlySet<unknown>,
): readonly ScopedCall[] {
  return nativeConsumer(scope, node) === undefined
    ? []
    : callChain(scope, node.arguments?.[0], seen);
}

function nativeConsumer(scope: Scope.Scope, node: PromiseView): string | undefined {
  const resolved = node.callee === undefined ? undefined : calleeBinding(scope, node.callee);
  return resolved?.binding.kind === "native" &&
    /^\.(?:all|allSettled|any|race|resolve)$/u.test(resolved.suffix)
    ? resolved.suffix
    : undefined;
}

export function settlingConsumer(
  scope: Scope.Scope,
  nodes: readonly PromiseView[],
  context: Rule.RuleContext,
): boolean {
  return nodes.some((node) => {
    const method = nativeConsumer(scope, node);
    if (method === ".allSettled") {
      return true;
    }
    const input = node.arguments?.[0];
    if (method !== undefined && !arraySnapshotSafe(scope, input, context)) {
      return true;
    }
    const count = arrayLength(scope, input);
    if (method === ".resolve") {
      return count !== undefined;
    }
    return (method === ".any" || method === ".race") && count !== 1;
  });
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
  return ancestors.some(
    (ancestor) =>
      ancestor.type === "ArrayExpression" ||
      (ancestor.type === "VariableDeclarator" &&
        ancestor.init !== null &&
        callChain(scope, ancestor.init).some((call) => call.node.range?.[0] === node.range?.[0])),
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
