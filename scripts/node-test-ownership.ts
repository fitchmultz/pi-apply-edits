import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertionCall,
  type AssertionContext,
  type CallEvidence,
  type RawCallEvent,
  type RawFunctionFlow,
  type ResolvedCallEvent,
  type ResolvedFunctionFlow,
  type FlowSummary,
} from "./test-flow.ts";

export function ownedFunctions(
  flows: readonly ResolvedFunctionFlow[],
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
  event: ResolvedCallEvent,
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
      ? (summaries.get(event.binding.target ?? -1)?.calledCallbacks ?? [])
      : [wrapper.callback];
  return [
    ...direct,
    ...[...indices].flatMap((index) => {
      const target = event.callbacks.get(index);
      return target === undefined ? [] : [target];
    }),
  ];
}

export function assertionSites(flow: ResolvedFunctionFlow): Iterable<ResolvedCallEvent> {
  const sites = flow.segments.flatMap((segment) => segment.events);
  const consumed = new Set(
    sites.flatMap((event) => (event.evidence.kind === "consumed" ? [event.evidence.producer] : [])),
  );
  return new Map(
    sites
      .filter((event) => event.evidence.kind !== "deferred" || !consumed.has(event.offset))
      .map((event) => [
        `${event.offset}:${event.evidence.kind === "consumed" ? event.evidence.producer : event.offset}`,
        event,
      ]),
  ).values();
}

export function normalizedFlow(
  flow: RawFunctionFlow,
  flows: readonly RawFunctionFlow[],
): ResolvedFunctionFlow {
  // Saved asynchronous work receives assertion credit only at a failure-visible consumer.
  const producers = new Map(
    flow.segments
      .flatMap((segment) => segment.events)
      .filter((event) => deferredCall(event, flows))
      .map((event) => [event.offset, event]),
  );
  const segments = flow.segments.map((segment) => {
    const events = segment.events.flatMap((event) => [
      normalizeCatches(event, flow, flows, {
        kind: deferredCall(event, flows) ? "deferred" : "immediate",
      }),
      ...(event.collection.kind === "consumer" ? event.collection.producers : []).flatMap(
        (offset) => {
          const producer = producers.get(offset);
          return producer === undefined
            ? []
            : [
                normalizeCatches(
                  {
                    ...producer,
                    offset: event.offset,
                    end: event.end,
                    line: event.line,
                    conditional: producer.conditional || event.conditional,
                    controls: [...producer.controls, ...event.controls],
                    settles: producer.settles || event.settles,
                    handlers: [...producer.handlers, ...event.handlers],
                    catches: [...producer.catches, ...event.catches],
                    finalizers: [...producer.finalizers, ...event.finalizers],
                  },
                  flow,
                  flows,
                  { kind: "consumed", producer: producer.offset },
                ),
              ];
        },
      ),
    ]);
    return { id: segment.id, previous: segment.previous, events };
  });
  const { promiseReturns: _returns, promiseParameters: _parameters, ...facts } = flow;
  return { ...facts, promise: returnsPromise(flow.start, flows), segments };
}

function deferredCall(event: RawCallEvent, flows: readonly RawFunctionFlow[]): boolean {
  return (
    event.collection.kind === "call" &&
    event.collection.deferred &&
    (event.binding.kind === "parameter" || asynchronousCall(event, flows))
  );
}

function asynchronousCall(event: RawCallEvent, flows: readonly RawFunctionFlow[]): boolean {
  return (
    (event.collection.kind === "call" && event.collection.promise) ||
    (event.binding.target !== undefined &&
      returnsPromise(event.binding.target, flows, event.callbacks))
  );
}

function returnsPromise(
  target: number,
  flows: readonly RawFunctionFlow[],
  callbacks: ReadonlyMap<number, number> = new Map(),
  seen: ReadonlySet<number> = new Set(),
): boolean {
  if (seen.has(target)) {
    return false;
  }
  const flow = flows.find((candidate) => candidate.start === target);
  const visited = new Set(seen).add(target);
  return (
    flow?.promise === true ||
    (flow?.promiseParameters ?? []).some((index) => {
      const callback = callbacks.get(index);
      return callback !== undefined && returnsPromise(callback, flows, new Map(), visited);
    }) ||
    returningCalls(flow).some(
      (call) =>
        call.binding.target !== undefined &&
        returnsPromise(call.binding.target, flows, call.callbacks, visited),
    )
  );
}

function returningCalls(flow: RawFunctionFlow | undefined): readonly RawCallEvent[] {
  return (
    flow?.segments
      .flatMap((segment) => segment.events)
      .filter((event) => flow.promiseReturns.includes(event.offset)) ?? []
  );
}

function resolvedCallbacks(
  event: RawCallEvent,
  flows: readonly RawFunctionFlow[],
  evidence: CallEvidence,
): readonly number[] | undefined {
  const { collection } = event;
  if (collection.kind === "consumer") {
    return undefined;
  }
  return evidence.kind !== "consumed" &&
    collection.promiseSources.some((target) => returnsPromise(target, flows))
    ? [...event.callbacks.values()]
    : collection.promiseCallbacks;
}

function normalizeCatches(
  event: RawCallEvent,
  flow: RawFunctionFlow,
  flows: readonly RawFunctionFlow[],
  evidence: CallEvidence,
): ResolvedCallEvent {
  const { collection: _collection, settles, handlers, catches, finalizers, ...call } = event;
  const caught =
    (settles && (evidence.kind === "consumed" || asynchronousCall(event, flows))) ||
    handlers.some((target) => {
      const handler = flows.find((candidate) => candidate.start === target);
      return handler === undefined || handler.returns.length > 0 || handler.throws.length === 0;
    }) ||
    catches.some((start) => {
      const region = flow.regions.find((candidate) => candidate.start === start);
      return (
        region === undefined ||
        region.exits.length > 0 ||
        flow.returnSites.some((site) => site.offset >= region.start && site.offset <= region.end)
      );
    }) ||
    finalizers.some((start) => {
      const region = flow.regions.find((candidate) => candidate.start === start);
      return (
        region === undefined ||
        flow.returnSites.some((site) => site.offset >= region.start && site.offset <= region.end)
      );
    });
  return {
    ...call,
    evidence,
    caught,
    conditional: event.conditional || caught,
    promiseCallbacks: resolvedCallbacks(event, flows, evidence),
  };
}

export function canonicalPath(base: string, path: string): string {
  const absolute = resolve(base, path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
