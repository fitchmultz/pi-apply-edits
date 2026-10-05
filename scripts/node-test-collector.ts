import type { Rule } from "eslint";
import { calleeBinding, callbackTargets } from "./node-test-bindings.ts";
import { controlFacts, failClosed, exhaustive } from "./test-controls.ts";
import {
  flowSummaries,
  assertionCall,
  ownsAssertions,
  testCall,
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
  readonly parent?: number;
  readonly parameterCount: number;
  readonly function: boolean;
  readonly segments: Map<string, SegmentState>;
  readonly active: Set<string>;
  returns: string[];
  readonly regions: Map<number, FlowRegion>;
  readonly returnSites: ReturnSite[];
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
    this.helpers = helpers;
    this.rule = rule;
    this.wrappers = wrappers;
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
      ReturnStatement: this.returnSite,
      BreakStatement: this.returnSite,
    };
  }

  private readonly start: NonNullable<Rule.RuleListener["onCodePathStart"]> = (path, node) => {
    const frame: FrameState = {
      id: path.id,
      start: node.range?.[0] ?? 0,
      parent: this.stack.findLast((owner) => owner.function)?.start,
      parameterCount: "params" in node && Array.isArray(node.params) ? node.params.length : 0,
      function: path.origin === "function",
      segments: new Map(),
      active: new Set(),
      returns: [],
      regions: new Map(),
      returnSites: [],
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
    const frame = this.stack.at(-1);
    frame?.regions.set(node.range[0], {
      start: node.range[0],
      end: node.range[1],
      exits: [...frame.active],
    });
  };

  private readonly returnSite = (node: { readonly range?: readonly [number, number] }): void => {
    if (node.range === undefined) {
      return;
    }
    const frame = this.stack.at(-1);
    frame?.returnSites.push({ offset: node.range[0], segments: [...frame.active] });
  };

  private readonly call: NonNullable<Rule.RuleListener["CallExpression"]> = (node) => {
    const frame = this.stack.at(-1);
    if (frame === undefined || node.range === undefined) {
      return;
    }
    const scope = this.context.sourceCode.getScope(node);
    const { binding, suffix } = calleeBinding(scope, node.callee);
    const callbacks = callbackTargets(scope, node.arguments);
    const ancestors = this.context.sourceCode.getAncestors(node);
    const boundary = ancestors.findLastIndex(
      (ancestor) =>
        ancestor.type === "FunctionExpression" ||
        ancestor.type === "FunctionDeclaration" ||
        ancestor.type === "ArrowFunctionExpression",
    );
    const facts = controlFacts(
      ancestors.slice(boundary + 1),
      this.context.sourceCode.text,
      node.range,
    );
    const event: CallEvent = {
      offset: node.range[0],
      end: node.range[1],
      line: node.loc?.start.line ?? 1,
      binding,
      suffix,
      callbacks,
      ...facts,
      arguments: node.arguments.map((argument) => this.context.sourceCode.getText(argument)),
    };
    for (const id of frame.active) {
      frame.segments.get(id)?.events.push(event);
    }
    if (testCall(binding, suffix)) {
      this.registrations.push({
        offset: event.offset,
        line: event.line,
        target: callbacks.get(node.arguments.length - 1),
      });
    }
  };

  private readonly report: NonNullable<Rule.RuleListener["Program:exit"]> = () => {
    const flows: FunctionFlow[] = this.frames
      .filter((frame) => frame.function)
      .map((frame) => ({
        start: frame.start,
        parent: frame.parent,
        parameterCount: frame.parameterCount,
        segments: [...frame.segments.values()],
        returns: frame.returns,
        regions: [...frame.regions.values()],
        returnSites: frame.returnSites,
      }));
    const summaries = flowSummaries(flows, this.registrations, this.helpers, this.wrappers);
    const contexts = new Set(
      this.registrations.flatMap((registration) =>
        registration.target === undefined ? [] : [registration.target],
      ),
    );
    this.checkPassingPaths(summaries);
    this.checkConditionalAssertions(flows, summaries, contexts);
  };

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
    for (const flow of flows) {
      if (!belongsToTest(flow.start, flows, contexts)) {
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
    if (this.rule === "node-test/valid-exceptions") {
      if (
        this.hasDirective(event.line) &&
        !proven &&
        !exhaustive(event, flow, summaries, {
          tests: contexts,
          helpers: this.helpers,
          wrappers: this.wrappers,
        })
      ) {
        this.context.report({
          loc: { line: event.line, column: 0 },
          message:
            "Conditional assertion suppression does not prove exhaustive variant coverage or fail-closed narrowing",
        });
      }
      return;
    }
    if (
      event.conditional &&
      !proven &&
      (assertionCall(event, this.helpers) ||
        ownsAssertions(event, summaries, {
          tests: contexts,
          helpers: this.helpers,
          wrappers: this.wrappers,
        })) &&
      event.suffix !== ".skip"
    ) {
      this.context.report({
        loc: { line: event.line, column: 0 },
        message: "Conditional assertions require exhaustive variant or fail-closed proof",
      });
    }
  }
}

function belongsToTest(
  start: number,
  flows: readonly FunctionFlow[],
  contexts: ReadonlySet<number>,
): boolean {
  let owner: number | undefined = start;
  while (owner !== undefined) {
    if (contexts.has(owner)) {
      return true;
    }
    owner = flows.find((flow) => flow.start === owner)?.parent;
  }
  return false;
}
