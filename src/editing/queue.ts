import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  assertNotDanglingSymbolicLink,
  nativeRealpath,
  operationPath,
  prospectiveDirectory,
  prospectiveTarget,
} from "../native-path.ts";
import { required } from "./contracts.ts";

export interface QueueTarget {
  readonly inputPath: string;
  readonly targetKey: string;
  readonly queueKeys: readonly string[];
  readonly needsCreateLock: boolean;
  readonly index: number;
}
export interface QueueKeys {
  readonly targetKey: string;
  readonly queueKeys: readonly string[];
  readonly needsCreateLock: boolean;
}
export function resolveInputPath(input: string, cwd: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  return operationPath(input, cwd);
}
export function isMissingPathError(
  error: unknown,
): error is { readonly code: "ENOENT" | "ENOTDIR" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
export function normalizeLockKey(path: string): string {
  const fullPath = join(path);
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return fullPath;
  }
  // Fold the whole prospective target so spelling remains stable as ancestors appear.
  return fullPath.split(sep).map(normalizeLockComponent).join(sep);
}
function normalizeLockComponent(part: string): string {
  return Array.from(part.normalize("NFC"))
    .map((character) => {
      // APFS distinguishes dotless i; both sharp-S spellings fold to ss.
      if (character === "ı") {
        return character;
      }
      if (character === "ẞ") {
        return "ss";
      }
      return character.toUpperCase().toLowerCase();
    })
    .join("")
    .normalize("NFC");
}
export async function entryMutationQueueKeys(filePath: string): Promise<QueueKeys> {
  try {
    await lstat(filePath);
  } catch (error) {
    if (isMissingPathError(error) && error.code === "ENOENT") {
      return mutationQueueKeys(filePath);
    }
    throw error;
  }
  const parent = await nativeRealpath(dirname(filePath));
  const entryPath = join(parent, basename(filePath));
  const entry = await lstat(entryPath);
  const key = await realpath(entryPath).catch((error: unknown) => {
    // ponytail: Pi resolves queue paths, so unresolvable links share their parent queue.
    // Use entry-key native queues if Pi adds them; retain a separate local entry reservation.
    if (entry.isSymbolicLink()) {
      return parent;
    }
    if (isMissingPathError(error)) {
      return entryPath;
    }
    throw error;
  });
  return { targetKey: normalizeLockKey(entryPath), queueKeys: [key], needsCreateLock: false };
}
export async function mutationQueueKeys(filePath: string): Promise<QueueKeys> {
  const resolvedPath = operationPath(filePath);
  try {
    return contentQueueKeys(await realpath(resolvedPath), false);
  } catch (error) {
    if (!isMissingPathError(error)) {
      if ((await lstat(resolvedPath)).isSymbolicLink()) {
        return entryMutationQueueKeys(resolvedPath);
      }
      throw error;
    }
  }
  // Reject dangling aliases before nested Pi acquisition can collapse two keys onto one.
  // External processes can still race discovery; closing that needs Pi atomic multi-key locks.
  await assertNotDanglingSymbolicLink(resolvedPath);
  return contentQueueKeys(await prospectiveTarget(resolvedPath), true);
}
function contentQueueKeys(key: string, needsCreateLock: boolean): QueueKeys {
  return { targetKey: normalizeLockKey(key), queueKeys: [key], needsCreateLock };
}
function isAncestor(left: QueueTarget, right: QueueTarget): boolean {
  const prefix = left.targetKey.endsWith(sep) ? left.targetKey : `${left.targetKey}${sep}`;
  return right.targetKey.startsWith(prefix);
}
function rejectAncestorPair(left: QueueTarget, right: QueueTarget): void {
  if (isAncestor(left, right)) {
    throw new Error(
      `files[${right.index}] (${right.inputPath}) is nested under files[${left.index}] (${left.inputPath}). A batch cannot target a path and one of its ancestors.`,
    );
  }
}
export function assertDistinctTargets(targets: readonly QueueTarget[]): void {
  const seen = new Map<string, number>();
  for (const target of targets) {
    const prior = seen.get(target.targetKey);
    if (prior !== undefined) {
      throw new Error(
        `files[${target.index}] refers to the same file as files[${prior}] (${target.inputPath}). Combine edits for one path into a single entry.`,
      );
    }
    seen.set(target.targetKey, target.index);
  }
  for (const [index, target] of targets.entries()) {
    for (const earlier of targets.slice(0, index)) {
      rejectAncestorPair(earlier, target);
      rejectAncestorPair(target, earlier);
    }
  }
}
export async function changedLinkInPath(
  path: string,
  removedIndex: (key: string) => number | undefined,
): Promise<number | undefined> {
  const seen = new Set<string>();
  const walk = async (input: string): Promise<number | undefined> => {
    for (let current = input; current !== dirname(current); current = dirname(current)) {
      // Parent resolution follows native traversal; each next component depends on it.
      // oxlint-disable-next-line no-await-in-loop
      const directory = await prospectiveDirectory(dirname(current));
      const entry = join(directory, basename(current));
      // The native parent above determines the entry inspected in this iteration.
      // oxlint-disable-next-line no-await-in-loop
      const stats = await lstat(entry).catch((error: unknown) => {
        if (isMissingPathError(error)) {
          return;
        }
        throw error;
      });
      if (stats?.isSymbolicLink() !== true) {
        continue;
      }
      const key = normalizeLockKey(entry);
      const sourceIndex = removedIndex(key);
      if (sourceIndex !== undefined) {
        return sourceIndex;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      // Resolve this link before traversing its dependent referent path.
      // oxlint-disable-next-line no-await-in-loop
      const linked = await walk(operationPath(await readlink(entry), directory));
      if (linked !== undefined) {
        return linked;
      }
    }
    return;
  };
  return walk(path);
}
function registrationSettled(): void {
  // Settlement advances ordering; the returned operation owns the actual failure.
}
let canonicalLockRegistration = Promise.resolve();
export function registerMutation<T>(
  discover: () => Promise<{ readonly operation: Promise<T> }>,
): Promise<T> {
  // Discovery/reservation is ordered, but publication does not block unrelated discovery.
  const registration = canonicalLockRegistration.then(discover);
  canonicalLockRegistration = registration.then(registrationSettled, registrationSettled);
  return registration.then(({ operation }) => operation);
}
const createMutationKey = Symbol("create");
const pendingMutations = new Map<string | symbol, Promise<void>>();
export function withMutationLocks<T>(
  targets: readonly QueueTarget[],
  operation: () => Promise<T>,
  refresh: () => Promise<readonly string[]>,
): Promise<T> {
  const paths = targets.flatMap((target) => target.queueKeys);
  const keys: (string | symbol)[] = [
    ...new Set([...paths, ...targets.map((target) => target.targetKey)]),
  ];
  if (targets.some((target) => target.needsCreateLock)) {
    keys.push(createMutationKey);
  }
  const previous = keys.flatMap((key) => pendingMutations.get(key) ?? []);
  const run = Promise.all(previous).then(async () =>
    withOrderedFileLocks(previous.length > 0 ? await refresh() : paths, operation),
  );
  const release = (): void => {
    for (const key of keys) {
      if (pendingMutations.get(key) === settled) {
        pendingMutations.delete(key);
      }
    }
  };
  const settled = run.then(release, release);
  for (const key of keys) {
    pendingMutations.set(key, settled);
  }
  return run;
}
async function withOrderedFileLocks<T>(
  unordered: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const paths = [...new Set(unordered)].sort();
  const run = async (index: number): Promise<T> => {
    if (index >= paths.length) {
      return operation();
    }
    return withFileMutationQueue(required(paths[index]), () => run(index + 1));
  };
  return run(0);
}
