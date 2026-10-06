export interface CallBinding {
  readonly kind: "import" | "function" | "parameter" | "unknown" | "native";
  readonly name: string;
  readonly source?: string;
  readonly target?: number;
  readonly parameter?: number;
  readonly owner?: number;
  readonly member?: string;
}
export interface ConditionalControl {
  readonly parts: readonly number[];
  readonly exhaustive: boolean;
  readonly guard?: number;
  readonly compared?: readonly [string, string];
}
export interface CallEvent {
  readonly offset: number;
  readonly end: number;
  readonly line: number;
  readonly binding: CallBinding;
  readonly suffix: string;
  readonly callbacks: ReadonlyMap<number, number>;
  readonly conditional: boolean;
  readonly caught: boolean;
  readonly handlers: readonly number[];
  readonly catches: readonly number[];
  readonly finalizers: readonly number[];
  readonly parallel?: number;
  readonly arguments: readonly string[];
  readonly stableArguments: boolean;
  readonly controls: readonly ConditionalControl[];
  readonly deferred?: boolean;
  readonly producers?: readonly number[];
  readonly producer?: number;
  readonly promiseCallbacks?: readonly number[];
  readonly promiseSources?: readonly number[];
}
export interface FlowSegment {
  readonly id: string;
  readonly previous: readonly string[];
  readonly events: readonly CallEvent[];
}
export interface FlowRegion {
  readonly start: number;
  readonly end: number;
  readonly exits: readonly string[];
  readonly after?: readonly string[];
}
export interface ReturnSite {
  readonly offset: number;
  readonly segments: readonly string[];
}
export interface FunctionFlow {
  readonly start: number;
  /** May return a Promise; this is not proof of assertions or callback execution. */
  readonly promise?: boolean;
  readonly promiseTargets?: readonly number[];
  readonly segments: readonly FlowSegment[];
  readonly returns: readonly string[];
  readonly parameterCount: number;
  readonly regions: readonly FlowRegion[];
  readonly returnSites: readonly ReturnSite[];
  readonly throws: readonly string[];
  readonly iterations: readonly FlowRegion[];
}
export interface Registration {
  readonly offset: number;
  readonly line: number;
  readonly target?: number;
}
export interface FlowSummary {
  readonly asserts: boolean;
  readonly callbacks: ReadonlySet<number>;
}

export interface AssertionHelper {
  readonly source: string;
  readonly name: string;
}

export interface TestWrapper {
  readonly source: string;
  readonly name: string;
  readonly callback: number;
}

const methods = new Set([
  "ok",
  "fail",
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "partialDeepStrictEqual",
  "throws",
  "doesNotThrow",
  "rejects",
  "doesNotReject",
  "ifError",
  "match",
  "doesNotMatch",
]);

export function assertionCall(event: CallEvent, helpers: readonly AssertionHelper[]): boolean {
  if (event.binding.kind !== "import") {
    return false;
  }
  if (
    helpers.some(
      (helper) => helper.name === event.binding.name && helper.source === event.binding.source,
    )
  ) {
    return event.suffix.length === 0;
  }
  if (event.binding.source !== "node:assert" && event.binding.source !== "node:assert/strict") {
    return false;
  }
  if (event.binding.name !== "default" && event.binding.name !== "*") {
    return methods.has(event.binding.name) && event.suffix.length === 0;
  }
  const member = event.suffix.replace(/^\.strict(?=\.|$)/u, "").replace(/^\./u, "");
  return member.length === 0 || methods.has(member);
}

export function testCall(binding: CallBinding, suffix: string): boolean {
  if (binding.kind !== "import" || binding.source !== "node:test") {
    return false;
  }
  if (binding.name === "*") {
    return /^\.(?:test|it)(?:\.(?:only|skip|todo))?$/u.test(suffix);
  }
  return (
    ["default", "test", "it"].includes(binding.name) && /^(?:\.(?:only|skip|todo))?$/u.test(suffix)
  );
}

export function subtestCall(event: CallEvent, contexts: ReadonlySet<number>): boolean {
  return (
    event.binding.kind === "parameter" &&
    event.binding.parameter === 0 &&
    event.binding.owner !== undefined &&
    contexts.has(event.binding.owner) &&
    event.suffix === ".test"
  );
}

