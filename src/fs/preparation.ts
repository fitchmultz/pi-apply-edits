import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import type { EntrySnapshot, FileSnapshot } from "./contracts.ts";
import { unlinkOwnedPath } from "./cleanup.ts";
import { errorMessage } from "./errors.ts";
import { readStableRegularEntry, samePreservedMetadata, sameSnapshotStats } from "./observation.ts";
import { assertNoLinuxCapabilities, cloneWithMetadata } from "./platform.ts";
import {
  androidMetadataForSnapshot,
  assertSafeToReplace,
  assertSnapshotCurrent,
} from "./snapshot.ts";

export function assertMoveSnapshot(entry: EntrySnapshot, snapshot?: FileSnapshot): void {
  if (!snapshot) {
    return;
  }
  if (entry.symbolicLink) {
    throw new Error(`Cannot edit symbolic-link content while moving its entry: ${entry.inputPath}`);
  }
  if (snapshot.actualPath !== entry.actualPath || !sameSnapshotStats(entry.stats, snapshot.stats)) {
    throw new Error(`Move content snapshot does not match the source entry: ${entry.inputPath}`);
  }
}

export async function prepareMoveReplacement(
  path: string,
  snapshot: FileSnapshot,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<BigIntStats> {
  await assertSafeToReplace(snapshot, signal);
  await assertSnapshotCurrent(snapshot);
  await cloneWithMetadata(snapshot.actualPath, path, signal, androidMetadataForSnapshot(snapshot));
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const cloned = await handle.stat({ bigint: true });
    if (!cloned.isFile() || cloned.nlink !== 1n || !samePreservedMetadata(snapshot.stats, cloned)) {
      throw new Error(`Could not preserve source metadata for move: ${snapshot.inputPath}`);
    }
    await handle.truncate(0);
    await handle.writeFile(bytes, { signal });
    await handle.sync();
    const prepared = await handle.stat({ bigint: true });
    if (!samePreservedMetadata(snapshot.stats, prepared)) {
      throw new Error(`Move metadata changed: ${snapshot.inputPath}`);
    }
    if (process.platform === "linux") {
      await assertNoLinuxCapabilities(path, signal);
    }
    return prepared;
  } finally {
    await handle.close();
  }
}

export async function preparePrivatePublicationFile(
  path: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<BigIntStats> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: BigIntStats | undefined;
  try {
    handle = await open(path, "wx", 0o666);
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(bytes, { signal });
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    const current = await readStableRegularEntry(path);
    if (!sameSnapshotStats(stats, current.stats) || !current.bytes.equals(bytes)) {
      throw new Error(`Private publication file changed while preparing ${path}`);
    }
    return current.stats;
  } catch (error) {
    await handle?.close().catch(() => {
      // Descriptor-close failure must not replace the publication and identity-cleanup outcome.
    });
    if (identity) {
      try {
        await unlinkOwnedPath(path, identity, "Private publication file");
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup was incomplete: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}
