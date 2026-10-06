import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PlannedNewFile } from "./contracts.ts";

interface StagedTreeView {
  readonly entries: readonly PlannedNewFile[];
  readonly staging: string;
}
import { readStableFile, sameSnapshotStats } from "./observation.ts";
import { stagedTraversalDirectories } from "./planning.ts";

export async function inspectPreparedTree(
  prepared: StagedTreeView,
  expectedIdentities?: ReadonlyMap<string, BigIntStats>,
): Promise<Map<string, BigIntStats>> {
  return new StagedTreeInspection(prepared, expectedIdentities).run();
}

/** Owns one fail-closed inspection; no observations are shared with later publication phases. */
class StagedTreeInspection {
  private readonly prepared: StagedTreeView;
  private readonly expectedIdentities: ReadonlyMap<string, BigIntStats> | undefined;
  private readonly expected = new Map<string, Buffer>();
  private readonly expectedDirectories = new Set([""]);
  private readonly seen = new Set<string>();
  private readonly identities = new Map<string, BigIntStats>();

  constructor(prepared: StagedTreeView, expectedIdentities?: ReadonlyMap<string, BigIntStats>) {
    this.prepared = prepared;
    this.expectedIdentities = expectedIdentities;
    this.planExpectedEntries();
  }

  private planExpectedEntries(): void {
    for (const { plan, bytes } of this.prepared.entries) {
      const relativePath = join(...plan.missingDirectories.slice(1), basename(plan.targetPath));
      if (this.expected.has(relativePath)) {
        throw new Error(
          `Duplicate staged create target ${plan.inputPath}. No changes were written.`,
        );
      }
      this.expected.set(relativePath, bytes);
      for (const directory of [dirname(relativePath), ...stagedTraversalDirectories(plan)]) {
        this.rememberDirectories(directory);
      }
    }
  }

  private rememberDirectories(directory: string): void {
    let current = directory;
    while (current !== ".") {
      this.expectedDirectories.add(current);
      current = dirname(current);
    }
  }

  async run(): Promise<Map<string, BigIntStats>> {
    await this.walk(this.prepared.staging, "");
    if (
      this.seen.size !== this.expected.size ||
      (this.expectedIdentities && this.identities.size !== this.expectedIdentities.size)
    ) {
      throw new Error("Staged create tree is incomplete. No changes were written.");
    }
    return this.identities;
  }

  private rememberIdentity(relativePath: string, stats: BigIntStats): void {
    const expected = this.expectedIdentities?.get(relativePath);
    if (this.expectedIdentities && (!expected || !sameSnapshotStats(expected, stats))) {
      throw new Error(
        `Staged create entry changed before publish: ${join(this.prepared.staging, relativePath)}. No changes were written.`,
      );
    }
    this.identities.set(relativePath, stats);
  }

  private async walk(directory: string, relativeDirectory: string): Promise<void> {
    const stats = await lstat(directory, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Staged create tree changed before publish: ${directory}. No changes were written.`,
      );
    }
    this.rememberIdentity(relativeDirectory, stats);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative =
        relativeDirectory.length > 0 ? join(relativeDirectory, entry.name) : entry.name;
      // Complete each bounded tree inspection before following another directory entry.
      // oxlint-disable-next-line no-await-in-loop
      await this.inspectEntry(join(directory, entry.name), relative);
    }
  }

  private async inspectEntry(path: string, relative: string): Promise<void> {
    const stats = await lstat(path, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Staged create tree contains a symbolic link: ${path}. No changes were written.`,
      );
    }
    if (stats.isDirectory()) {
      if (!this.expectedDirectories.has(relative)) {
        throw new Error(
          `Staged create tree contains an unexpected directory: ${path}. No changes were written.`,
        );
      }
      await this.walk(path, relative);
      return;
    }
    const bytes = this.expected.get(relative);
    if (!stats.isFile() || (!this.expectedIdentities && stats.nlink !== 1n) || !bytes) {
      throw new Error(
        `Staged create tree contains an unexpected entry: ${path}. No changes were written.`,
      );
    }
    const current = await readStableFile(path);
    if (!current.bytes.equals(bytes)) {
      throw new Error(
        `Staged create file changed before publish: ${path}. No changes were written.`,
      );
    }
    this.rememberIdentity(relative, current.stats);
    this.seen.add(relative);
  }
}
