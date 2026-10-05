import { parseSync } from "oxc-parser";

export interface PolicyFinding {
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly rule?: string;
}

const approvedRules = new Set([
  "no-await-in-loop",
  "no-control-regex",
  "typescript/prefer-readonly-parameter-types",
  "typescript/no-unnecessary-condition",
  "node-test/no-conditional-assertions",
]);

/** Inspect actual parser comments, never strings containing fixture or documentation text. */
export function checkSuppressions(path: string, source: string): readonly PolicyFinding[] {
  const parsed = parseSync(path, source);
  const findings: PolicyFinding[] = [];
  for (const error of parsed.errors) {
    findings.push({ path, line: 1, message: `Cannot audit invalid source: ${error.message}` });
  }
  for (const comment of parsed.comments) {
    const line = source.slice(0, comment.start).split("\n").length;
    const message = suppressionError(path, comment.value.trim(), source, comment.start);
    if (message !== undefined) {
      findings.push({ path, line, message });
    }
  }
  return findings;
}

function suppressionError(
  path: string,
  text: string,
  source: string,
  offset: number,
): string | undefined {
  const compilerError = compilerSuppressionError(path, text);
  if (compilerError !== undefined) {
    return compilerError;
  }
  if (/^@ts-expect-error\b/u.test(text)) {
    return;
  }
  return lintSuppressionError(path, text, source, offset);
}

function compilerSuppressionError(path: string, text: string): string | undefined {
  if (/^@ts-(?:ignore|nocheck)\b/u.test(text)) {
    return "Compiler suppression is forbidden in maintained source";
  }
  if (/^@ts-expect-error\b/u.test(text)) {
    if (!path.endsWith(".test-d.ts") || text.replace(/^@ts-expect-error\s*/u, "").length < 10) {
      return "Expected compiler errors require a dedicated .test-d.ts and a description of at least 10 characters";
    }
    return;
  }
  return;
}

function lintSuppressionError(
  path: string,
  text: string,
  source: string,
  offset: number,
): string | undefined {
  if (/^eslint-(?:disable|enable)/u.test(text)) {
    return "Use native, approved single-site Oxlint directives";
  }
  if (!/^oxlint-(?:disable|enable)/u.test(text)) {
    return;
  }
  const directive = /^oxlint-disable-next-line\s+([\w/-]+)\s*$/u.exec(text);
  if (directive === null || !approvedRules.has(directive[1])) {
    return "Only approved rules in exact oxlint-disable-next-line directives are permitted";
  }
  const preceding = explanationBefore(source, offset);
  if (preceding === undefined) {
    return "An adjacent, specific explanation must precede each exception";
  }
  const nextLine = source.slice(source.indexOf("\n", offset) + 1).split("\n")[0] ?? "";
  if (directive[1] === "node-test/no-conditional-assertions") {
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
      ? undefined
      : "Exhaustive conditional assertion exceptions are test-only";
  }
  return semanticExplanationError(directive[1], preceding, nextLine);
}

function explanationBefore(source: string, offset: number): string | undefined {
  const preceding = source.slice(0, offset).trimEnd().split("\n").at(-1) ?? "";
  if (/^\s*\/\/\s+.{20,}$/u.test(preceding) && !/(?:oxlint-|eslint-|@ts-)/u.test(preceding)) {
    return preceding;
  }
  return;
}

function semanticExplanationError(
  rule: string,
  preceding: string,
  nextLine: string,
): string | undefined {
  if (
    rule === "typescript/prefer-readonly-parameter-types" &&
    (!/\b\w+\s*:\s*\([^)]*\)\s*=>\s*[A-Z]\w*/u.test(nextLine) || nextLine.includes("&"))
  ) {
    return "Readonly directives may cover only plain generic-result callables, not mutable inputs or attached properties";
  }
  if (
    rule === "typescript/prefer-readonly-parameter-types" &&
    !/callback|callable|result|generic/iu.test(preceding)
  ) {
    return "Readonly directives are limited to demonstrated generic callback-result defects";
  }
  if (
    rule === "typescript/no-unnecessary-condition" &&
    !/await|cancel|abort|delet|suspension|callback/iu.test(preceding)
  ) {
    return "Condition directives require an asynchronous lifecycle writer explanation";
  }
  return;
}
