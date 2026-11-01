import { parseSync, Visitor } from "oxc-parser";

interface Span {
  readonly start: number;
  readonly end: number;
}
interface Owner extends Span {
  readonly label: string;
}
interface Operation extends Span {
  readonly text: string;
  readonly kind: "call" | "function";
}

function collect(
  source: string,
  path: string,
): {
  readonly owners: readonly Owner[];
  readonly operations: readonly Operation[];
} {
  const owners: Owner[] = [];
  const operations: Operation[] = [];
  const text = (node: Span): string =>
    source.slice(node.start, node.end).replace(/\s+/gu, " ").trim();
  const fn = (node: Span & { readonly body: Span | null }): void => {
    if (node.body !== null) {
      operations.push({
        ...node,
        kind: "function",
        text: text({ start: node.start, end: node.body.start }),
      });
    }
  };
  new Visitor({
    FunctionDeclaration(node) {
      fn(node);
      if (node.id !== null) {
        owners.push({ ...node, label: `function ${node.id.name}` });
      }
    },
    FunctionExpression: fn,
    ArrowFunctionExpression: fn,
    Property(node) {
      if (node.method && node.key.type === "Identifier") {
        owners.push({ ...node, label: `method ${node.key.name}` });
      }
    },
    MethodDefinition(node) {
      if (node.key.type === "Identifier" || node.key.type === "PrivateIdentifier") {
        owners.push({ ...node, label: `method ${node.key.name}` });
      }
    },
    CallExpression(node) {
      operations.push({ ...node, kind: "call", text: text(node) });
      const callee = node.callee;
      let name = "";
      if (callee.type === "Identifier") {
        name = callee.name;
      }
      if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
        name = callee.property.name;
      }
      const first = node.arguments[0];
      if (["nodeTest", "test"].includes(name) && first !== undefined) {
        owners.push({ ...node, label: `test ${text(first)}` });
      }
    },
    IfStatement(node) {
      owners.push({ ...node.consequent, label: `if ${text(node.test)}` });
      if (node.alternate !== null) {
        owners.push({ ...node.alternate, label: `else ${text(node.test)}` });
      }
    },
    SwitchCase(node) {
      owners.push({ ...node, label: node.test === null ? "default" : `case ${text(node.test)}` });
    },
  }).visit(parseSync(path, source).program);
  return { owners, operations };
}

/** File + enclosing test/function + branch + actual operation, independent of line numbers. */
export function exceptionSite(
  path: string,
  source: string,
  offset: number,
  rule: string,
): string | undefined {
  const start = source.indexOf("\n", offset) + 1;
  const newline = source.indexOf("\n", start);
  const end = newline < 0 ? source.length : newline;
  const { owners, operations } = collect(source, path);
  const kind = rule === "max-params" ? "function" : "call";
  const targets = operations
    .filter(
      (operation) => operation.kind === kind && operation.start >= start && operation.start < end,
    )
    .sort((a, b) => a.start - b.start);
  const target = targets[0];
  if (target === undefined || targets.some((operation) => operation.start > target.end)) {
    return;
  }
  if (kind === "function" && targets.length !== 1) {
    return;
  }
  const context = owners
    .filter((owner) => owner.start <= target.start && owner.end >= target.end)
    .sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start))
    .map((owner) => owner.label);
  return [...context, target.text].join(" > ");
}
