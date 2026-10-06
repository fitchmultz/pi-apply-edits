import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Operation addresses retain POSIX traversal; Windows uses native DOS normalization. */
export function operationPath(input: string, cwd = process.cwd()): string {
  if (process.platform === "win32") {
    return resolve(cwd, input);
  }
  const directory = isAbsolute(cwd) ? cwd : operationPath(cwd);
  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return isAbsolute(input) ? input : `${prefix}${input}`;
}

export async function nativeRealpath(path: string): Promise<string> {
  // macOS realpath alone accepts file/ and file/..; stat enforces native traversal.
  await stat(path);
  return realpath(path);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function existingDirectory(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw Object.assign(new Error(`A parent path is not a directory: ${path}`), {
      code: "ENOTDIR",
    });
  }
  return realpath(path);
}

export interface ProspectiveDirectory {
  readonly path: string;
  readonly missing: ReadonlySet<string>;
}

/** Owns discovery state; resolution never creates the missing directories. */
class DirectoryDiscovery {
  readonly #missing = new Set<string>();

  async resolve(path: string): Promise<string> {
    try {
      return await existingDirectory(path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
      await assertNotDanglingSymbolicLink(path);
    }
    const parent = dirname(path);
    if (parent === path) {
      throw new Error(`No existing parent directory: ${path}`);
    }
    const candidate = join(await this.resolve(parent), basename(path));
    try {
      return await existingDirectory(candidate);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
      await assertNotDanglingSymbolicLink(candidate);
      this.#missing.add(candidate);
      return candidate;
    }
  }

  async discover(path: string): Promise<ProspectiveDirectory> {
    return { path: await this.resolve(path), missing: this.#missing };
  }
}

/** Resolve components, revisiting links after prospective missing/.. traversal. */
export async function discoverProspectiveDirectory(path: string): Promise<ProspectiveDirectory> {
  return new DirectoryDiscovery().discover(path);
}

export async function prospectiveDirectory(path: string): Promise<string> {
  return new DirectoryDiscovery().resolve(path);
}

// Resolve parents before retrying the target; detects dangling ancestors before queue acquisition.
export async function prospectiveTarget(path: string): Promise<string> {
  const parent = dirname(path);
  if (parent === path) {
    return path;
  }
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parent);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) {
      throw error;
    }
    await assertNotDanglingSymbolicLink(parent);
    canonicalParent = await prospectiveTarget(parent);
  }
  const candidate = join(canonicalParent, basename(path));
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) {
      throw error;
    }
    await assertNotDanglingSymbolicLink(candidate);
  }
  return candidate;
}

export async function assertNotDanglingSymbolicLink(path: string): Promise<void> {
  const entry = await lstat(path).catch((failure: unknown) => {
    if (!hasCode(failure, "ENOENT") && !hasCode(failure, "ENOTDIR")) {
      throw failure;
    }
  });
  if (entry?.isSymbolicLink() === true) {
    throw new Error(`Cannot mutate dangling symbolic link ${path}. No changes were written.`);
  }
}

export function assertFileAddress(path: string): void {
  if (path.endsWith(sep) || basename(path) === "." || basename(path) === "..") {
    throw new Error(
      `Target is a directory path, not a regular file: ${path}. No changes were written.`,
    );
  }
}
