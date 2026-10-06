import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const policy: unknown = JSON.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8"));
export const lintExecutable = join(root, "node_modules", ".bin", "oxlint");

export interface Diagnostic {
  readonly code: string;
  readonly filename: string;
  readonly line: number;
  readonly column: number;
}
export interface ProbeResult {
  readonly status: number | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly stdout: string;
  readonly stderr: string;
}

export function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function policyRule(rule: string): unknown {
  assert(record(policy));
  assert(record(policy.rules));
  const option = policy.rules[rule];
  assert.notEqual(option, undefined, `${rule} must be configured explicitly`);
  return option;
}

export function focusedConfig(
  rules: Readonly<Record<string, unknown>>,
  compilerDiagnostics = false,
): string {
  return JSON.stringify({
    plugins: ["eslint", "typescript", "unicorn", "promise", "import"],
    env: { node: true },
    categories: { correctness: "off" },
    options: { typeAware: true, typeCheck: compilerDiagnostics, denyWarnings: true },
    rules,
  });
}

export function effectiveConfig(): string {
  assert(record(policy));
  return JSON.stringify({
    ...policy,
    jsPlugins: [{ name: "node-test", specifier: join(root, "scripts", "node-test-plugin.ts") }],
  });
}

/** Keep the repository's exact runner rule options while isolating control-flow diagnostics. */
export function frameworkConfig(): string {
  assert(record(policy));
  assert(Array.isArray(policy.overrides));
  const testRules: unknown = policy.overrides.find(
    (override: unknown) =>
      record(override) && record(override.rules) && "node-test/expect-assertions" in override.rules,
  );
  assert(record(testRules));
  assert(record(testRules.rules));
  return JSON.stringify({
    plugins: ["eslint"],
    categories: { correctness: "off" },
    jsPlugins: [{ name: "node-test", specifier: join(root, "scripts", "node-test-plugin.ts") }],
    rules: Object.fromEntries(
      Object.entries(testRules.rules).filter(([name]) => name.startsWith("node-test/")),
    ),
  });
}

export async function inProbe<T>(
  files: Readonly<Record<string, string>>,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-quality-"));
  try {
    await mkdir(join(directory, "node_modules"));
    const dependencies = await readdir(join(root, "node_modules"));
    await Promise.all(
      dependencies.map(async (dependency) => {
        await symlink(
          join(root, "node_modules", dependency),
          join(directory, "node_modules", dependency),
          "dir",
        );
      }),
    );
    const inputs = {
      "package.json": '{"type":"module"}',
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          noImplicitReturns: true,
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          types: ["node"],
        },
        include: ["**/*.ts"],
      }),
      ...files,
    };
    await Promise.all(
      Object.entries(inputs).map(async ([path, content]) => {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), content);
      }),
    );
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function lint(directory: string, paths: readonly string[] = ["."]): ProbeResult {
  const result = spawnSync(lintExecutable, ["--format=json", ...paths], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.stderr);
  const output: unknown = JSON.parse(result.stdout);
  assert(record(output), result.stdout);
  assert(Array.isArray(output.diagnostics), result.stdout);
  const diagnostics = output.diagnostics.map((item: unknown) => {
    assert(record(item));
    assert.equal(typeof item.code, "string");
    assert.equal(typeof item.filename, "string");
    assert(Array.isArray(item.labels));
    const label: unknown = item.labels[0];
    assert(record(label));
    assert(record(label.span));
    assert.equal(typeof label.span.line, "number");
    assert.equal(typeof label.span.column, "number");
    if (
      typeof item.code !== "string" ||
      typeof item.filename !== "string" ||
      typeof label.span.line !== "number" ||
      typeof label.span.column !== "number"
    ) {
      throw new Error("Invalid diagnostic shape");
    }
    return {
      code: item.code,
      filename: item.filename,
      line: label.span.line,
      column: label.span.column,
    };
  });
  return { status: result.status, diagnostics, stdout: result.stdout, stderr: result.stderr };
}

export function expectDiagnostics(
  result: ProbeResult,
  expected: readonly (readonly [string, number, number?])[],
  filename = "probe.ts",
): void {
  assert(
    result.diagnostics.every((diagnostic) => diagnostic.filename === filename),
    result.stdout,
  );
  assert.equal(result.status, expected.length === 0 ? 0 : 1, result.stdout);
  const columns = expected.some((diagnostic) => diagnostic.length === 3);
  assert.deepEqual(
    result.diagnostics
      .map((diagnostic) =>
        columns
          ? [diagnostic.code, diagnostic.line, diagnostic.column]
          : [diagnostic.code, diagnostic.line],
      )
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [...expected].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    result.stdout,
  );
}
