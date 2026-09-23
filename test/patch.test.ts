import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { applyPatchUpdate, bindPatchPaths, parsePatch, type PatchOperation } from "../src/patch.ts";

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
function update(body: string): Extract<PatchOperation, { kind: "update" }> {
  const operation = parsePatch(wrap(`*** Update File: file.txt\n${body}`)).operations[0]!;
  assert.equal(operation.kind, "update");
  return operation as Extract<PatchOperation, { kind: "update" }>;
}
const apply = (original: string, body: string) => applyPatchUpdate(original, update(body));

// These four input/patch/expected triples reproduce the selected official fixture
// bytes, not output snapshots of this implementation. Copyright 2025 OpenAI,
// Apache-2.0 (LICENSE-codex). Source: codex-rs/apply-patch/tests/fixtures/scenarios
// at 4e21628f9ec9ee656650cd2b62ef92225725b5ac (rust-v0.155.1).
for (const fixture of [
  {
    name: "003_multiple_chunks", path: "multi.txt",
    original: "line1\nline2\nline3\nline4\n",
    patch: "@@\n-line2\n+changed2\n@@\n-line4\n+changed4",
    expected: "line1\nchanged2\nline3\nchanged4\n",
  },
  {
    name: "016_pure_addition_update_chunk", path: "input.txt",
    original: "line1\nline2\n", patch: "@@\n+added line 1\n+added line 2",
    expected: "line1\nline2\nadded line 1\nadded line 2\n",
  },
  {
    name: "022_update_file_end_of_file_marker", path: "tail.txt",
    original: "first\nsecond\n", patch: "@@\n first\n-second\n+second updated\n*** End of File",
    expected: "first\nsecond updated\n",
  },
  {
    name: "023_preserves_crlf_line_endings", path: "lines.txt",
    original: "one\r\ntwo\r\nthree\r\n", patch: "@@\n-one\n+ONE\n two\n+between\n three",
    expected: "ONE\r\ntwo\r\nbetween\r\nthree\r\n",
  },
]) {
  test(`Codex fixture: ${fixture.name}`, () => {
    const operation = parsePatch(wrap(`*** Update File: ${fixture.path}\n${fixture.patch}`) + "\n").operations[0]!;
    assert.equal(operation.kind, "update");
    if (operation.kind === "update") assert.equal(applyPatchUpdate(fixture.original, operation).text, fixture.expected);
  });
}

test("parses add, empty add, delete, update, move and pure move", () => {
  const { operations, paths } = parsePatch(wrap(
    "*** Add File: new\n+hello\n+\n*** Add File: empty\n*** Delete File: gone\n" +
    "*** Update File: old\n*** Move to: moved\n@@\n-old\n+new\n" +
    "*** Update File: unchanged\n*** Move to: destination",
  ));
  assert.deepEqual(operations, [
    { kind: "add", path: "new", content: "hello\n\n" },
    { kind: "add", path: "empty", content: "" },
    { kind: "delete", path: "gone" },
    { kind: "update", path: "old", moveTo: "moved", chunks: [{ anchors: [], lines: [
      { kind: "delete", text: "old" }, { kind: "add", text: "new" },
    ], endOfFile: false }] },
    { kind: "update", path: "unchanged", moveTo: "destination", chunks: [] },
  ]);
  assert.deepEqual(paths.map((span) => span.path), ["new", "empty", "gone", "old", "moved", "unchanged", "destination"]);
  assert.equal(applyPatchUpdate("\uFEFFunchanged\r\nlast", operations[4] as Extract<PatchOperation, { kind: "update" }>).text, "\uFEFFunchanged\r\nlast");
});

