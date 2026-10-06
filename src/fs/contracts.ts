import type { BigIntStats } from "node:fs";

export interface FileSnapshot {
  readonly inputPath: string;
  readonly actualPath: string;
  readonly inputStats: BigIntStats;
  readonly stats: BigIntStats;
  readonly bytes: Buffer;
  readonly symbolicLink: boolean;
}

export interface ReplacementPublishHooks {
  readonly beforeRename?: (paths: {
    readonly target: string;
    readonly temporary: string;
  }) => void | Promise<void>;
  readonly afterRename?: (paths: {
    readonly target: string;
    readonly recovery: string;
  }) => void | Promise<void>;
  readonly beforeConflictReturn?: (paths: {
    readonly target: string;
    readonly recovery: string;
  }) => void | Promise<void>;
  readonly beforeRecoveryCleanup?: (paths: {
    readonly target: string;
    readonly recovery: string;
  }) => void | Promise<void>;
}

export interface NewFilePlan {
  readonly inputPath: string;
  readonly targetPath: string;
  readonly ancestorPath: string;
  readonly ancestorDev: bigint;
  readonly ancestorIno: bigint;
  readonly missingDirectories: readonly string[];
  readonly traversalDirectories: readonly string[];
  readonly traversalParents: ReadonlyMap<string, BigIntStats>;
}

export interface NewFilePublishHooks {
  readonly beforeDirectoryPublish?: (paths: {
    readonly staging: string;
    readonly target: string;
  }) => void | Promise<void>;
  readonly beforeDirectoryCommit?: (paths: {
    readonly staging: string;
    readonly target: string;
  }) => void | Promise<void>;
  readonly beforeRootReserve?: (paths: {
    readonly staging: string;
    readonly target: string;
  }) => void | Promise<void>;
  readonly afterRootReserve?: (paths: {
    readonly staging: string;
    readonly target: string;
  }) => void | Promise<void>;
  readonly beforeFilePublish?: (paths: {
    readonly temporary: string;
    readonly target: string;
  }) => void | Promise<void>;
  readonly afterFilePublish?: (paths: { readonly target: string }) => void | Promise<void>;
}

export interface PlannedNewFile {
  readonly plan: NewFilePlan;
  readonly bytes: Buffer;
  readonly move?: {
    readonly entry: EntrySnapshot;
    readonly snapshot?: FileSnapshot;
    readonly hooks?: EntryPublishHooks;
  };
}

export interface PreparedNestedFiles {
  readonly entries: readonly PlannedNewFile[];
  readonly firstPlan: NewFilePlan;
  readonly publishRoot: string;
  readonly container: string;
  readonly staging: string;
  readonly quarantine: string;
  readonly warnings: readonly string[];
  readonly hooks?: NewFilePublishHooks;
  readonly published: boolean;
  readonly discardAttempted: boolean;
  readonly containerStats?: BigIntStats;
  readonly stagingStats?: BigIntStats;
  readonly quarantineStats?: BigIntStats;
  readonly cleanupBlocked?: string;
  readonly stagedIdentities?: ReadonlyMap<string, BigIntStats>;
}

export interface EntrySnapshot {
  readonly inputPath: string;
  readonly actualPath: string;
  readonly stats: BigIntStats;
  readonly parentPath: string;
  readonly parentStats: BigIntStats;
  readonly symbolicLink: boolean;
  readonly linkTarget?: Buffer;
}

export interface EntryMovePlan {
  readonly entry: EntrySnapshot;
  readonly destination: NewFilePlan;
}

export interface EntryPublishHooks {
  readonly beforeCommit?: () => void | Promise<void>;
  readonly afterCommit?: () => void | Promise<void>;
  readonly beforeSourceDelete?: () => void | Promise<void>;
}

export interface MoveReplacement {
  readonly snapshot: FileSnapshot;
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
