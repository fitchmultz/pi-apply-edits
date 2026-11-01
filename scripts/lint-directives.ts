import type { Rule } from "eslint";

export function lintDirective(
  text: string,
): { readonly rule: string; readonly id: string } | undefined {
  const match = /^\s*oxlint-disable-next-line\s+([\w/-]+)\s+-- (QX-\d+): .+\s*$/u.exec(text);
  const rule = match?.[1];
  const id = match?.[2];
  return rule === undefined || id === undefined ? undefined : { rule, id };
}

export function hasConditionalDirective(
  source: Readonly<Rule.RuleContext["sourceCode"]>,
  line: number,
): boolean {
  return source.getAllComments().some((comment) => {
    if (comment.loc?.end.line !== line - 1) {
      return false;
    }
    const directive = lintDirective(comment.value);
    return directive?.rule === "node-test/no-conditional-assertions" && directive.id === "QX-003";
  });
}