export function flowSummaries(
  flows: readonly FunctionFlow[],
  registrations: readonly Registration[],
  helpers: readonly AssertionHelper[],
  wrappers: readonly TestWrapper[],
): ReadonlyMap<number, FlowSummary> {
  const summaries = new Map<number, FlowSummary>();
  const contexts = new Set(
    registrations.flatMap((registration) =>
      registration.target === undefined ? [] : [registration.target],
    ),
  );
  for (let pass = 0; pass <= flows.length; pass += 1) {
    for (const flow of flows) {
      const callbacks = new Set(
        Array.from({ length: flow.parameterCount }, (_, index) => index).filter((index) =>
          proves(
            flow,
            (event) =>
              event.binding.kind === "parameter" &&
              event.binding.owner === flow.start &&
              event.binding.parameter === index &&
              event.suffix.length === 0 &&
              event.deferred !== true &&
              !event.caught,
          ),
        ),
      );
      const asserts = proves(flow, (event) =>
        ownsAssertions(event, summaries, { tests: contexts, helpers, wrappers }),
      );
      summaries.set(flow.start, { asserts, callbacks });
    }
  }
  return summaries;
}

export function proves(flow: FunctionFlow, satisfies: (event: CallEvent) => boolean): boolean {
  if (flow.returns.length === 0) {
    return false;
  }
  // Must-analysis uses the greatest fixed point so loop back-edges cannot erase an entry guarantee.
  const guaranteed = new Map(flow.segments.map((segment) => [segment.id, true]));
  const iterations = flow.iterations.filter((region) =>
    proves(
      {
        ...flow,
        returns: region.exits,
        iterations: flow.iterations.filter(
          (nested) => nested.start > region.start && nested.end < region.end,
        ),
      },
      (event) => event.offset >= region.start && event.end <= region.end && satisfies(event),
    ),
  );
  for (let pass = 0; pass <= flow.segments.length; pass += 1) {
    for (const segment of flow.segments) {
      const direct =
        segment.events.some(satisfies) ||
        iterations.some((region) => region.after?.includes(segment.id) === true);
      const inherited =
        segment.previous.length > 0 && segment.previous.every((id) => guaranteed.get(id) === true);
      guaranteed.set(segment.id, direct || inherited);
    }
  }
  return flow.returns.every((id) => guaranteed.get(id) === true);
}

function skipsOwnedTest(event: CallEvent, contexts: ReadonlySet<number>): boolean {
  return (
    event.binding.kind === "parameter" &&
    event.binding.parameter === 0 &&
    event.binding.owner !== undefined &&
    contexts.has(event.binding.owner) &&
    event.suffix === ".skip"
  );
}

function callbackAsserts(
  event: CallEvent,
  index: number,
  summaries: ReadonlyMap<number, FlowSummary>,
): boolean {
  const target = event.callbacks.get(index);
  return target !== undefined && summaries.get(target)?.asserts === true;
}

export interface AssertionContext {
  readonly tests: ReadonlySet<number>;
  readonly helpers: readonly AssertionHelper[];
  readonly wrappers: readonly TestWrapper[];
}

export function ownsAssertions(
  event: CallEvent,
  summaries: ReadonlyMap<number, FlowSummary>,
  context: AssertionContext,
): boolean {
  if (event.deferred === true) {
    return false;
  }
  if (directAssertions(event, context)) {
    return true;
  }
  if (subtestCall(event, context.tests) && !event.caught) {
    return [...event.callbacks.values()].some((target) => summaries.get(target)?.asserts === true);
  }
  if (event.parallel !== undefined && !event.caught) {
    return summaries.get(event.parallel)?.asserts === true;
  }
  return delegatedAssertions(event, summaries, context.wrappers);
}

function directAssertions(event: CallEvent, context: AssertionContext): boolean {
  return (
    (assertionCall(event, context.helpers) && !event.caught) || skipsOwnedTest(event, context.tests)
  );
}

function delegatedAssertions(
  event: CallEvent,
  summaries: ReadonlyMap<number, FlowSummary>,
  wrappers: readonly TestWrapper[],
): boolean {
  if (event.caught || event.suffix.length > 0) {
    return false;
  }
  const wrapper = wrappers.find(
    (entry) =>
      event.binding.kind === "import" &&
      event.binding.source === entry.source &&
      event.binding.name === entry.name,
  );
  if (wrapper !== undefined) {
    return callbackAsserts(event, wrapper.callback, summaries);
  }
  if (event.binding.target === undefined) {
    return false;
  }
  const summary = summaries.get(event.binding.target);
  if (summary?.asserts === true) {
    return true;
  }
  return [...(summary?.callbacks ?? [])].some((index) => callbackAsserts(event, index, summaries));
}
