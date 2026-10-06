import type { ExpressionView } from "./node-test-bindings.ts";
import {
  assertionCall,
  ownsAssertions,
  proves,
  type CallEvent,
  type FlowSummary,
  type FunctionFlow,
  type ConditionalControl,
  type AssertionContext,
  type AssertionHelper,
} from "./test-flow.ts";

export interface ControlView extends ExpressionView {
  readonly test?: ControlView | null;
  readonly left?: ControlView;
  readonly right?: ControlView;
  readonly operator?: string;
  readonly consequent?: ControlView | readonly ExpressionView[];
  readonly alternate?: ControlView | null;
  readonly block?: ControlView;
  readonly handler?: ControlView | null;
  readonly finalizer?: ExpressionView | null;
  readonly cases?: readonly ControlView[];
  readonly expression?: ControlView | boolean;
  readonly elements?: readonly (ControlView | null)[];
  readonly body?: ExpressionView | readonly ExpressionView[];
  readonly callee?: ControlView;
  readonly arguments?: readonly ControlView[];
}
export interface ControlFacts {
  readonly controls: readonly ConditionalControl[];
  readonly conditional: boolean;
  readonly caught: boolean;
  readonly catches: readonly number[];
  readonly finalizers: readonly number[];
}

export function controlFacts(
  nodes: readonly ControlView[],
  source: string,
  range: readonly [number, number],
): ControlFacts {
  const controls: ConditionalControl[] = [];
  let conditional = false;
  const catches: number[] = [];
  const finalizers: number[] = [];
  for (const node of nodes) {
    const control = conditionalControl(node, source, range[0]);
    if (control !== undefined) {
      controls.push(control);
    }
    if (
      [
        "IfStatement",
        "ConditionalExpression",
        "LogicalExpression",
        "SwitchCase",
        "CatchClause",
      ].includes(node.type)
    ) {
      conditional = true;
    }
    if (swallowedByTry(node, range)) {
      catches.push(branchRange(node.handler?.body)?.[0] ?? -1);
    }
    const finalizer = overridingFinalizer(node, range);
    if (finalizer !== undefined) {
      finalizers.push(finalizer);
    }
  }
  return { controls, conditional, caught: false, catches, finalizers };
}

function overridingFinalizer(
  node: ControlView,
  range: readonly [number, number],
): number | undefined {
  const finalizer = node.finalizer?.range;
  return node.type === "TryStatement" && finalizer !== undefined && !contains(finalizer, range)
    ? finalizer[0]
    : undefined;
}

export function nonemptyLiteral(node: ControlView | undefined): boolean {
  if (node === undefined) {
    return false;
  }
  if (["TSAsExpression", "TSSatisfiesExpression"].includes(node.type)) {
    return typeof node.expression !== "boolean" && nonemptyLiteral(node.expression);
  }
  if (nativeArrayIterator(node)) {
    return nonemptyLiteral(node.callee?.object);
  }
  if (node.type !== "ArrayExpression" || node.elements === undefined) {
    return false;
  }
  return node.elements.some((element) => element === null || element.type !== "SpreadElement");
}

function nativeArrayIterator(node: ControlView): boolean {
  return (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.computed !== true &&
    ["entries", "values"].includes(node.callee.property?.name ?? "") &&
    node.arguments?.length === 0
  );
}

function conditionalControl(
  node: ControlView,
  source: string,
  offset: number,
): ConditionalControl | undefined {
  if (node.type === "IfStatement") {
    return ifControl(node, source, offset);
  }
  if (node.type === "SwitchStatement") {
    return switchControl(node);
  }
  if (optionalBoundary(node)) {
    return { parts: [], exhaustive: false };
  }
  return;
}

function optionalBoundary(node: ControlView): boolean {
  if (node.type === "ForOfStatement") {
    return !nonemptyLiteral(node.right);
  }
  return [
    "ForStatement",
    "ForInStatement",
    "WhileStatement",
    "ConditionalExpression",
    "LogicalExpression",
  ].includes(node.type);
}

function swallowedByTry(node: ControlView, range: readonly [number, number]): boolean {
  return (
    node.type === "TryStatement" &&
    node.handler !== undefined &&
    node.handler !== null &&
    contains(node.block?.range, range)
  );
}

