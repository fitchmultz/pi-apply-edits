import type { Rule, Scope } from "eslint";
import { dirname } from "node:path";
import { canonicalPath, normalizedFlow, ownedFunctions } from "./node-test-ownership.ts";
import { calleeBinding, callbackTargets } from "./node-test-bindings.ts";
import {
  controlFacts,
  failClosed,
  exhaustive,
  nonemptyLiteral,
  stableOperand,
  type ControlView,
} from "./test-controls.ts";
import {
  flowSummaries,
  assertionCall,
  ownsAssertions,
  testCall,
  subtestCall,
  type CallEvent,
  type FunctionFlow,
  type FlowSummary,
  type FlowRegion,
  type ReturnSite,
  type Registration,
  type TestWrapper,
  type AssertionHelper,
} from "./test-flow.ts";

interface SegmentState {
  readonly id: string;
  readonly previous: readonly string[];
  readonly events: CallEvent[];
}
interface FrameState {
  readonly id: string;
  readonly start: number;
  readonly parameterCount: number;
  readonly function: boolean;
  readonly segments: Map<string, SegmentState>;
  readonly active: Set<string>;
  returns: string[];
  throws: string[];
  readonly regions: Map<number, FlowRegion>;
  readonly returnSites: ReturnSite[];
  readonly iterations: FlowRegion[];
}

/** Oxc owns scopes and code paths; this per-file collector owns only copied IDs and events. */
export class NodeTestCollector {
  private readonly context: Rule.RuleContext;
  private readonly helpers: readonly AssertionHelper[];
  private readonly frames: FrameState[] = [];
  private readonly stack: FrameState[] = [];
  private readonly registrations: Registration[] = [];
  private readonly rule: string;
  private readonly wrappers: readonly TestWrapper[];

  constructor(
    context: Rule.RuleContext,
    helpers: readonly AssertionHelper[],
    rule: string,
    wrappers: readonly TestWrapper[],
  ) {
    this.context = context;
    this.helpers = helpers.map((helper) => ({
      ...helper,
      source: canonicalPath(context.cwd, helper.source),
    }));
    this.rule = rule;
    this.wrappers = wrappers.map((wrapper) => ({
      ...wrapper,
      source: canonicalPath(context.cwd, wrapper.source),
    }));
  }

  listeners(): Rule.RuleListener {
    return {
      onCodePathStart: this.start,
      onCodePathEnd: this.end,
      onCodePathSegmentStart: this.segmentStart,
      onCodePathSegmentEnd: this.segmentEnd,
      CallExpression: this.call,
      "Program:exit": this.report,
      "BlockStatement:exit": this.regionEnd,
      "IfStatement:exit": this.regionEnd,
      "SwitchCase:exit": this.regionEnd,
      "CallExpression:exit": this.regionEnd,
      "ForOfStatement:exit": this.loopEnd,
      ReturnStatement: this.returnSite,
      BreakStatement: this.returnSite,
      ContinueStatement: this.returnSite,
    };
  }

  private readonly start: NonNullable<Rule.RuleListener["onCodePathStart"]> = (path, node) => {
    const frame: FrameState = {
      id: path.id,
      start: node.range?.[0] ?? 0,
      parameterCount: "params" in node && Array.isArray(node.params) ? node.params.length : 0,
      function: path.origin === "function",
      segments: new Map(),
      active: new Set(),
      returns: [],
      throws: [],
      regions: new Map(),
      returnSites: [],
      iterations: [],
    };
    this.frames.push(frame);
    this.stack.push(frame);
  };

