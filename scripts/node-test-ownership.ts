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
  const direct = [event.binding.target, event.parallel, ...(event.promiseCallbacks ?? [])].filter(
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
  // Saved asynchronous work receives assertion credit only at a failure-visible consumer.
  const producers = new Map(
    flow.segments
      .flatMap((segment) => segment.events)
      .filter((event) => deferredCall(event, flows))
      .map((event) => [event.offset, event]),
  );
  const segments = flow.segments.map((segment) => {
    const events = segment.events.flatMap((event) => [
      normalizeCatches(
        {
          ...event,
          deferred: deferredCall(event, flows),
          promiseCallbacks: (event.promiseSources ?? []).some((target) =>
            returnsPromise(target, flows),
          )
            ? [...event.callbacks.values()]
            : event.promiseCallbacks,
        },
        flow,
        flows,
      ),
      ...(event.producers ?? []).flatMap((offset) => {
        const producer = producers.get(offset);
        return producer === undefined
          ? []
          : [
              normalizeCatches(
                {
                  ...producer,
                  producer: producer.offset,
                  offset: event.offset,
                  end: event.end,
                  line: event.line,
                  deferred: false,
                  conditional: producer.conditional || event.conditional,
                  controls: [...producer.controls, ...event.controls],
                  handlers: [...producer.handlers, ...event.handlers],
                  catches: [...producer.catches, ...event.catches],
                  finalizers: [...producer.finalizers, ...event.finalizers],
                },
                flow,
                flows,
              ),
            ];
      }),
    ]);
    return { id: segment.id, previous: segment.previous, events };
  });
  return { ...flow, segments };
}

function deferredCall(event: CallEvent, flows: readonly FunctionFlow[]): boolean {
  return (
    event.deferred === true &&
    (event.binding.target === undefined || returnsPromise(event.binding.target, flows))
  );
}

function returnsPromise(
  target: number,
  flows: readonly FunctionFlow[],
  seen: ReadonlySet<number> = new Set(),
): boolean {
  if (seen.has(target)) {
    return false;
  }
  const flow = flows.find((candidate) => candidate.start === target);
  return (
    flow?.promise === true ||
    (flow?.promiseTargets ?? []).some((callee) =>
      returnsPromise(callee, flows, new Set(seen).add(target)),
    )
  );
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
    }) ||
    event.finalizers.some((start) => {
      const region = flow.regions.find((candidate) => candidate.start === start);
      return (
        region === undefined ||
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
