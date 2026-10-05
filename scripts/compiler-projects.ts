import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

export interface CompilerProject {
  readonly files: ReadonlySet<string>;
  readonly checkJs: boolean;
}

export function compilerProjects(paths: readonly string[]): readonly CompilerProject[] {
  return paths
    .filter((path) => /(?:^|\/)(?:ts|js)config(?:\.[^/]+)?\.json$/u.test(path))
    .map(readProject);
}

function compilerOutput(path: string, option: "--showConfig" | "--listFilesOnly"): string {
  const result = spawnSync(
    resolve("node_modules/.bin/tsc"),
    [option, "--project", path, "--pretty", "false"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Cannot resolve compiler scope for ${path}: ${result.error?.message ?? result.stdout + result.stderr}`,
    );
  }
  return result.stdout;
}

/** Resolve inherited settings and the compiler's import closure, not merely its root-file globs. */
function readProject(path: string): CompilerProject {
  const configuration: unknown = JSON.parse(compilerOutput(path, "--showConfig"));
  if (!record(configuration) || !record(configuration.compilerOptions)) {
    throw new Error(`Invalid effective compiler configuration for ${path}`);
  }
  if (
    configuration.compilerOptions.strict !== true ||
    configuration.compilerOptions.noImplicitReturns !== true
  ) {
    throw new Error(`${path} must retain strict and noImplicitReturns`);
  }
  const files = new Set(
    compilerOutput(path, "--listFilesOnly")
      .split(/\r?\n/u)
      .filter((file) => file.length > 0)
      .map((file) => realpathSync(file)),
  );
  return { files, checkJs: configuration.compilerOptions.checkJs === true };
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