test("requires a strict envelope and rejects malformed or duplicate structural markers", () => {
  // Deliberate deviations: no heredoc wrapper, padded marker, empty patch,
  // environment ID, or unprefixed empty context line accepted by lenient Codex.
  for (const patch of [
    "", "*** Begin Patch\n*** End Patch", "*** Begin Patch\n*** Add File: f\n+x",
    "*** Add File: f\n+x\n*** End Patch", wrap("*** Begin Patch\n*** Delete File: f"),
    wrap("*** End Patch\n*** Delete File: f"), wrap("*** Delete File: f") + "\n*** End Patch",
    " " + wrap("*** Delete File: f"), wrap("*** Delete File: f") + " ",
    `<<'EOF'\n${wrap("*** Delete File: f")}\nEOF`, wrap("*** Environment ID: remote\n*** Delete File: f"),
    wrap("*** Add File: \n+x"), wrap("*** Update File: \n-old\n+new"), wrap("*** Delete File: "),
    wrap("*** Update File: f\n*** Move to: "), wrap("*** Move to: f"),
    wrap("*** Update File: f\n*** Move to: g\n*** Move to: h"),
    wrap("*** Delete File: f\n+x"), wrap("*** Add File: f\n x"),
    wrap("*** Update File: f"), wrap("*** Update File: f\n@@"),
    wrap("*** Update File: f\n@@ \n-old\n+new"), wrap("*** Update File: f\n\n-old\n+new"),
    wrap("*** Update File: f\n@@\nold\n+new"), wrap("*** Update File: f\n*** End of File"),
    wrap("*** Update File: f\n-old\n+new\n*** End of File\n*** End of File"),
    wrap("*** Update File: f\n-old\n+new\n*** End of File\n@@\n+extra"),
  ]) assert.throws(() => parsePatch(patch), /patch|Patch|Update|File/);
});

test("validates Unicode and NUL in paths, patch bodies and original text", () => {
  for (const invalid of ["\0", "\ud800", "\udc00"]) {
    assert.throws(() => parsePatch(wrap(`*** Add File: ${invalid}\n+x`)), /NUL|Unicode/);
    assert.throws(() => parsePatch(wrap(`*** Add File: f\n+${invalid}`)), /NUL|Unicode/);
    assert.throws(() => apply(invalid, "@@\n+x"), /NUL|Unicode/);
  }
  assert.equal(apply("🙂\n", "@@\n-🙂\n+🧭").text, "🧭\n");
});

test("binds original UTF-16 header spans only, with literal path spelling", () => {
  const paths = ["🙂 @ ~ file\u00a0 ", "~/literal", "@name", "file://literal", "  ", resolve("/tmp", "absolute") + "/../kept  "];
  const input = "*** Begin Patch\r\n" + paths.map((path, index) =>
    index % 2 === 0
      ? `*** Add File: ${path}\r\n+*** Update File: body path\r\n+@ ~ \u2009text  \r\n`
      : `*** Update File: ${path}\r\n*** Move to: move ${index} \r\n@@\r\n-old\r\n+new\r\n`,
  ).join("") + "*** End Patch\r\n";
  const parsed = parsePatch(input);
  for (const span of parsed.paths) assert.equal(input.slice(span.start, span.end), span.path);
  const cwd = resolve("/tmp", "literal-cwd");
  const bound = bindPatchPaths(input, cwd);
  const rebound = parsePatch(bound);
  assert.deepEqual(rebound.paths.map((span) => span.path), parsed.paths.map((span) =>
    isAbsolute(span.path) ? span.path : process.platform === "win32" ? resolve(cwd, span.path) : `${cwd}/${span.path}`,
  ));
  const withoutPaths = (text: string) => {
    const spans = parsePatch(text).paths;
    for (let i = spans.length - 1; i >= 0; i--) text = text.slice(0, spans[i]!.start) + "<PATH>" + text.slice(spans[i]!.end);
    return text;
  };
  assert.equal(withoutPaths(bound), withoutPaths(input));
  assert.equal(bindPatchPaths(bound, resolve("/elsewhere")), bound);
  assert.throws(() => bindPatchPaths(input, "relative"), /cwd must be absolute/);
  assert.throws(() => bindPatchPaths(input, "/bad\0"), /NUL/);
});

test("binding relative patch paths rejects line breaks in the working directory", () => {
  const input = wrap("*** Add File: rel\n+content");
  const absolute = wrap(`*** Delete File: ${resolve("/tmp", "existing")}`);
  for (const ending of ["\n", "\r"]) {
    const cwd = `${resolve("/tmp", "safe")}${ending}*** Delete File: ${resolve("/tmp", "important")}`;
    assert.throws(() => bindPatchPaths(input, cwd), /line break/);
    assert.equal(bindPatchPaths(absolute, cwd), absolute);
  }
});

test("new files preserve literal body bytes and mixed patch line endings", () => {
  const input = "*** Begin Patch\r\n*** Add File: @ literal \r+\uFEFFfirst  \r\n+second\n+third\r*** End Patch";
  assert.deepEqual(parsePatch(input).operations, [{ kind: "add", path: "@ literal ", content: "\uFEFFfirst  \r\nsecond\nthird\r" }]);
});

