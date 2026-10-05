import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type MockTracker } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as filesystem from "../src/file-system.ts";
import * as editing from "../src/apply-edits.ts";

type FileSystemModule = Readonly<
  Pick<
    typeof filesystem,
    | "captureSnapshot"
    | "planNewFile"
    | "publishNewFile"
    | "publishReplacement"
    | "supportsExistingFileReplacement"
  >
>;
type EditingModule = Readonly<typeof editing>;

function isNamespace(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

// Only repository-controlled modules copied below are loaded. Verify their export
// shape before exposing the corresponding compile-time module contract.
function isFileSystemModule(value: unknown): value is FileSystemModule {
  return (
    isNamespace(value) &&
    Object.entries(filesystem).every(([name, original]) => typeof value[name] === typeof original)
  );
}

function isEditingModule(value: unknown): value is EditingModule {
  return (
    isNamespace(value) &&
    Object.entries(editing).every(([name, original]) => typeof value[name] === typeof original)
  );
}

async function withPrivateSources(
  patch: (tracker: MockTracker) => void,
  run: (source: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-race-modules-"));
  try {
    // Copy the entire relative graph: publication and queue owners must have private
    // module state even after production decomposition. Native modules stay shared.
    await cp(new URL("../src", import.meta.url), join(directory, "src"), { recursive: true });
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "junction",
    );
    patch(mock);
    syncBuiltinESMExports();
    await run(join(directory, "src"));
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function withRacingFileSystem(
  patch: (tracker: MockTracker) => void,
  run: (module: FileSystemModule) => Promise<void>,
): Promise<void> {
  await withPrivateSources(patch, async (source) => {
    const loaded: unknown = await import(pathToFileURL(join(source, "file-system.ts")).href);
    assert(isFileSystemModule(loaded), "private filesystem module exports differ from source");
    await run(loaded);
  });
}

export async function withRacingEditing(
  patch: (tracker: MockTracker) => void,
  run: (module: EditingModule) => Promise<void>,
): Promise<void> {
  await withPrivateSources(patch, async (source) => {
    const loaded: unknown = await import(pathToFileURL(join(source, "apply-edits.ts")).href);
    assert(isEditingModule(loaded), "private editing module exports differ from source");
    await run(loaded);
  });
}
