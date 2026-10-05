import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertionCall,
  type AssertionContext,
  type CallEvent,
  type FlowSummary,
  type FunctionFlow,
} from "./test-flow.ts";

export function ownedFunctions(
  flows: readonly FunctionFlow[],
  contexts: ReadonlySet<number>,
  summaries: ReadonlyMap<number, FlowSummary>,
  context: AssertionContext,
): ReadonlySet<number> {
  const owned = new Set(contexts);
  for (let pass = 0; pass <= flows.length; pass += 1) {
    for (const flow of flows.filter((candidate) => owned.has(candidate.start))) {
      flow.segments
        .flatMap((segment) => segment.events)
        .flatMap((event) => ownedTargets(event, summaries, context))
        .forEach((target) => {
          owned.add(target);
        });
    }
  }
  return owned;
}

function ownedTargets(
  event: CallEvent,
  summaries: ReadonlyMap<number, FlowSummary>,
  context: AssertionContext,
): readonly number[] {
  const direct = [event.binding.target, event.parallel].filter(
    (target): target is number => target !== undefined,
  );
  if (assertionCall(event, context.helpers)) {
    return [...direct, ...event.callbacks.values()];
  }
  const wrapper = context.wrappers.find(
    (entry) => entry.source === event.binding.source && entry.name === event.binding.name,
  );
  const indices =
    wrapper === undefined
      ? (summaries.get(event.binding.target ?? -1)?.callbacks ?? [])
      : [wrapper.callback];
  return [
    ...direct,
    ...[...indices].flatMap((index) => {
      const target = event.callbacks.get(index);
      return target === undefined ? [] : [target];
    }),
  ];
}

export function normalizedFlow(flow: FunctionFlow, flows: readonly FunctionFlow[]): FunctionFlow {
  const segments = flow.segments.map((segment) => {
    const events = segment.events.map((event) => normalizeCatches(event, flow, flows));
    return { id: segment.id, previous: segment.previous, events };
  });
  return { ...flow, segments };
}

function normalizeCatches(
  event: CallEvent,
  flow: FunctionFlow,
  flows: readonly FunctionFlow[],
): CallEvent {
  const caught =
    event.handlers.some((target) => {
      const handler = flows.find((candidate) => candidate.start === target);
      return handler === undefined || handler.returns.length > 0 || handler.throws.length === 0;
    }) ||
    event.catches.some((start) => {
      const region = flow.regions.find((candidate) => candidate.start === start);
      return (
        region === undefined ||
        region.exits.length > 0 ||
        flow.returnSites.some((site) => site.offset >= region.start && site.offset <= region.end)
      );
    });
  return { ...event, caught, conditional: event.conditional || caught };
}

export function canonicalPath(base: string, path: string): string {
  const absolute = resolve(base, path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
