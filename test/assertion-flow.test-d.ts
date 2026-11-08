import { normalizedFlow } from "../scripts/node-test-ownership.ts";
import {
  flowSummaries,
  ownsAssertions,
  proves,
  type CallEvidence,
  type RawCallEvent,
  type RawFunctionFlow,
  type ResolvedCallEvent,
} from "../scripts/test-flow.ts";

function normalizationBoundary(raw: RawFunctionFlow, event: RawCallEvent): void {
  const resolved = normalizedFlow(raw, [raw]);
  const summaries = flowSummaries([resolved], [], [], []);
  const context = { tests: new Set<number>(), helpers: [], wrappers: [] };
  proves(resolved, (site) => ownsAssertions(site, summaries, context));

  // @ts-expect-error collected flows have not resolved promise ownership or catches
  flowSummaries([raw], [], [], []);
  // @ts-expect-error must-analysis requires normalized proof events
  proves(raw, () => true);
  // @ts-expect-error collected events cannot supply assertion proof
  ownsAssertions(event, summaries, context);
  // @ts-expect-error resolved flows no longer carry raw promise-return facts
  normalizedFlow(resolved, [raw]);
}

function evidenceBoundary(event: ResolvedCallEvent, producer: number): void {
  const immediate: CallEvidence = { kind: "immediate" };
  const deferred: CallEvidence = { kind: "deferred" };
  const consumed: CallEvidence = { kind: "consumed", producer };
  // @ts-expect-error consumed evidence requires the original producer offset
  const missingProducer: CallEvidence = { kind: "consumed" };
  // @ts-expect-error deferred work cannot also carry consumed-producer evidence
  const prematureProducer: CallEvidence = { kind: "deferred", producer };
  // @ts-expect-error producer offsets are available only after consumed narrowing
  const unqualifiedProducer: unknown = event.evidence.producer;
  void [immediate, deferred, consumed, missingProducer, prematureProducer, unqualifiedProducer];
}

void normalizationBoundary;
void evidenceBoundary;
