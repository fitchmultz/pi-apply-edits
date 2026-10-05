import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { checkSuppressions } from "./suppression-policy.ts";
import { checkLanguageScope } from "./language-policy.ts";
import { compilerProjects } from "./compiler-projects.ts";

const help = `Usage: node scripts/check-policy.ts [--help]\n\nAudit maintained source for approved suppressions and effective compiler/language scope.\nExample: npm run policy:check\nExits 1 for violations; 0 when the policy is satisfied.\n`;
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(help);
} else {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path.length > 0);
  const projects = compilerProjects(files);
  const sourceFiles = files.filter((path) => /\.[cm]?[jt]sx?$/u.test(path));
  const findings = sourceFiles.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const membership = projects.filter((project) => project.files.has(realpathSync(path)));
    return [
      ...checkSuppressions(path, source),
      ...checkLanguageScope(path, source, {
        assigned: membership.length > 0,
        checkJs: membership.some((project) => project.checkJs),
      }),
    ];
  });
  for (const finding of findings) {
    process.stderr.write(`${finding.path}:${finding.line}: ${finding.message}\n`);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write(`Policy passed for ${sourceFiles.length} maintained source files.\n`);
  }
}
