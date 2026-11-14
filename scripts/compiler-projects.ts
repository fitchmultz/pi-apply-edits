import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";

const effectiveConfigSchema = Type.Object({
  compilerOptions: Type.Record(Type.String(), Type.Unknown()),
});

export interface CompilerProject {
  readonly files: ReadonlySet<string>;
  readonly checkJs: boolean;
  readonly skipLibCheck: boolean;
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
  if (!Value.Check(effectiveConfigSchema, configuration)) {
    throw new Error(`Invalid effective compiler configuration for ${path}`);
  }
  for (const option of [
    "strict",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "noImplicitOverride",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noUncheckedSideEffectImports",
    "forceConsistentCasingInFileNames",
  ]) {
    if (configuration.compilerOptions[option] !== true) {
      throw new Error(`${path} must retain ${option}: true (standard section 4.2)`);
    }
  }
  if (configuration.compilerOptions.noCheck !== false) {
    throw new Error(`${path} must retain noCheck: false`);
  }
  for (const option of [
    "alwaysStrict",
    "noImplicitAny",
    "noImplicitThis",
    "strictBindCallApply",
    "strictBuiltinIteratorReturn",
    "strictFunctionTypes",
    "strictNullChecks",
    "strictPropertyInitialization",
    "useUnknownInCatchVariables",
  ]) {
    if (configuration.compilerOptions[option] === false) {
      throw new Error(`${path} must not disable ${option}`);
    }
  }
  const files = new Set(
    compilerOutput(path, "--listFilesOnly")
      .split(/\r?\n/u)
      .filter((file) => file.length > 0)
      .map((file) => realpathSync(file)),
  );
  return {
    files,
    checkJs:
      configuration.compilerOptions.checkJs === true &&
      configuration.compilerOptions.allowJs === true,
    skipLibCheck: configuration.compilerOptions.skipLibCheck === true,
  };
}
