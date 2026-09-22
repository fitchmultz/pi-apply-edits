import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Operation addresses retain POSIX traversal; Windows uses its native DOS path normalization. */
export function operationPath(input: string, cwd = process.cwd()): string {
  if (process.platform === "win32") return resolve(cwd, input);
  if (!isAbsolute(cwd)) cwd = operationPath(cwd);
  return isAbsolute(input) ? input : `${cwd.endsWith(sep) ? cwd : `${cwd}${sep}`}${input}`;
}

export async function nativeRealpath(path: string): Promise<string> {
  // macOS realpath alone accepts file/ and file/..; stat enforces native traversal.
  await stat(path);
  return realpath(path);
}

async function missingPath(path: string, error: unknown): Promise<void> {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  await assertNotDanglingSymbolicLink(path);
}

/** Resolve one component at a time, revisiting existing links after prospective missing/.. traversal. */
export async function prospectiveDirectory(path: string, missing: Set<string> = new Set()): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw Object.assign(new Error(`A parent path is not a directory: ${path}`), { code: "ENOTDIR" });
    return await realpath(path);
  } catch (error) {
    await missingPath(path, error);
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`No existing parent directory: ${path}`);
  const candidate = join(await prospectiveDirectory(parent, missing), basename(path));
  try {
    const info = await stat(candidate);
    if (!info.isDirectory()) throw Object.assign(new Error(`A parent path is not a directory: ${candidate}`), { code: "ENOTDIR" });
    return await realpath(candidate);
  } catch (error) {
    await missingPath(candidate, error);
    missing.add(candidate);
    return candidate;
  }
}

// Queue discovery is deliberately separate from strict publication validation.
// Unavailable local identities still reserve a key; registration never creates parents.
export async function prospectiveTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) { await assertNotDanglingSymbolicLink(path, error); }
  const parent = dirname(path);
  if (parent === path) return path;
  const candidate = join(await prospectiveTarget(parent), basename(path));
  try { return await realpath(candidate); }
  catch (error) { await assertNotDanglingSymbolicLink(candidate, error); }
  return candidate;
}

export async function assertNotDanglingSymbolicLink(path: string, error?: unknown): Promise<void> {
  if (error !== undefined && !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  });
  if (entry?.isSymbolicLink()) throw new Error(`Cannot mutate dangling symbolic link ${path}. No changes were written.`);
}

export function assertFileAddress(path: string): void {
  if (path.endsWith(sep) || basename(path) === "." || basename(path) === "..") {
    throw new Error(`Target is a directory path, not a regular file: ${path}. No changes were written.`);
  }
}
