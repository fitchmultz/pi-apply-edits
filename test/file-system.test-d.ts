import {
  captureEntrySnapshot,
  captureSnapshot,
  planEntryMove,
  planNewFile,
  preparePlannedNestedFiles,
  type EntryMovePlan,
  type EntrySnapshot,
  type NewFilePlan,
  type NewFilePublishHooks,
  type PlannedNewFile,
  type PreparedNestedFiles,
} from "../src/file-system.ts";

/** Callers may revise returned results and assemble public option objects incrementally. */
async function reviseMutableResults(path: string): Promise<void> {
  const snapshot = await captureSnapshot(path);
  const plan = await planNewFile(path);
  plan.inputPath = path;
  plan.missingDirectories.push("recorded");
  plan.traversalDirectories.push("recorded");
  if (snapshot) {
    snapshot.inputPath = path;
    plan.traversalParents.set(path, snapshot.stats);
  }
  const published: string[] = [];
  const hooks: NewFilePublishHooks = {};
  hooks.afterFilePublish = ({ target }) => {
    published.push(target);
  };
  const entries: PlannedNewFile[] = [{ plan, bytes: Buffer.from("content") }];
  const prepared: PreparedNestedFiles = await preparePlannedNestedFiles(entries, undefined, hooks);
  prepared.warnings.push("recorded");
  prepared.entries.push({ plan, bytes: Buffer.from("other") });
  prepared.firstPlan.missingDirectories.push("recorded");
  prepared.published = false;
  const inline = await preparePlannedNestedFiles([{ plan, bytes: Buffer.from("content") }]);
  inline.entries.push({ plan, bytes: Buffer.from("other") });
  inline.firstPlan.traversalParents.clear();
  const entry = await captureEntrySnapshot(path);
  if (entry) {
    const move: EntryMovePlan = await planEntryMove(entry, path);
    move.entry.inputPath = path;
    move.destination.missingDirectories.push("recorded");
  }
}

/** Prepared and planned results reference caller values, so readonly values stay readonly. */
async function keepReadonlyInputsReadonly(path: string): Promise<void> {
  const plan: Omit<NewFilePlan, "missingDirectories"> & { missingDirectories: readonly string[] } =
    await planNewFile(path);
  const entries: readonly PlannedNewFile[] = [
    { plan: await planNewFile(path), bytes: Buffer.of() },
  ];
  const hooks: Readonly<NewFilePublishHooks> = {};
  const prepared = await preparePlannedNestedFiles(entries, undefined, hooks);
  // @ts-expect-error readonly caller entries stay readonly through the prepared descriptor
  prepared.entries[0] = { plan: await planNewFile(path), bytes: Buffer.of() };
  if (prepared.hooks) {
    // @ts-expect-error readonly caller hooks stay readonly through the prepared descriptor
    prepared.hooks.afterFilePublish = undefined;
  }
  const viewed = await preparePlannedNestedFiles([{ plan, bytes: Buffer.of() }]);
  // @ts-expect-error a readonly first plan stays readonly through the prepared descriptor
  viewed.firstPlan.missingDirectories[0] = "recorded";
  const entry: Readonly<EntrySnapshot> | undefined = await captureEntrySnapshot(path);
  if (entry) {
    const move = await planEntryMove(entry, path);
    // @ts-expect-error a readonly caller entry stays readonly through the move plan
    move.entry.inputPath = path;
  }
}

void reviseMutableResults;
void keepReadonlyInputsReadonly;
