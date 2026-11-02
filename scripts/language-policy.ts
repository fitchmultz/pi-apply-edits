import { dirname, resolve, relative } from "node:path";
import { parseSync, Visitor } from "oxc-parser";
import type { PolicyFinding } from "./suppression-policy.ts";

export function checkLanguageScope(
  path: string,
  project: { readonly assigned: boolean; readonly checkJs: boolean },
): readonly PolicyFinding[] {
  if (!/\.[cm]?[jt]sx?$/u.test(path)) {
    return [];
  }
  if (!project.assigned) {
    return [
      { path, line: 1, message: "Maintained source must belong to a checked compiler project" },
    ];
  }
  if (/\.[cm]?jsx?$/u.test(path) && !project.checkJs) {
    return [
      {
        path,
        line: 1,
        message:
          "Maintained JavaScript requires project-wide allowJs and checkJs (standard section 4.2)",
      },
    ];
  }
  return [];
}

function testOnly(path: string): boolean {
  return (
    path.startsWith("test/") || /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/u.test(path)
  );
}

export function checkSourceProfiles(path: string, source: string): readonly PolicyFinding[] {
  if (testOnly(path)) {
    return [];
  }
  const findings: PolicyFinding[] = [];
  const inspect = (specifier: string, start: number): void => {
    if (
      specifier.startsWith(".") &&
      testOnly(relative(process.cwd(), resolve(dirname(path), specifier)))
    ) {
      findings.push({
        path,
        line: source.slice(0, start).split("\n").length,
        message:
          "Production source cannot depend on test-only support; move shared code to production coverage",
      });
    }
  };
  new Visitor({
    ImportDeclaration(node) {
      inspect(node.source.value, node.start);
    },
    ExportNamedDeclaration(node) {
      if (node.source !== null) {
        inspect(node.source.value, node.start);
      }
    },
    ExportAllDeclaration(node) {
      inspect(node.source.value, node.start);
    },
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        inspect(node.source.value, node.start);
      }
    },
  }).visit(parseSync(path, source).program);
  return findings;
}