test("bounds file operations and chunks without a blanket text-size ceiling", () => {
  const files = (count: number) => wrap(Array.from({ length: count }, (_, i) => `*** Add File: ${i}`).join("\n"));
  assert.equal(parsePatch(files(64)).operations.length, 64);
  assert.throws(() => parsePatch(files(65)), /64 file operations/);
  const chunks = (count: number) => Array.from({ length: count }, (_, i) => `@@\n-${i}\n+new ${i}`).join("\n");
  assert.equal(update(chunks(100)).chunks.length, 100);
  assert.throws(() => update(chunks(101)), /100 chunks/);
});

test("stacked anchors all resolve in strict source order and appear in match receipts", () => {
  const original = "class A\n  method\n    old\nend\n";
  const result = apply(original, "@@ class A\n@@ method\n-old\n+literal");
  assert.equal(result.text, "class A\n  method\nliteral\nend\n");
  assert.deepEqual(result.matches, [
    { line: 1, strategy: "exact" }, { line: 2, strategy: "whitespace" }, { line: 3, strategy: "whitespace" },
  ]);
  for (const anchors of ["@@ absent", "@@ class A\n@@ absent", "@@ method\n@@ class A"]) {
    assert.throws(() => apply(original, `${anchors}\n-old\n+new`), /Could not find anchor/);
  }
  assert.throws(() => apply(original, "@@ absent\n+append"), /Could not find anchor/);
  assert.throws(() => apply(original, "@@ absent\n+append\n*** End of File"), /Could not find anchor/);
});

test("unscoped repeated blocks and repeated anchors reject ambiguity", () => {
  const original = "first\nold\nsecond\nold\n";
  assert.throws(() => apply(original, "@@\n-old\n+new"), /Ambiguous context.*2, 4/);
  assert.throws(() => apply("method\nold\nmethod\nother\n", "@@ method\n-old\n+new"), /Ambiguous anchor/);
  assert.throws(() => apply(" old \n\told\n", "@@\n-old\n+new"), /Ambiguous context/);
  assert.throws(() => apply("“old”\n”old“\n", '@@\n-"old"\n+new'), /Ambiguous context/);
});

test("unique full context or suffix anchors disambiguate without guessed language boundaries", () => {
  const original = "first\nold\nsecond\nold\n";
  assert.equal(apply(original, "@@\n first\n-old\n+new").text, "first\nnew\nsecond\nold\n");
  assert.equal(apply(original, "@@ second\n-old\n+new").text, "first\nold\nsecond\nnew\n");
  // A first-section anchor does not invent a scope ending at the next section.
  assert.throws(() => apply(original, "@@ first\n-old\n+new"), /Ambiguous context/);
});

test("matching prioritizes exact, trailing-whitespace, trimmed, then punctuation", () => {
  assert.deepEqual(apply("  old  \nold\n", "@@\n-old\n+new"), {
    text: "  old  \nnew\n", matches: [{ line: 2, strategy: "exact" }],
  });
  assert.deepEqual(apply("  old\nold  \n", "@@\n-old\n+new"), {
    text: "  old\nnew\n", matches: [{ line: 2, strategy: "whitespace" }],
  });
  assert.deepEqual(apply("  “old”—value\u00a0here  \n", '@@\n-"old"-value here\n+  literal\t'), {
    text: "  literal\t\n", matches: [{ line: 1, strategy: "typography" }],
  });
  assert.throws(() => apply("ﬁle\n", "@@\n-file\n+new"), /Could not find/);
  assert.throws(() => apply("prefix old suffix\n", "@@\n-old\n+new"), /Could not find/);
});

test("fuzzy context survives byte-for-byte; inserted indentation stays literal", () => {
  const original = "  “context”  \r\n    old\rnext\nfinal";
  const result = apply(original, '@@\n "context"\n-old\n+\tnew\n next');
  assert.equal(result.text, "  “context”  \r\n\tnew\rnext\nfinal");
  assert.deepEqual(result.matches, [{ line: 1, strategy: "typography" }]);
});

