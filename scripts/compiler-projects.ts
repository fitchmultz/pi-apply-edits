import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export interface CompilerProject {
  readonly files: ReadonlySet<string>;
  readonly checkJs: boolean;
}

/** Ask the canonical compiler to resolve inheritance and membership rather than guessing globs. */
export function compilerProjects(paths: readonly string[]): readonly CompilerProject[] {
  return paths
    .filter((path) => /(?:^|\/)(?:ts|js)config(?:\.[^/]+)?\.json$/u.test(path))
    .map(readProject);
}

function readProject(path: string): CompilerProject {
  const result = spawnSync(resolve("node_modules/.bin/tsc"), ["--showConfig", "--project", path], {
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Cannot resolve compiler scope for ${path}: ${result.error?.message ?? result.stdout + result.stderr}`,
    );
  }
  const configuration: unknown = JSON.parse(result.stdout);
  if (
    !record(configuration) ||
    !record(configuration.compilerOptions) ||
    !Array.isArray(configuration.files)
  ) {
    throw new Error(`Invalid effective compiler configuration for ${path}`);
  }
  if (
    configuration.compilerOptions.strict !== true ||
    configuration.compilerOptions.noImplicitReturns !== true
  ) {
    throw new Error(`${path} must retain strict and noImplicitReturns`);
  }
  const files = new Set(
    configuration.files.map((file: unknown) => {
      if (typeof file !== "string") {
        throw new Error(`Invalid compiler member in ${path}`);
      }
      return resolve(dirname(path), file);
    }),
  );
  return { files, checkJs: configuration.compilerOptions.checkJs === true };
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