  private readonly end: NonNullable<Rule.RuleListener["onCodePathEnd"]> = (path) => {
    const frame = this.stack.pop();
    if (frame?.id !== path.id) {
      throw new Error("Oxc code-path ownership changed unexpectedly");
    }
    frame.returns = path.returnedSegments
      .filter((segment) => segment.reachable)
      .map((segment) => segment.id);
    frame.throws = path.thrownSegments
      .filter((segment) => segment.reachable)
      .map((segment) => segment.id);
    // Oxc completes loop back-edges after segment-start notifications.
    const pending = [...path.returnedSegments, ...path.thrownSegments];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const segment = pending.pop();
      if (segment === undefined || seen.has(segment.id)) {
        continue;
      }
      seen.add(segment.id);
      const state = frame.segments.get(segment.id);
      if (state !== undefined) {
        frame.segments.set(segment.id, {
          ...state,
          previous: segment.prevSegments
            .filter((previous) => previous.reachable)
            .map((previous) => previous.id),
        });
      }
      pending.push(...segment.prevSegments);
    }
  };

  private readonly segmentStart: NonNullable<Rule.RuleListener["onCodePathSegmentStart"]> = (
    segment,
  ) => {
    const frame = this.stack.at(-1);
    if (frame === undefined) {
      throw new Error("Oxc emitted a segment without an owner");
    }
    frame.active.add(segment.id);
    frame.segments.set(segment.id, {
      id: segment.id,
      previous: segment.prevSegments
        .filter((previous) => previous.reachable)
        .map((previous) => previous.id),
      events: [],
    });
  };

  private readonly segmentEnd: NonNullable<Rule.RuleListener["onCodePathSegmentEnd"]> = (
    segment,
  ) => {
    this.stack.at(-1)?.active.delete(segment.id);
  };

  private readonly regionEnd = (node: { readonly range?: readonly [number, number] }): void => {
    if (node.range === undefined) {
      return;
    }
    this.stack.at(-1)?.regions.set(node.range[0], {
      start: node.range[0],
      end: node.range[1],
      exits: [...(this.stack.at(-1)?.active ?? [])],
    });
  };

  private readonly returnSite = (node: { readonly range?: readonly [number, number] }): void => {
    if (node.range !== undefined) {
      this.stack.at(-1)?.returnSites.push({
        offset: node.range[0],
        segments: [...(this.stack.at(-1)?.active ?? [])],
      });
    }
  };

  private readonly loopEnd = (node: ControlView): void => {
    const frame = this.stack.at(-1);
    const body = node.body !== undefined && "type" in node.body ? node.body.range : undefined;
    if (frame === undefined || body === undefined || !nonemptyLiteral(node.right)) {
      return;
    }
    const region = frame.regions.get(body[0]);
    if (region !== undefined) {
      frame.iterations.push({
        ...region,
        exits: regionExits(region, frame.returnSites),
        after: [...frame.active],
      });
    }
  };

  private readonly call: NonNullable<Rule.RuleListener["CallExpression"]> = (node) => {
    const frame = this.stack.at(-1);
    if (frame === undefined || node.range === undefined) {
      return;
    }
    const scope = this.context.sourceCode.getScope(node);
    const resolved = calleeBinding(scope, node.callee);
    const binding =
      resolved.binding.source?.startsWith(".") === true
        ? {
            ...resolved.binding,
            source: canonicalPath(dirname(this.context.filename), resolved.binding.source),
          }
        : resolved.binding;
    const callbacks = callbackTargets(scope, node.arguments);
    const ancestors = this.context.sourceCode.getAncestors(node);
    const boundary = ancestors.findLastIndex((ancestor) =>
      ["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"].includes(
        ancestor.type,
      ),
    );
    const local = ancestors.slice(boundary + 1);
    const event: CallEvent = {
      offset: node.range[0],
      end: node.range[1],
      line: node.loc?.start.line ?? 1,
      binding,
      suffix: resolved.suffix,
      callbacks,
      ...controlFacts(local, this.context.sourceCode.text, node.range),
      handlers: rejectionHandlers(scope, local),
      parallel: parallelTarget(scope, node, resolved, local),
      arguments: node.arguments.map((argument) => this.context.sourceCode.getText(argument)),
      stableArguments: node.arguments.every(stableOperand),
    };
    for (const id of frame.active) {
      frame.segments.get(id)?.events.push(event);
    }
    if (testCall(binding, resolved.suffix)) {
      this.registrations.push({
        offset: event.offset,
        line: event.line,
        target: callbacks.get(node.arguments.length - 1),
      });
    }
  };

  private readonly report: NonNullable<Rule.RuleListener["Program:exit"]> = () => {
    const raw: FunctionFlow[] = this.frames
      .filter((frame) => frame.function)
      .map((frame) => ({
        start: frame.start,
        parameterCount: frame.parameterCount,
        segments: [...frame.segments.values()],
        returns: frame.returns,
        regions: [...frame.regions.values()],
        returnSites: frame.returnSites,
        throws: frame.throws,
        iterations: frame.iterations,
      }));
    const flows = raw.map((flow) => normalizedFlow(flow, raw));
    this.registerSubtests(flows);
    const summaries = flowSummaries(flows, this.registrations, this.helpers, this.wrappers);
    const contexts = new Set(
      this.registrations.flatMap((registration) =>
        registration.target === undefined ? [] : [registration.target],
      ),
    );
    this.checkPassingPaths(summaries);
    this.checkConditionalAssertions(flows, summaries, contexts);
  };

  private registerSubtests(flows: readonly FunctionFlow[]): void {
    const contexts = new Set(
      this.registrations.flatMap((entry) => (entry.target === undefined ? [] : [entry.target])),
    );
    const events = new Map(
      flows
        .flatMap((flow) => flow.segments.flatMap((segment) => segment.events))
        .map((event) => [event.offset, event]),
    );
    for (let pass = 0; pass <= flows.length; pass += 1) {
      for (const event of events.values()) {
        if (
          subtestCall(event, contexts) &&
          !this.registrations.some((entry) => entry.offset === event.offset)
        ) {
          this.registerChild(event).forEach((target) => {
            contexts.add(target);
          });
        }
      }
    }
  }

  private registerChild(event: CallEvent): readonly number[] {
    const target = [...event.callbacks.values()].at(-1);
    this.registrations.push({ offset: event.offset, line: event.line, target });
    return target === undefined ? [] : [target];
  }

  private checkPassingPaths(summaries: ReadonlyMap<number, FlowSummary>): void {
    if (this.rule !== "node-test/expect-assertions") {
      return;
    }
    for (const registration of this.registrations) {
      if (
        registration.target === undefined ||
        summaries.get(registration.target)?.asserts !== true
      ) {
        this.context.report({
          loc: { line: registration.line, column: 0 },
          message:
            "Every passing node:test path must execute assertions; unsupported callback references cannot silently pass",
        });
      }
    }
  }

  private hasDirective(line: number): boolean {
    return this.context.sourceCode
      .getAllComments()
      .some(
        (comment) =>
          comment.loc?.end.line === line - 1 &&
          /^\s*oxlint-disable-next-line\s+node-test\/no-conditional-assertions\s*$/u.test(
            comment.value,
          ),
      );
  }

  private checkConditionalAssertions(
    flows: readonly FunctionFlow[],
    summaries: ReadonlyMap<number, FlowSummary>,
    contexts: ReadonlySet<number>,
  ): void {
    if (
      this.rule !== "node-test/no-conditional-assertions" &&
      this.rule !== "node-test/valid-exceptions"
    ) {
      return;
    }
    const owned = ownedFunctions(flows, contexts, summaries, {
      tests: contexts,
      wrappers: this.wrappers,
      helpers: this.helpers,
    });
    for (const flow of flows) {
      if (!owned.has(flow.start)) {
        continue;
      }
      const events = new Map(
        flow.segments.flatMap((segment) => segment.events).map((event) => [event.offset, event]),
      );
      for (const event of events.values()) {
        this.checkSite(event, flow, summaries, contexts);
      }
    }
  }

  private checkSite(
    event: CallEvent,
    flow: FunctionFlow,
    summaries: ReadonlyMap<number, FlowSummary>,
    contexts: ReadonlySet<number>,
  ): void {
    const proven = failClosed(event, flow, this.context.sourceCode.text, this.helpers);
    const context = { tests: contexts, helpers: this.helpers, wrappers: this.wrappers };
    const bearing = assertionCall(event, this.helpers) || ownsAssertions(event, summaries, context);
    if (!event.conditional || !bearing || proven) {
      return;
    }
    if (this.rule === "node-test/valid-exceptions") {
      if (this.hasDirective(event.line) && !exhaustive(event, flow, summaries, context)) {
        this.context.report({
          loc: { line: event.line, column: 0 },
          message:
            "Conditional assertion suppression does not prove exhaustive variant coverage or fail-closed narrowing",
        });
      }
      return;
    }
    if (event.suffix !== ".skip") {
      this.context.report({
        loc: { line: event.line, column: 0 },
        message: "Conditional assertions require exhaustive variant or fail-closed proof",
      });
    }
  }
}