test("BOM, local mixed line endings and missing terminal newline survive updates", () => {
  const original = "\uFEFFone\r\ntwo\nthree\rfour";
  assert.equal(apply(original, "@@\n-one\n+ONE\n two\n-three\n+THREE\n-four\n+FOUR").text,
    "\uFEFFONE\r\ntwo\nTHREE\rFOUR");
  assert.equal(apply("\uFEFF\uFEFFkeep\nold", "@@\n-old\n+new").text, "\uFEFF\uFEFFkeep\nnew");
  assert.throws(() => apply("before\n\uFEFFold\n", "@@\n-old\n+new"), /Could not find/);
  assert.equal(apply("\uFEFFold", "@@\n-old").text, "\uFEFF");
});

test("verbatim first-line BOM patches preserve exactly one encoding BOM", () => {
  const original = '\uFEFFexport const value = 1;\r\nexport const label = "stable";\r\n';
  const result = apply(original, "@@\n-\uFEFFexport const value = 1;\n+\uFEFFexport const value = 2;");
  assert.deepEqual(result, {
    text: '\uFEFFexport const value = 2;\r\nexport const label = "stable";\r\n',
    matches: [{ line: 1, strategy: "exact" }],
  });
});

test("BOM-aware anchors and fuzzy context stay at the source boundary", () => {
  const original = '\uFEFF  “head”  \r\nold\rtail';
  assert.deepEqual(apply(original, '@@ \uFEFF"head"\n-old\n+new'), {
    text: '\uFEFF  “head”  \r\nnew\rtail',
    matches: [{ line: 1, strategy: "typography" }, { line: 2, strategy: "exact" }],
  });
  assert.equal(apply(original, ' \uFEFF"head"\n-old\n+new').text, '\uFEFF  “head”  \r\nnew\rtail');
  assert.throws(() => apply("\uFEFFhead\nold\n", "@@ head\n-\uFEFFold\n+new"), /Could not find/);
  assert.throws(() => apply("\uFEFFhead\nold\n", "-\uFEFFhead\n+new\n*** End of File"), /at end of file/);
});

test("double-leading BOM content survives explicit and omitted encoding markers", () => {
  for (const marker of ["\uFEFF", "\uFEFF\uFEFF"]) {
    assert.equal(apply("\uFEFF\uFEFFold\r\n", `-${marker}old\n+${marker}new`).text, "\uFEFF\uFEFFnew\r\n");
  }
  assert.equal(apply("\uFEFFold", "-\uFEFFold\n+new").text, "\uFEFFnew");
  assert.equal(apply("\uFEFFold", "-old\n+new").text, "\uFEFFnew");
  assert.equal(apply("\uFEFFold", "-\uFEFFold\n+\uFEFFnew\n+\uFEFFinterior").text, "\uFEFFnew\n\uFEFFinterior");
});

test("BOM boundary matches participate in uniqueness without rewriting interior U+FEFF", () => {
  const original = "\uFEFFold\n\uFEFFold\n";
  assert.throws(() => apply(original, "-\uFEFFold\n+\uFEFFnew"), /Ambiguous context.*1, 2/);
  assert.throws(() => apply(original, "@@ \uFEFFold\n+new"), /Ambiguous anchor.*1, 2/);
  assert.throws(() => apply('\uFEFF“old”\n\uFEFF“old”\n', '-\uFEFF"old"\n+new'), /Ambiguous context.*1, 2/);
  assert.deepEqual(apply(original, "-\uFEFFold\n+\uFEFFnew\n*** End of File"), {
    text: "\uFEFFold\n\uFEFFnew\n", matches: [{ line: 2, strategy: "exact" }],
  });
  assert.equal(apply(original, "-old\n+new").text, "\uFEFFnew\n\uFEFFold\n");
  assert.deepEqual(apply("\uFEFF old \n\uFEFFold\n", "-\uFEFFold\n+\uFEFFnew"), {
    text: "\uFEFF old \n\uFEFFnew\n", matches: [{ line: 2, strategy: "exact" }],
  });
});

test("updates cannot promote content to an encoding BOM", () => {
  assert.throws(() => apply("heading\n\uFEFFpayload\n", "-heading"), /U\+FEFF/);
  assert.throws(() => apply("old\n", "-old\n+\uFEFFnew"), /U\+FEFF/);
  const result = apply("\uFEFFheading\n\uFEFFpayload\n", "-heading");
  assert.equal(result.text, "\uFEFF\uFEFFpayload\n");
  assert.equal(new TextDecoder().decode(Buffer.from(result.text)), "\uFEFFpayload\n");
});

