import type { BigIntStats } from "node:fs";
import { link, lstat, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { temporaryPath, unlinkOwnedPath } from "./cleanup.ts";
import { errorMessage, fallbackAllowed } from "./errors.ts";
import { sameIdentity } from "./observation.ts";

interface VolumeSupport {
  /** How the filesystem breaks the file identity that publication verifies, if it does. */
  readonly incoherent?: string | undefined;
  readonly links: boolean;
}

const volumes = new Map<bigint, Promise<VolumeSupport>>();
const listeners = new Set<(directory: string) => void>();

/** Observe publications refused because their filesystem cannot support them. */
export function onUnsupportedFilesystem(listener: (directory: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Hard-link publication verifies inode identity and link counts. Filesystems such as FAT,
 * exFAT, and Docker Desktop's VirtioFS do not keep them, so their files are refused before
 * any staging. Each device is probed once per process.
 */
export async function assertPublicationFilesystem(
  directory: string,
  label: string,
  requireLinks: boolean,
): Promise<void> {
  // Android publishes by exchange, and other platforms do not use hard-link publication.
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return;
  }
  const volume = await volumeSupport(directory, label);
  const limitation =
    volume.incoherent ??
    (requireLinks && !volume.links ? "does not support hard links" : undefined);
  if (limitation === undefined) {
    return;
  }
  for (const listener of listeners) {
    listener(directory);
  }
  throw new Error(
    `Cannot publish ${label}: the filesystem at ${directory} ${limitation}, which verified publication requires. No changes were written. Pi's built-in edit and write tools write in place and can change files on this filesystem.`,
  );
}

async function volumeSupport(directory: string, label: string): Promise<VolumeSupport> {
  const { dev } = await stat(directory, { bigint: true });
  const cached = volumes.get(dev);
  if (cached !== undefined) {
    return cached;
  }
  const probe = probeVolume(directory).catch((error: unknown) => {
    // A failed probe says nothing about the filesystem, so the next publication probes again.
    volumes.delete(dev);
    throw new Error(
      `Could not check the filesystem at ${directory} before publishing ${label}: ${errorMessage(error)}. No changes were written.`,
      { cause: error },
    );
  });
  volumes.set(dev, probe);
  return probe;
}

async function probeVolume(directory: string): Promise<VolumeSupport> {
  const owned = new Map<string, BigIntStats>();
  let result: VolumeSupport | undefined;
  let failure: unknown;
  try {
    result = await observeVolume(directory, owned);
  } catch (error) {
    failure = error;
  }
  for (const [path, stats] of owned) {
    try {
      await unlinkOwnedPath(path, stats, "Filesystem probe file");
    } catch (error) {
      failure ??= error;
    }
  }
  if (result === undefined || failure !== undefined) {
    throw new Error(errorMessage(failure), { cause: failure });
  }
  return result;
}

async function createProbeFile(
  path: string,
  owned: Map<string, BigIntStats>,
): Promise<{ created: BigIntStats; stable: boolean }> {
  const handle = await open(path, "wx", 0o600);
  let opened: BigIntStats;
  let written: BigIntStats;
  try {
    opened = await handle.stat({ bigint: true });
    owned.set(path, opened);
    await handle.writeFile("probe");
    written = await handle.stat({ bigint: true });
  } finally {
    await handle.close();
  }
  const created = await lstat(path, { bigint: true });
  owned.set(path, created);
  return { created, stable: sameIdentity(opened, written) && sameIdentity(written, created) };
}

/** Repeat replacement publication's steps on private files: write, link, and rename over. */
async function observeVolume(
  directory: string,
  owned: Map<string, BigIntStats>,
): Promise<VolumeSupport> {
  const source = temporaryPath(join(directory, "probe"));
  const original = await createProbeFile(source, owned);
  if (!original.stable) {
    return { incoherent: "changes a new file's identity while it is written", links: false };
  }
  const recovery = temporaryPath(source);
  try {
    await link(source, recovery);
  } catch (error) {
    if (fallbackAllowed(error)) {
      return { links: false };
    }
    throw error;
  }
  const linked = await lstat(recovery, { bigint: true });
  owned.set(recovery, linked);
  const replacementPath = temporaryPath(source);
  const replacement = await createProbeFile(replacementPath, owned);
  await rename(replacementPath, source);
  owned.delete(replacementPath);
  const [published, retained] = await Promise.all([
    lstat(source, { bigint: true }),
    lstat(recovery, { bigint: true }),
  ]);
  owned.set(source, published);
  owned.set(recovery, retained);
  if (
    !sameIdentity(original.created, linked) ||
    linked.nlink !== 2n ||
    !sameIdentity(replacement.created, published) ||
    !sameIdentity(original.created, retained) ||
    retained.nlink !== 1n
  ) {
    return {
      incoherent: "does not keep file identity and link counts consistent across a rename",
      links: true,
    };
  }
  return { links: true };
}