interface PromiseCallView extends ControlView {
  readonly callee?: ControlView;
  readonly arguments?: readonly ControlView[];
}

function parallelTarget(
  scope: Scope.Scope,
  node: PromiseCallView,
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
  const input = node.arguments?.[0];
  if (input?.type !== "CallExpression") {
    return;
  }
  return mappedTarget(scope, input);
}

function mappedTarget(scope: Scope.Scope, map: PromiseCallView): number | undefined {
  if (map.callee?.type !== "MemberExpression" || map.callee.property?.name !== "map") {
    return;
  }
  if (!nonemptyLiteral(map.callee.object)) {
    return;
  }
  return callbackTargets(scope, map.arguments ?? []).get(0);
}

function rejectionHandlers(
  scope: Scope.Scope,
  nodes: readonly PromiseCallView[],
): readonly number[] {
  return nodes.flatMap((node) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression") {
      return [];
    }
    const method = calleeBinding(scope, node.callee).suffix;
    const index = rejectionIndex(method);
    const handler = node.arguments?.[index];
    if (index < 0 || handler === undefined || absentHandler(handler)) {
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

function absentHandler(handler: ControlView): boolean {
  return handler.value === null || handler.name === "undefined";
}

function regionExits(region: FlowRegion, sites: readonly ReturnSite[]): readonly string[] {
  return [
    ...region.exits,
    ...sites
      .filter((site) => site.offset >= region.start && site.offset <= region.end)
      .flatMap((site) => site.segments),
  ];
}
