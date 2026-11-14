import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkSuppressions, checkExceptionInventory } from "./suppression-policy.ts";
import { checkLanguageScope, checkSourceProfiles } from "./language-policy.ts";
import { compilerProjects } from "./compiler-projects.ts";
import { checkQualityConfig } from "./quality-config.ts";

const help = `Usage: node scripts/check-policy.ts [--help]\n\nAudit maintained source for approved suppressions and effective compiler/language scope.\nExample: npm run policy:check\nExits 1 for violations; 0 when the policy is satisfied.\n`;
const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" } } });
if (values.help === true) {
  process.stdout.write(help);
} else {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path.length > 0 && lstatSync(path, { throwIfNoEntry: false }) !== undefined);
  const projects = compilerProjects(files);
  const sourceFiles = files.filter((path) => /\.[cm]?[jt]sx?$/u.test(path));
  const findings = sourceFiles.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const membership = projects.filter((project) => project.files.has(realpathSync(path)));
    return [
      ...checkSuppressions(path, source),
      ...checkLanguageScope(path, {
        assigned: membership.length > 0,
        checkJs: membership.some((project) => project.checkJs),
      }),
      ...checkSourceProfiles(path, source),
      ...(/\.d\.[cm]?ts$/u.test(path) && !membership.some((project) => !project.skipLibCheck)
        ? [
            {
              path,
              line: 1,
              message: "Handwritten declarations require a project with skipLibCheck: false",
            },
          ]
        : []),
    ];
  });
  findings.push(...checkQualityConfig(files), ...checkExceptionInventory(files));
  for (const finding of findings) {
    process.stderr.write(`${finding.path}:${finding.line}: ${finding.message}\n`);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write(`Policy passed for ${sourceFiles.length} maintained source files.\n`);
  }
}
