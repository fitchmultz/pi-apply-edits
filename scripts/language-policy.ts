import { parseSync } from "oxc-parser";
import type { PolicyFinding } from "./suppression-policy.ts";

/** New JavaScript must be intentionally assigned, never silently dropped from semantic coverage. */
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
  const checked = parseSync(path, source).comments.some((comment) =>
    /^\s*@ts-check\b/u.test(comment.value),
  );
  if (path === "src/macos-acl.js") {
    return checked
      ? [
          {
            path,
            line: 1,
            message:
              "JXA is explicitly unchecked; remove its semantic-rule override before opting it into checking",
          },
        ]
      : [];
  }
  if (checked || project.checkJs) {
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