test("terminal-newline preservation deliberately differs from Codex normalization", () => {
  // Reuse fixture 014's patch, but deliberately remove its input's final LF:
  // despite its name, the official no_newline.txt fixture has a terminal LF.
  // The absent-LF expectation below comes from our fidelity requirement.
  assert.equal(apply("no newline at end", "@@\n-no newline at end\n+first line\n+second line").text,
    "first line\nsecond line");
  // Deleting the unterminated tail transfers its terminal state to the retained
  // last line. Its separator is the explicit exception to untouched-EOL fidelity.
  assert.equal(apply("keep\r\ntail", "@@\n-tail").text, "keep");
});

test("pure additions append, including empty files and absent terminal newlines", () => {
  assert.equal(apply("", "@@\n+first\n+second").text, "first\nsecond\n");
  assert.equal(apply("one\r\ntwo", "@@\n+three\n+four").text, "one\r\ntwo\r\nthree\r\nfour");
  assert.equal(apply("one", "@@\n+two\n@@\n+three").text, "one\ntwo\nthree");
  assert.equal(apply("old", "@@\n-old\n+new\n@@\n+tail").text, "new\ntail");
  assert.equal(apply("tail\n\n", "@@\n+new").text, "tail\n\nnew\n");
});

test("anchored pure additions insert after the anchor; EOF explicitly appends", () => {
  // Intentional difference from Codex: an explicit anchor selects the insertion
  // point, rather than merely validating an anchor and then appending anyway.
  const original = "head\r\ntail";
  assert.equal(apply(original, "@@ head\n+middle").text, "head\r\nmiddle\r\ntail");
  assert.equal(apply(original, "@@ head\n+last\n*** End of File").text, "head\r\ntail\r\nlast");
});

test("EOF matches the actual tail and never falls back to an unrelated interior block", () => {
  assert.equal(apply("old\nseparator\nold\n", "@@\n-old\n+new\n*** End of File").text, "old\nseparator\nnew\n");
  assert.throws(() => apply("old\ntail\n", "@@\n-old\n+new\n*** End of File"), /at end of file/);
  assert.throws(() => apply("old\nanchor\n", "@@ anchor\n-old\n+new\n*** End of File"), /at end of file/);
  assert.throws(() => apply("old\n\n", "@@\n-old\n+new\n*** End of File"), /at end of file/);
  assert.equal(apply("old\n\n", "@@\n-old\n+new\n \n*** End of File").text, "new\n\n");
});

test("chunks consume non-overlapping original blocks in source order", () => {
  for (const patch of [
    "@@\n-b\n+B\n@@\n-a\n+A", // reversed
    "@@\n a\n-b\n+B\n@@\n b\n-c\n+C", // overlapping context
    "@@\n-a\n+A\n@@\n-A\n+again", // cannot match newly produced text
    "@@\n+tail\n@@\n-a\n+A", // cannot return to the interior after append
  ]) assert.throws(() => apply("a\nb\nc\n", patch), /Could not find/);
  assert.equal(apply("a\nb\nc\n", "@@\n-a\n+A\n@@\n-b\n+B").text, "A\nB\nc\n");
});

test("bounded corrections do not restrict exact matching on a 150,000-line file", () => {
  const rows = Array.from({ length: 150_000 }, (_, i) => `export const value_${i} = ${i};\n`);
  const original = rows.join("");
  const result = apply(original, "@@\n-export const value_149999 = 149999;\n+export const value_149999 = 0;");
  assert.equal(result.text, original.replace("value_149999 = 149999", "value_149999 = 0"));
  assert.deepEqual(result.matches, [{ line: 150_000, strategy: "exact" }]);
  assert.throws(() => apply(original, "@@\n- export const value_149999 = 149999;\n+changed"), /work budget/);
  // Exact anchoring narrows a large file to a small corrected-match suffix.
  assert.equal(apply(original, "@@ export const value_149998 = 149998;\n- export const value_149999 = 149999;\n+changed").text,
    rows.slice(0, -1).join("") + "changed\n");
});

test("long repeated exact context is linear and does not use argument spreads", () => {
  const original = "repeat\n".repeat(150_000) + "unique end\n";
  const context = " repeat\n".repeat(25_000);
  assert.equal(apply(original, `@@\n${context}-unique end\n+changed`).text,
    "repeat\n".repeat(150_000) + "changed\n");
});

test("retains the existing net-expansion bound for updates", () => {
  assert.throws(() => apply("old\n", "@@\n+" + "x".repeat(8 * 1024 * 1024 + 1)), /expand the file/);
});
