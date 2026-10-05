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
  readonly cases?: readonly ControlView[];
}
export interface ControlFacts {
  readonly controls: readonly ConditionalControl[];
  readonly conditional: boolean;
  readonly caught: boolean;
}

export function controlFacts(
  nodes: readonly ControlView[],
  source: string,
  range: readonly [number, number],
): ControlFacts {
  const controls: ConditionalControl[] = [];
  let conditional = false;
  let caught = false;
  for (const node of nodes) {
    if (node.type === "IfStatement") {
      controls.push(ifControl(node, source, range[0]));
    }
    if (node.type === "SwitchStatement") {
      controls.push(switchControl(node));
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
      caught = true;
    }
  }
  return { controls, conditional: conditional || caught, caught };
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
  const left = test.left?.range;
  const right = test.right?.range;
  if (left === undefined || right === undefined) {
    return;
  }
  return [source.slice(left[0], left[1]), source.slice(right[0], right[1])];
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
    ["equal", "strictEqual"].includes(method) &&
    prior.arguments[0] === control.compared[0] &&
    prior.arguments[1] === control.compared[1] &&
    source.slice(prior.end, control.guard).trim() === ";"
  );
}

export function exhaustive(
  event: CallEvent,
  flow: FunctionFlow,
  summaries: ReadonlyMap<number, FlowSummary>,
  context: AssertionContext,
): boolean {
  return (
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
