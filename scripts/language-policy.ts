import { parseSync } from "oxc-parser";
import type { PolicyFinding } from "./suppression-policy.ts";

/** Only leading single-line pragmas affect TypeScript's JavaScript checking status. */
export function leadingCheck(path: string, source: string): boolean {
  const parsed = parseSync(path, source);
  const first = parsed.program.body[0]?.start ?? source.length;
  const pragma = parsed.comments.findLast(
    (comment) =>
      comment.type === "Line" &&
      comment.end <= first &&
      /^\s*@ts-(?:check|nocheck)\b/u.test(comment.value),
  );
  return pragma !== undefined && /^\s*@ts-check\b/u.test(pragma.value);
}

export function checkLanguageScope(
  path: string,
  source: string,
  project: { readonly assigned: boolean; readonly checkJs: boolean },
): readonly PolicyFinding[] {
  if (/\.[cm]?tsx?$/u.test(path)) {
    return project.assigned
      ? []
      : [
          {
            path,
            line: 1,
            message: "Maintained TypeScript must belong to a checked compiler project",
          },
        ];
  }
  if (!/\.[cm]?jsx?$/u.test(path)) {
    return [];
  }
  const checked = leadingCheck(path, source) || project.checkJs;
  if (path === "src/macos-acl.js") {
    return checked
      ? [
          {
            path,
            line: 1,
            message:
              "JXA became checked; remove its semantic-rule override before opting it into checking",
          },
        ]
      : [];
  }
  if (checked) {
    return project.assigned
      ? []
      : [{ path, line: 1, message: "Checked JavaScript must belong to a compiler project" }];
  }
  return [
    {
      path,
      line: 1,
      message:
        "Classify new JavaScript from effective project settings and add an explicit unchecked-language override when it has no semantic opt-in",
    },
  ];
}