function switchControl(node: ControlView): ConditionalControl {
  const cases = node.cases ?? [];
  return {
    parts: cases.flatMap((branch) => (branch.range === undefined ? [] : [branch.range[0]])),
    exhaustive: cases.some((branch) => branch.test === null),
  };
}

function contains(
  outer: readonly [number, number] | undefined,
  inner: readonly [number, number],
): boolean {
  return outer !== undefined && inner[0] >= outer[0] && inner[1] <= outer[1];
}
function ifControl(node: ControlView, source: string, offset: number): ConditionalControl {
  const consequent = branchRange(node.consequent)?.[0];
  const alternate = node.alternate?.range?.[0];

  const compared = comparison(node, source, offset);
  return {
    parts: [consequent, alternate].filter((part): part is number => part !== undefined),
    exhaustive: consequent !== undefined && alternate !== undefined,
    guard: node.range?.[0],
    compared,
  };
}

function branchRange(node: ControlView["consequent"]): readonly [number, number] | undefined {
  return node !== undefined && "type" in node ? node.range : undefined;
}

function comparison(
  node: ControlView,
  source: string,
  offset: number,
): readonly [string, string] | undefined {
  const test = node.test;
  if (test?.type !== "BinaryExpression" || test.operator !== "===") {
    return;
  }
  if (offset >= (node.alternate?.range?.[0] ?? Infinity)) {
    return;
  }
  return comparedValues(test, source);
}

function comparedValues(test: ControlView, source: string): readonly [string, string] | undefined {
  if (!stableOperand(test.left) || !stableOperand(test.right)) {
    return;
  }
  const left = test.left?.range;
  const right = test.right?.range;
  if (left === undefined || right === undefined) {
    return;
  }
  return [source.slice(left[0], left[1]), source.slice(right[0], right[1])];
}

// ponytail: calls and accessors need saved-value snapshots; richer proof requires effect analysis.
export function stableOperand(node: ExpressionView | undefined): boolean {
  return node !== undefined && ["Identifier", "Literal", "ThisExpression"].includes(node.type);
}

export function failClosed(
  event: CallEvent,
  flow: FunctionFlow,
  source: string,
  helpers: readonly AssertionHelper[],
): boolean {
  return (
    !event.caught &&
    event.controls.length > 0 &&
    event.controls.every(
      (control) =>
        control.compared !== undefined &&
        control.guard !== undefined &&
        flow.segments
          .flatMap((segment) => segment.events)
          .some((prior) => hardDiscriminator(prior, control, source, helpers)),
    )
  );
}
function hardDiscriminator(
  prior: CallEvent,
  control: ConditionalControl,
  source: string,
  helpers: readonly AssertionHelper[],
): boolean {
  if (
    prior.caught ||
    !prior.stableArguments ||
    !assertionCall(prior, helpers) ||
    control.compared === undefined ||
    control.guard === undefined
  ) {
    return false;
  }
  const method =
    prior.suffix.length > 0
      ? prior.suffix.slice(prior.suffix.lastIndexOf(".") + 1)
      : prior.binding.name;
  return (
    strictEquality(prior, method) &&
    prior.arguments[0] === control.compared[0] &&
    prior.arguments[1] === control.compared[1] &&
    source.slice(prior.end, control.guard).trim() === ";"
  );
}

function strictEquality(prior: CallEvent, method: string): boolean {
  return (
    method === "strictEqual" ||
    (method === "equal" &&
      (prior.binding.source === "node:assert/strict" || prior.suffix.startsWith(".strict.")))
  );
}

export function exhaustive(
  event: CallEvent,
  flow: FunctionFlow,
  summaries: ReadonlyMap<number, FlowSummary>,
  context: AssertionContext,
): boolean {
  return (
    !event.caught &&
    event.controls.length > 0 &&
    event.controls.every(
      (control) =>
        control.exhaustive &&
        control.parts.every((start) => {
          const region = flow.regions.find((candidate) => candidate.start === start);
          if (region === undefined) {
            return false;
          }
          const exits = [
            ...region.exits,
            ...flow.returnSites
              .filter((site) => site.offset >= region.start && site.offset <= region.end)
              .flatMap((site) => site.segments),
          ];
          return proves(
            { ...flow, returns: exits },
            (candidate) =>
              candidate.offset >= region.start &&
              candidate.offset <= region.end &&
              ownsAssertions(candidate, summaries, context),
          );
        }),
    )
  );
}
