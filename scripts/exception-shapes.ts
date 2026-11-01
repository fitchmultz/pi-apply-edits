import { parseSync, Visitor } from "oxc-parser";

/** Native node-test/valid-exceptions additionally proves assertions on every authorized arm. */
export function conditionalExceptionShape(path: string, source: string, offset: number): boolean {
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) {
    return false;
  }
  const next = source.indexOf("\n", offset) + 1;
  let scoped = false;
  new Visitor({
    IfStatement(node) {
      if (node.alternate !== null && next >= node.start && next <= node.end) {
        scoped = true;
      }
    },
    SwitchStatement(node) {
      if (
        node.cases.some((branch) => branch.test === null) &&
        next >= node.start &&
        next <= node.end
      ) {
        scoped = true;
      }
    },
  }).visit(parseSync(path, source).program);
  return scoped;
}
