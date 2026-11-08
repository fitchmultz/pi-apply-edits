import type { BigIntStats } from "node:fs";
import { lstat, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  MoveReplacement,
  ReadonlyEntryMovePlan,
  ReadonlyEntryPublishHooks,
  ReadonlyEntrySnapshot,
} from "./contracts.ts";
import { errorMessage, isCode, PublicationError, throwIfAborted } from "./errors.ts";
import {
  readStableRegularEntry,
  sameIdentity,
  samePublishedState,
  sameSnapshotStats,
  syncDirectory,
} from "./observation.ts";
import { publishReplacement } from "./replacement.ts";
import { assertEntryCurrent, assertEntryParentCurrent } from "./snapshot.ts";

const foldName = (name: string): string => name.normalize("NFC").toUpperCase().toLowerCase();

/** Some filesystems, such as Linux vfat, treat a respelling as a rename onto itself and keep the old name. */
class SpellingKeptError extends Error {}

type RenameEvidence =
  | { readonly kind: "originalEntry"; readonly stats: BigIntStats }
  | {
      readonly kind: "verifiedReplacement";
      readonly stats: BigIntStats;
      readonly bytes: Buffer;
    };

async function listNames(directory: string, label: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isCode(error, "EACCES") || isCode(error, "EPERM")) {
      throw new Error(
        `Renaming ${label} to a new spelling requires a readable directory to verify the new name: ${directory}. No changes were written.`,
        { cause: error },
      );
    }
    throw error;
  }
}

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
    listNames(dirname(targetPath), entry.inputPath),
  ]);
  return sameIdentity(entry.parentStats, parent) && !names.includes(name);
}

async function renameInPlace(
  plan: ReadonlyEntryMovePlan,
  evidence: RenameEvidence,
  signal: AbortSignal | undefined,
  hooks: ReadonlyEntryPublishHooks | undefined,
): Promise<void> {
  await hooks?.beforeCommit?.();
  if (evidence.kind === "originalEntry") {
    await assertEntryCurrent(plan.entry);
    throwIfAborted(signal);
  } else {
    await assertEntryParentCurrent(plan.entry);
    const current = await readStableRegularEntry(plan.entry.actualPath);
    if (
      !sameSnapshotStats(evidence.stats, current.stats) ||
      !current.bytes.equals(evidence.bytes)
    ) {
      throw new Error(`File changed before entry respelling: ${plan.entry.inputPath}`);
    }
    if (signal?.aborted === true) {
      throw new Error("Operation aborted before entry respelling.");
    }
  }
  await rename(plan.entry.actualPath, plan.destination.targetPath);
}

async function renameEvidence(
  plan: ReadonlyEntryMovePlan,
  replacement: MoveReplacement | undefined,
): Promise<RenameEvidence> {
  if (replacement === undefined) {
    return { kind: "originalEntry", stats: plan.entry.stats };
  }
  const current = await readStableRegularEntry(plan.entry.actualPath);
  if (!current.bytes.equals(replacement.bytes)) {
    throw new Error(`File content changed before entry respelling: ${plan.entry.inputPath}`);
  }
  return { kind: "verifiedReplacement", stats: current.stats, bytes: replacement.bytes };
}

async function verifyRespelling(
  plan: ReadonlyEntryMovePlan,
  evidence: RenameEvidence,
): Promise<void> {
  const [published, names] = await Promise.all([
    lstat(plan.destination.targetPath, { bigint: true }),
    readdir(plan.entry.parentPath),
  ]);
  const target = basename(plan.destination.targetPath);
  const renamed = sameIdentity(evidence.stats, published);
  if (evidence.kind === "verifiedReplacement") {
    const current = await readStableRegularEntry(plan.destination.targetPath);
    if (
      !samePublishedState(evidence.stats, current.stats) ||
      !current.bytes.equals(evidence.bytes)
    ) {
      throw new Error(`Move destination could not be verified: ${plan.destination.inputPath}`);
    }
  }
  if (renamed && names.includes(target)) {
    return;
  }
  // The stored spelling can differ from the one the patch used to address the source.
  const kept = names.find((name) => foldName(name) === foldName(target));
  if (renamed && kept !== undefined) {
    throw new SpellingKeptError(
      `The filesystem kept the name ${join(plan.entry.parentPath, kept)}; it cannot change only the spelling of a name.`,
    );
  }
  throw new Error(`Move destination could not be verified: ${plan.destination.inputPath}`);
}

function verificationFailure(
  error: unknown,
  replaced: readonly string[],
  both: readonly string[],
): PublicationError {
  if (error instanceof SpellingKeptError) {
    const outcome =
      replaced.length > 0
        ? "The content change was published under the original name."
        : "No changes were written.";
    return new PublicationError(`${error.message} ${outcome}`, replaced, [], error);
  }
  const uncertain = both.filter((path) => !replaced.includes(path));
  return new PublicationError(errorMessage(error), replaced, uncertain, error);
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
  let evidence: RenameEvidence;
  try {
    evidence = await renameEvidence(plan, replacement);
    await renameInPlace(plan, evidence, signal, hooks);
  } catch (error) {
    const outcome =
      replacement === undefined
        ? ""
        : " The content change was already published under the original name.";
    throw new PublicationError(`${errorMessage(error)}${outcome}`, replaced, [], error);
  }
  const both = [entry.actualPath, destination.targetPath];
  try {
    await verifyRespelling(plan, evidence);
  } catch (error) {
    throw verificationFailure(error, replaced, both);
  }
  try {
    await hooks?.afterCommit?.();
  } catch (error) {
    throw new PublicationError(errorMessage(error), both, [], error);
  }
  const warning = await syncDirectory(entry.parentPath);
  return warning === undefined ? warnings : [...warnings, warning];
}
