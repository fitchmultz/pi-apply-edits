import { parseSync, Visitor } from "oxc-parser";

interface FunctionView {
  readonly params: readonly {
    readonly type: string;
    readonly start: number;
    readonly typeAnnotation?: { readonly typeAnnotation: CallableView } | null;
  }[];
  readonly typeParameters?: {
    readonly params: readonly { readonly name: { readonly name: string } }[];
  } | null;
}
interface CallableView {
  readonly type: string;
  readonly params?: readonly unknown[];
  readonly returnType?: { readonly typeAnnotation: ResultView } | null;
}
interface ResultView {
  readonly type: string;
  readonly typeName?: { readonly type: string; readonly name?: string };
  readonly typeArguments?: unknown;
}

export function plainGenericCallback(path: string, source: string, offset: number): boolean {
  const next = source.indexOf("\n", offset) + 1;
  const end = source.indexOf("\n", next);
  const limit = end < 0 ? source.length : end;
  const validSites: number[] = [];
  const parametersOnSite: number[] = [];
  const inspect = (node: FunctionView): void => {
    const parameters = node.params.filter(
      (parameter) => parameter.start >= next && parameter.start <= limit,
    );
    parametersOnSite.push(...parameters.map((parameter) => parameter.start));
    if (parameters.length !== 1) {
      return;
    }
    const parameter = parameters[0];
    const callable = parameter.typeAnnotation?.typeAnnotation;
    if (
      parameter.type !== "Identifier" ||
      callable === undefined ||
      !plainResultCallable(callable)
    ) {
      return;
    }
    if (hasGenericResult(node, callable)) {
      validSites.push(parameter.start);
    }
  };
  new Visitor({
    FunctionDeclaration: inspect,
    FunctionExpression: inspect,
    ArrowFunctionExpression: inspect,
  }).visit(parseSync(path, source).program);
  return validSites.length === 1 && parametersOnSite.length === 1;
}

function hasGenericResult(node: FunctionView, callable: CallableView): boolean {
  const result = callable.returnType?.typeAnnotation.typeName?.name;
  return (node.typeParameters?.params ?? []).some((generic) => generic.name.name === result);
}

function plainResultCallable(callable: CallableView): boolean {
  const result = callable.returnType?.typeAnnotation;
  return (
    callable.type === "TSFunctionType" &&
    callable.params?.length === 0 &&
    result?.type === "TSTypeReference" &&
    result.typeName?.type === "Identifier" &&
    result.typeArguments === null
  );
}

/** Native code-path validation additionally proves each authorized arm in node-test/valid-exceptions. */
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
