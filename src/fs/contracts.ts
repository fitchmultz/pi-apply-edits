import type { BigIntStats } from "node:fs";

export interface FileSnapshot {
  inputPath: string;
  actualPath: string;
  inputStats: BigIntStats;
  stats: BigIntStats;
  bytes: Buffer;
  symbolicLink: boolean;
}

export interface ReplacementPublishHooks {
  beforeRename?: (paths: {
    readonly target: string;
    readonly temporary: string;
  }) => void | Promise<void>;
  afterRename?: (paths: {
    readonly target: string;
    readonly recovery: string;
  }) => void | Promise<void>;
  beforeConflictReturn?: (paths: {
    readonly target: string;
    readonly recovery: string;
  }) => void | Promise<void>;
  beforeRecoveryCleanup?: (paths: {
    readonly target: string;
    readonly recovery: string;
  }) => void | Promise<void>;
}

export interface NewFilePlan {
  inputPath: string;
  targetPath: string;
  ancestorPath: string;
  ancestorDev: bigint;
  ancestorIno: bigint;
  missingDirectories: string[];
  traversalDirectories: string[];
  traversalParents: Map<string, BigIntStats>;
}

export interface NewFilePublishHooks {
  beforeDirectoryPublish?: (paths: {
    readonly staging: string;
    readonly target: string;
  }) => void | Promise<void>;
  beforeDirectoryCommit?: (paths: {
    readonly staging: string;
    readonly target: string;
  }) => void | Promise<void>;
  beforeRootReserve?: (paths: {
    readonly staging: string;
    readonly target: string;
  }) => void | Promise<void>;
  afterRootReserve?: (paths: {
    readonly staging: string;
    readonly target: string;
  }) => void | Promise<void>;
  beforeFilePublish?: (paths: {
    readonly temporary: string;
    readonly target: string;
  }) => void | Promise<void>;
  afterFilePublish?: (paths: { readonly target: string }) => void | Promise<void>;
}

export interface PlannedNewFile {
  plan: NewFilePlan;
  bytes: Buffer;
  move?: { entry: EntrySnapshot; snapshot?: FileSnapshot; hooks?: EntryPublishHooks };
}

/**
 * `entries`, `firstPlan` and `hooks` are the caller's own values, so their types follow the
 * arguments; the defaults describe mutable arguments.
 */
export interface PreparedNestedFiles<
  Entries extends readonly ReadonlyPlannedNewFile[] = PlannedNewFile[],
  Hooks extends ReadonlyNewFilePublishHooks = NewFilePublishHooks,
> {
  entries: Entries;
  firstPlan: Entries[number]["plan"];
  publishRoot: string;
  container: string;
  staging: string;
  quarantine: string;
  warnings: string[];
  hooks?: Hooks;
  published: boolean;
  discardAttempted: boolean;
  containerStats?: BigIntStats;
  stagingStats?: BigIntStats;
  quarantineStats?: BigIntStats;
  cleanupBlocked?: string;
  stagedIdentities?: Map<string, BigIntStats>;
}

export interface EntrySnapshot {
  inputPath: string;
  actualPath: string;
  stats: BigIntStats;
  parentPath: string;
  parentStats: BigIntStats;
  symbolicLink: boolean;
  linkTarget?: Buffer;
}

/** `entry` is the caller's own snapshot, so its type follows the planned argument. */
export interface EntryMovePlan<Entry extends ReadonlyEntrySnapshot = EntrySnapshot> {
  entry: Entry;
  destination: NewFilePlan;
}

export interface EntryPublishHooks {
  beforeCommit?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
  beforeSourceDelete?: () => void | Promise<void>;
}

/** Read views of caller-owned inputs; filesystem owners only read them. */
export type ReadonlyFileSnapshot = Readonly<FileSnapshot>;
export type ReadonlyEntrySnapshot = Readonly<EntrySnapshot>;
export type ReadonlyReplacementPublishHooks = Readonly<ReplacementPublishHooks>;
export type ReadonlyNewFilePublishHooks = Readonly<NewFilePublishHooks>;
export type ReadonlyEntryPublishHooks = Readonly<EntryPublishHooks>;
export type ReadonlyNewFilePlan = Readonly<
  Omit<NewFilePlan, "missingDirectories" | "traversalDirectories" | "traversalParents">
> & {
  readonly missingDirectories: readonly string[];
  readonly traversalDirectories: readonly string[];
  readonly traversalParents: ReadonlyMap<string, BigIntStats>;
};
export interface ReadonlyPlannedNewFile {
  readonly plan: ReadonlyNewFilePlan;
  readonly bytes: Buffer;
  readonly move?: {
    readonly entry: ReadonlyEntrySnapshot;
    readonly snapshot?: ReadonlyFileSnapshot;
    readonly hooks?: ReadonlyEntryPublishHooks;
  };
}
export interface ReadonlyEntryMovePlan {
  readonly entry: ReadonlyEntrySnapshot;
  readonly destination: ReadonlyNewFilePlan;
}
export type ReadonlyPreparedNestedFiles = Readonly<
  Omit<
    PreparedNestedFiles<readonly ReadonlyPlannedNewFile[], ReadonlyNewFilePublishHooks>,
    "warnings" | "stagedIdentities"
  >
> & {
  readonly warnings: readonly string[];
  readonly stagedIdentities?: ReadonlyMap<string, BigIntStats>;
};

export interface MoveReplacement {
  readonly snapshot: ReadonlyFileSnapshot;
  readonly bytes: Buffer;
}

export interface FileState {
  readonly stats: BigIntStats;
  readonly bytes: Buffer;
}

export type ReplacementSupport =
  | {
      readonly supported: true;
      readonly strategy: "hard-link";
      readonly cp: string;
      readonly getcap?: string;
    }
  | {
      readonly supported: true;
      readonly strategy: "exchange";
      readonly cp: string;
      readonly mv: string;
      readonly getfacl: string;
      readonly getfattr: string;
    }
  | { readonly supported: false; readonly reason: string };

export type AndroidReplacementSupport = Extract<
  ReplacementSupport,
  { supported: true; strategy: "exchange" }
>;
