import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { conditionalExceptionShape } from "./exception-shapes.ts";
import { exceptionSite } from "./exception-sites.ts";
import { lintDirective } from "./lint-directives.ts";

export interface PolicyFinding {
  readonly path: string;
  readonly line: number;
  readonly message: string;
}
const authorizedSiteSchema = Type.Object({
  path: Type.String(),
  rule: Type.String(),
  id: Type.String(),
  selector: Type.String(),
  count: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
type AuthorizedSite = Readonly<Static<typeof authorizedSiteSchema>>;

function readSites(): readonly AuthorizedSite[] {
  const input: unknown = JSON.parse(
    readFileSync(new URL("./quality-exceptions.json", import.meta.url), "utf8"),
  );
  if (!Value.Check(Type.Array(authorizedSiteSchema), input)) {
    throw new Error(
      "Exception inventory needs file, rule, ID, operation selector, and duplication bound",
    );
  }
  return input;
}
const authorized = readSites();

function authorizedSite(
  path: string,
  source: string,
  offset: number,
  text: string,
): AuthorizedSite | undefined {
  const directive = lintDirective(text);
  if (directive === undefined) {
    return;
  }
  const selector = exceptionSite(path, source, offset, directive.rule);
  return authorized.find(
    (entry) =>
      entry.path === path &&
      entry.rule === directive.rule &&
      entry.id === directive.id &&
      entry.selector === selector,
  );
}

function checkCounts(
  path: string,
  uses: ReadonlyMap<AuthorizedSite, number>,
): readonly PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const site of authorized.filter((entry) => entry.path === path)) {
    const count = uses.get(site) ?? 0;
    if (count !== site.count) {
      findings.push({
        path,
        line: 1,
        message: `Stale or duplicated ${site.id} operation: ${site.selector} (expected ${site.count}, found ${count})`,
      });
    }
  }
  return findings;
}

/** Inspect actual parser comments; fixture strings and documentation text are not directives. */
export function checkSuppressions(path: string, source: string): readonly PolicyFinding[] {
  const parsed = parseSync(path, source);
  const findings: PolicyFinding[] = parsed.errors.map((error) => ({
    path,
    line: 1,
    message: `Cannot audit invalid source: ${error.message}`,
  }));
  const uses = new Map<AuthorizedSite, number>();
  for (const comment of parsed.comments) {
    const line = source.slice(0, comment.start).split("\n").length;
    for (const text of comment.value
      .split("\n")
      .map((value) => value.trim().replace(/^\*\s*/u, ""))) {
      const compiler = compilerSuppressionError(path, text);
      if (compiler !== undefined) {
        findings.push({ path, line, message: compiler });
      }
      if (!/^(?:oxlint(?:-|\s)|eslint(?:-|\s))/u.test(text)) {
        continue;
      }
      const site = authorizedSite(path, source, comment.start, text);
      if (site === undefined) {
        findings.push({
          path,
          line,
          message: "Unauthorized directive: use a recorded QX ID at its exact file and operation",
        });
        continue;
      }
      uses.set(site, (uses.get(site) ?? 0) + 1);
      if (
        site.rule === "node-test/no-conditional-assertions" &&
        !conditionalExceptionShape(path, source, comment.start)
      ) {
        findings.push({
          path,
          line,
          message: "QX-003 requires exhaustive variant assertions, not an optional branch",
        });
      }
    }
  }
  return [...findings, ...checkCounts(path, uses)];
}

function compilerSuppressionError(path: string, text: string): string | undefined {
  if (/^@ts-(?:ignore|nocheck)\b/u.test(text)) {
    return "Compiler suppression is forbidden in maintained source";
  }
  if (
    /^@ts-expect-error\b/u.test(text) &&
    (!/\.test-d\.[cm]?ts$/u.test(path) || text.replace(/^@ts-expect-error\s*/u, "").length < 10)
  ) {
    return "Expected compiler errors require a dedicated type test and a description of at least 10 characters";
  }
  return;
}

export function checkExceptionInventory(files: readonly string[]): readonly PolicyFinding[] {
  const ids = new Map([
    ["max-params", "QX-002"],
    ["node-test/no-conditional-assertions", "QX-003"],
  ]);
  return authorized
    .filter((site) => !files.includes(site.path) || ids.get(site.rule) !== site.id)
    .map((site) => ({
      path: site.path,
      line: 1,
      message: `Stale or unrecognized exception inventory entry ${site.id}`,
    }));
}
