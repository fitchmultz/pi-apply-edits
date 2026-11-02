import { spawnSync } from "node:child_process";

const gates = [
  "policy:check",
  "lint",
  "format:check",
  "typecheck",
  "typecheck:jxa",
  "test",
  "pack:check",
];

for (const gate of gates) {
  process.stdout.write(`\n=== ${gate} ===\n`);
  const result = spawnSync("npm", ["run", gate], { stdio: "inherit" });
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write(
      `${gate} failed: ${result.error?.message ?? result.signal ?? String(result.status)}\n`,
    );
    process.exitCode = 1;
  }
}
