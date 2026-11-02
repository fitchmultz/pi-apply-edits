import type { BigIntStats } from "node:fs";
import { lstat, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  MoveReplacement,
  ReadonlyEntryMovePlan,
  ReadonlyEntryPublishHooks,
  ReadonlyEntrySnapshot,
} from "./contracts.ts";
import { errorMessage, PublicationError, throwIfAborted } from "./errors.ts";
import { sameIdentity, syncDirectory } from "./observation.ts";
import { publishReplacement } from "./replacement.ts";
import { assertEntryCurrent, assertEntryParentCurrent } from "./snapshot.ts";

const foldName = (name: string): string => name.normalize("NFC").toUpperCase().toLowerCase();

/**
 * Case- and normalization-insensitive volumes resolve a respelled name to the source entry.
 * An exact listing match is a distinct hard link, which a rename would silently keep.
 */
export async function isRespelling(
  entry: ReadonlyEntrySnapshot,
  targetPath: string,
  existing: BigIntStats,
): Promise<boolean> {
  const name = basename(targetPath);
  const source = basename(entry.actualPath);
  if (name === source || foldName(name) !== foldName(source)) {
    return false;
  }
  if (!sameIdentity(entry.stats, existing)) {
    return false;
  }
  const [parent, names] = await Promise.all([
    stat(dirname(targetPath), { bigint: true }),
    readdir(dirname(targetPath)),
  ]);
  return sameIdentity(entry.parentStats, parent) && !names.includes(name);
}

async function renameInPlace(
  plan: ReadonlyEntryMovePlan,
  replaced: boolean,
  hooks: ReadonlyEntryPublishHooks | undefined,
): Promise<BigIntStats> {
  await hooks?.beforeCommit?.();
  // A published replacement is a new inode, so only an unchanged source is rechecked.
  await (replaced ? assertEntryParentCurrent(plan.entry) : assertEntryCurrent(plan.entry));
  const source = await lstat(plan.entry.actualPath, { bigint: true });
  await rename(plan.entry.actualPath, plan.destination.targetPath);
  return source;
}

async function verifyRespelling(plan: ReadonlyEntryMovePlan, source: BigIntStats): Promise<void> {
  const [published, names] = await Promise.all([
    lstat(plan.destination.targetPath, { bigint: true }),
    readdir(plan.entry.parentPath),
  ]);
  if (!sameIdentity(source, published) || !names.includes(basename(plan.destination.targetPath))) {
    throw new Error(`Move destination could not be verified: ${plan.destination.inputPath}`);
  }
}

/**
 * Hard-link publication cannot respell one entry, so content is replaced first and the entry
 * is then renamed in place. A failed rename after a content change reports that change.
 */
export async function publishRespelling(
  plan: ReadonlyEntryMovePlan,
  replacement: MoveReplacement | undefined,
  signal: AbortSignal | undefined,
  hooks: ReadonlyEntryPublishHooks | undefined,
): Promise<string[]> {
  const { entry, destination } = plan;
  throwIfAborted(signal);
  await assertEntryCurrent(entry);
  const warnings =
    replacement === undefined
      ? []
      : await publishReplacement(replacement.snapshot, replacement.bytes, signal);
  const replaced = replacement === undefined ? [] : [entry.actualPath];
  let source: BigIntStats;
  try {
    source = await renameInPlace(plan, replaced.length > 0, hooks);
  } catch (error) {
    throw new PublicationError(errorMessage(error), replaced, [], error);
  }
  const both = [entry.actualPath, destination.targetPath];
  try {
    await verifyRespelling(plan, source);
  } catch (error) {
    const uncertain = both.filter((path) => !replaced.includes(path));
    throw new PublicationError(errorMessage(error), replaced, uncertain, error);
  }
  try {
    await hooks?.afterCommit?.();
  } catch (error) {
    throw new PublicationError(errorMessage(error), both, [], error);
  }
  const warning = await syncDirectory(entry.parentPath);
  return warning === undefined ? warnings : [...warnings, warning];
}
