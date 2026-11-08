import type { PlannedMutation } from "../src/editing/contracts.ts";
import type {
  ReadonlyEntryMovePlan,
  ReadonlyEntrySnapshot,
  ReadonlyFileSnapshot,
  ReadonlyNewFilePlan,
} from "../src/fs/contracts.ts";

declare const content: Pick<
  PlannedMutation,
  | "inputPath"
  | "displayPath"
  | "nextBytes"
  | "originalText"
  | "nextText"
  | "matches"
  | "editsRequested"
>;
declare const snapshot: ReadonlyFileSnapshot;
declare const entry: ReadonlyEntrySnapshot;
declare const movePlan: ReadonlyEntryMovePlan;
declare const createPlan: ReadonlyNewFilePlan;

const plans: PlannedMutation[] = [
  { ...content, operation: "edit", snapshot },
  { ...content, operation: "rewrite", snapshot },
  { ...content, operation: "patch", snapshot },
  { ...content, operation: "no_change", snapshot },
  { ...content, operation: "create", createPlan },
  { ...content, operation: "delete", entry },
  { ...content, operation: "move", movePlan, snapshot: undefined },
  { ...content, operation: "move", movePlan, snapshot },
];

// @ts-expect-error create publication requires its checked destination plan
const missingCreate: PlannedMutation = { ...content, operation: "create" };
// @ts-expect-error move publication requires its source and destination plan
const missingMove: PlannedMutation = { ...content, operation: "move", snapshot };
// @ts-expect-error replacement publication requires the original file snapshot
const missingSnapshot: PlannedMutation = { ...content, operation: "edit" };
// @ts-expect-error unchanged publication must still revalidate the original snapshot
const uncheckedNoChange: PlannedMutation = { ...content, operation: "no_change" };
// @ts-expect-error delete cannot carry a destination plan that changes its dispatch
const conflictingDelete: PlannedMutation = { ...content, operation: "delete", entry, movePlan };
const noWriteDelete: PlannedMutation = {
  ...content,
  operation: "delete",
  entry,
  // @ts-expect-error a write flag cannot contradict the operation discriminator
  needsWrite: false,
};

void plans;
void missingCreate;
void missingMove;
void missingSnapshot;
void uncheckedNoChange;
void conflictingDelete;
void noWriteDelete;
