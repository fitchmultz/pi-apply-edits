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
  beforeRename?:
    | ((paths: { readonly target: string; readonly temporary: string }) => void | Promise<void>)
    | undefined;
  afterRename?:
    | ((paths: { readonly target: string; readonly recovery: string }) => void | Promise<void>)
    | undefined;
  beforeConflictReturn?:
    | ((paths: { readonly target: string; readonly recovery: string }) => void | Promise<void>)
    | undefined;
  beforeRecoveryCleanup?:
    | ((paths: { readonly target: string; readonly recovery: string }) => void | Promise<void>)
    | undefined;
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
  beforeDirectoryPublish?:
    | ((paths: { readonly staging: string; readonly target: string }) => void | Promise<void>)
    | undefined;
  beforeDirectoryCommit?:
    | ((paths: { readonly staging: string; readonly target: string }) => void | Promise<void>)
    | undefined;
  beforeRootReserve?:
    | ((paths: { readonly staging: string; readonly target: string }) => void | Promise<void>)
    | undefined;
  afterRootReserve?:
    | ((paths: { readonly staging: string; readonly target: string }) => void | Promise<void>)
    | undefined;
  beforeFilePublish?:
    | ((paths: { readonly temporary: string; readonly target: string }) => void | Promise<void>)
    | undefined;
  afterFilePublish?: ((paths: { readonly target: string }) => void | Promise<void>) | undefined;
}

export interface PlannedNewFile {
  plan: NewFilePlan;
  bytes: Buffer;
  move?:
    | {
        entry: EntrySnapshot;
        snapshot?: FileSnapshot | undefined;
        hooks?: EntryPublishHooks | undefined;
      }
    | undefined;
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
  hooks?: Hooks | undefined;
  published: boolean;
  discardAttempted: boolean;
  containerStats?: BigIntStats | undefined;
  stagingStats?: BigIntStats | undefined;
  quarantineStats?: BigIntStats | undefined;
  cleanupBlocked?: string | undefined;
  stagedIdentities?: Map<string, BigIntStats> | undefined;
}

export interface EntrySnapshot {
  inputPath: string;
  actualPath: string;
  stats: BigIntStats;
  parentPath: string;
  parentStats: BigIntStats;
  symbolicLink: boolean;
  linkTarget?: Buffer | undefined;
}

/** `entry` is the caller's own snapshot, so its type follows the planned argument. */
export interface EntryMovePlan<Entry extends ReadonlyEntrySnapshot = EntrySnapshot> {
  entry: Entry;
  destination: NewFilePlan;
  /** The destination names the source entry itself under another case or normalization. */
  respelling?: boolean | undefined;
}

export interface EntryPublishHooks {
  beforeCommit?: (() => void | Promise<void>) | undefined;
  afterCommit?: (() => void | Promise<void>) | undefined;
  beforeSourceDelete?: (() => void | Promise<void>) | undefined;
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
  readonly move?:
    | {
        readonly entry: ReadonlyEntrySnapshot;
        readonly snapshot?: ReadonlyFileSnapshot | undefined;
        readonly hooks?: ReadonlyEntryPublishHooks | undefined;
      }
    | undefined;
}
export interface ReadonlyEntryMovePlan {
  readonly entry: ReadonlyEntrySnapshot;
  readonly destination: ReadonlyNewFilePlan;
  readonly respelling?: boolean | undefined;
}
export type ReadonlyPreparedNestedFiles = Readonly<
  Omit<
    PreparedNestedFiles<readonly ReadonlyPlannedNewFile[], ReadonlyNewFilePublishHooks>,
    "warnings" | "stagedIdentities"
  >
> & {
  readonly warnings: readonly string[];
  readonly stagedIdentities?: ReadonlyMap<string, BigIntStats> | undefined;
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
      readonly getcap?: string | undefined;
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
