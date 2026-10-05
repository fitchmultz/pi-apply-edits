import type { BigIntStats } from "node:fs";
import { lstat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { assertEntryDeletePathBudget } from "../path-budget.ts";
import type { EntrySnapshot, EntryPublishHooks } from "./contracts.ts";
import {
  assertCreatedDirectoryOwner,
  rmdirOwnedPath,
  temporaryDirectoryPath,
  unlinkOwnedPath,
} from "./cleanup.ts";
import { errorMessage, PublicationError, throwIfAborted } from "./errors.ts";
import { lstatIfExists, samePublishedState, syncDirectory } from "./observation.ts";
import { assertEntryCurrent, assertEntryParentCurrent } from "./snapshot.ts";

export async function publishEntryDelete(
  entry: EntrySnapshot,
  signal?: AbortSignal,
  hooks?: EntryPublishHooks,
): Promise<string[]> {
  return new EntryDeletion(entry, signal, hooks).run();
}

/** Owns the retained entry until its deletion is verified and identity-checked cleanup finishes. */
class EntryDeletion {
  private readonly entry: EntrySnapshot;
  private readonly signal: AbortSignal | undefined;
  private readonly hooks: EntryPublishHooks | undefined;
  private readonly directory: string;
  private readonly retained: string;
  private directoryStats: BigIntStats | undefined;
  private started = false;
  private verified = false;
  private readonly warnings: string[] = [];

  constructor(entry: EntrySnapshot, signal?: AbortSignal, hooks?: EntryPublishHooks) {
    this.entry = entry;
    this.signal = signal;
    this.hooks = hooks;
    this.directory = temporaryDirectoryPath(entry.actualPath);
    this.retained = join(this.directory, "entry");
  }

  async run(): Promise<string[]> {
    assertEntryDeletePathBudget(this.entry.actualPath, this.entry.inputPath);
    let failure: PublicationError | undefined;
    try {
      await this.commit();
    } catch (error) {
      failure = new PublicationError(
        `${errorMessage(error)}${this.started ? ` The removed entry may remain at ${this.retained}.` : ""}`,
        this.verified ? [this.entry.actualPath] : [],
        this.started && !this.verified ? [this.entry.actualPath] : [],
      );
    }
    await this.cleanup(failure);
    if (failure) {
      throw failure;
    }
    return this.warnings;
  }

  private async commit(): Promise<void> {
    throwIfAborted(this.signal);
    await assertEntryCurrent(this.entry);
    await mkdir(this.directory, { mode: 0o700 });
    const directoryStats = await lstat(this.directory, { bigint: true });
    assertCreatedDirectoryOwner(directoryStats, this.directory);
    this.directoryStats = directoryStats;
    await this.hooks?.beforeCommit?.();
    await assertEntryCurrent(this.entry);
    throwIfAborted(this.signal);
    await rename(this.entry.actualPath, this.retained);
    this.started = true;
    const moved = await lstat(this.retained, { bigint: true });
    await assertEntryParentCurrent(this.entry);
    if (
      !samePublishedState(this.entry.stats, moved) ||
      (await lstatIfExists(this.entry.actualPath))
    ) {
      throw new Error(
        `Deletion could not be verified; inspect ${this.entry.actualPath} and retained entry ${this.retained}.`,
      );
    }
    this.verified = true;
    await this.hooks?.afterCommit?.();
    if (!(await unlinkOwnedPath(this.retained, moved, "Deleted entry"))) {
      throw new Error(
        `Deleted entry is no longer at ${this.retained}; cleanup could not be verified.`,
      );
    }
    const warning = await syncDirectory(this.entry.parentPath);
    if (warning !== undefined) {
      this.warnings.push(warning);
    }
  }

  private async cleanup(
    failure?: Readonly<Pick<PublicationError, "message" | "modifiedFiles" | "uncertainFiles">>,
  ): Promise<void> {
    if (!this.directoryStats) {
      return;
    }
    try {
      await rmdirOwnedPath(this.directory, this.directoryStats, "Entry cleanup directory");
    } catch (error) {
      const message = `Entry cleanup directory remains at ${this.directory}: ${errorMessage(error)}`;
      if (failure) {
        throw new PublicationError(
          `${failure.message} ${message}`,
          failure.modifiedFiles,
          failure.uncertainFiles,
        );
      }
      this.warnings.push(message);
    }
  }
}
