import { constants, type BigIntStats } from "node:fs";
import { access, lstat, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import {
  assertFileAddress,
  nativeRealpath,
  operationPath,
  discoverProspectiveDirectory,
} from "../native-path.ts";
import type { NewFilePlan } from "./contracts.ts";
import {
  assertCreatedDirectoryOwner,
  assertPublishedDirectoriesCurrent,
  removeEmptyOwnedDirectory,
} from "./cleanup.ts";
import { errorMessage, isCode, throwIfAborted } from "./errors.ts";

/** Bind a missing target to its validated canonical ancestor and traversal preconditions. */
export async function planNewFile(
  targetPath: string,
  requireWritable = true,
): Promise<NewFilePlan> {
  const inputPath = operationPath(targetPath);
  assertFileAddress(inputPath);
  const targetName = basename(inputPath);
  const { path: parent, missing: traversedMissing } = await discoverProspectiveDirectory(
    dirname(inputPath),
  );
  if (traversedMissing.has(join(parent, targetName))) {
    throw new Error(
      `Create target is required as a traversal directory: ${inputPath}. No changes were written.`,
    );
  }
  const traversalDirectories = [...traversedMissing].filter(
    (path) => parent !== path && !parent.startsWith(`${path}${sep}`),
  );
  const traversalParents = await captureTraversalParents(
    traversalDirectories,
    traversedMissing,
    requireWritable,
    targetPath,
  );
  const ancestor = await findCreateAncestor(parent, targetPath);
  if (requireWritable) {
    await assertDirectoryWritableForPublish(ancestor.path, targetPath);
  }
  return {
    inputPath,
    targetPath: join(ancestor.path, ...ancestor.missing, targetName),
    ancestorPath: ancestor.path,
    ancestorDev: ancestor.stats.dev,
    ancestorIno: ancestor.stats.ino,
    missingDirectories: ancestor.missing,
    traversalDirectories,
    traversalParents,
  };
}

async function captureTraversalParents(
  paths: readonly string[],
  missing: ReadonlySet<string>,
  requireWritable: boolean,
  targetPath: string,
): Promise<ReadonlyMap<string, BigIntStats>> {
  const parents = new Map<string, BigIntStats>();
  for (const path of paths) {
    const parent = dirname(path);
    if (!missing.has(parent)) {
      if (requireWritable) {
        // Validate required traversal parents in native traversal order.
        // oxlint-disable-next-line no-await-in-loop
        await assertDirectoryWritableForPublish(parent, targetPath);
      }
      // The parent snapshot is captured only after its permission check finishes.
      // oxlint-disable-next-line no-await-in-loop
      parents.set(parent, await stat(parent, { bigint: true }));
    }
  }
  return parents;
}

async function findCreateAncestor(
  parent: string,
  targetPath: string,
): Promise<{
  readonly path: string;
  readonly stats: BigIntStats;
  readonly missing: readonly string[];
}> {
  const missing: string[] = [];
  let current = parent;
  while (true) {
    // Discover one parent at a time because the next address depends on the previous result.
    // oxlint-disable-next-line no-await-in-loop
    const stats = await createParentStats(current, targetPath);
    if (!stats) {
      const next = dirname(current);
      if (next === current) {
        throw new Error(
          `Cannot create ${targetPath}: no existing parent directory. No changes were written.`,
        );
      }
      missing.unshift(basename(current));
      current = next;
      continue;
    }
    // Canonical resolution requires the successful ancestor discovery above.
    // oxlint-disable-next-line no-await-in-loop
    const path = await canonicalCreateAncestor(current, stats, targetPath);
    // The canonical target must be a directory, not just a resolvable entry.
    // oxlint-disable-next-line no-await-in-loop
    const ancestorStats = await stat(path, { bigint: true });
    if (!ancestorStats.isDirectory()) {
      throw new Error(
        `Cannot create ${targetPath}: a parent path is not a directory. No changes were written.`,
      );
    }
    return { path, stats: ancestorStats, missing };
  }
}

async function createParentStats(
  path: string,
  targetPath: string,
): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return;
    }
    if (isCode(error, "ENOTDIR")) {
      throw new Error(
        `Cannot create ${targetPath}: a parent path is not a directory. No changes were written.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function canonicalCreateAncestor(
  path: string,
  stats: BigIntStats,
  targetPath: string,
): Promise<string> {
  try {
    return await nativeRealpath(path);
  } catch (error) {
    if (stats.isSymbolicLink() && isCode(error, "ENOENT")) {
      throw new Error(
        `Cannot create ${targetPath}: a parent path is a dangling symbolic link. No changes were written.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function assertDirectoryWritableForPublish(
  directoryPath: string,
  labelPath: string,
): Promise<void> {
  try {
    await access(directoryPath, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error(
      `Directory must be writable to publish ${labelPath} (${directoryPath}). No changes were written.`,
      { cause: error },
    );
  }
}

export async function assertNewFilePlanCurrent(plan: NewFilePlan): Promise<void> {
  const ancestor = await stat(plan.ancestorPath, { bigint: true });
  if (
    !ancestor.isDirectory() ||
    ancestor.dev !== plan.ancestorDev ||
    ancestor.ino !== plan.ancestorIno
  ) {
    throw new Error(
      `Create parent changed after planning ${plan.inputPath}. No changes were written.`,
    );
  }
  await assertDirectoryWritableForPublish(plan.ancestorPath, plan.inputPath);
  let current = plan.ancestorPath;
  for (const part of plan.missingDirectories) {
    current = join(current, part);
    try {
      // Each directory address depends on the previous component and stops at the first missing entry.
      // oxlint-disable-next-line no-await-in-loop
      const stats = await lstat(current, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Create parent changed after planning ${plan.inputPath}. No changes were written.`,
        );
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        break;
      }
      throw error;
    }
  }
}

export function stagedTraversalDirectories(plan: NewFilePlan): string[] {
  const first = plan.missingDirectories.at(0);
  if (first === undefined) {
    return [];
  }
  const prefix = `${join(plan.ancestorPath, first)}${sep}`;
  return plan.traversalDirectories
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length));
}

/** Owns only traversal directories canceled by later `..`, and identity-checks their cleanup. */
export class TraversalDirectories {
  private readonly created = new Map<string, BigIntStats>();

  async publish(
    plans: readonly NewFilePlan[],
    signal?: AbortSignal,
    stagedRoot?: string,
  ): Promise<void> {
    const parents = new Map(plans.flatMap((plan) => [...plan.traversalParents]));
    for (const path of new Set(plans.flatMap((plan) => plan.traversalDirectories))) {
      if (stagedRoot !== undefined && path.startsWith(`${stagedRoot}${sep}`)) {
        continue;
      }
      // Revalidate ancestors and finish each traversal-directory claim before proceeding.
      // oxlint-disable-next-line no-await-in-loop
      await this.claim(path, parents, signal);
    }
    await assertPublishedDirectoriesCurrent(parents);
    await assertPublishedDirectoriesCurrent(this.created);
    for (const plan of plans) {
      // Planned targets are rechecked after all prerequisite traversal directories exist.
      // oxlint-disable-next-line no-await-in-loop
      await assertNewFilePlanCurrent(plan);
    }
  }

  private async claim(
    path: string,
    parents: ReadonlyMap<string, BigIntStats>,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await assertPublishedDirectoriesCurrent(parents);
    await assertPublishedDirectoriesCurrent(this.created);
    let owned = true;
    try {
      await mkdir(path, { mode: 0o777 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) {
        throw error;
      }
      owned = false;
    }
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Create traversal directory changed: ${path}`);
    }
    if (owned) {
      assertCreatedDirectoryOwner(info, path);
      this.created.set(path, info);
    }
  }

  async remove(): Promise<void> {
    const failures: string[] = [];
    for (const [path, stats] of [...this.created].reverse()) {
      try {
        // Remove child directories before their parents and retain every cleanup failure.
        // oxlint-disable-next-line no-await-in-loop
        await removeEmptyOwnedDirectory(path, stats, "Create traversal directory");
      } catch (error) {
        failures.push(`${path}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  }
}
