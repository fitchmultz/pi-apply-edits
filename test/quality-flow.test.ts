import test from "node:test";
import { expectDiagnostics, frameworkConfig, inProbe, lint } from "./quality-probe-support.ts";

const missing = "node-test(expect-assertions)";
const conditional = "node-test(no-conditional-assertions)";
const cases = [
  {
    name: "alias replacement and pop cannot forge saved producer visibility",
    body: 'const verify = () => assert.rejects(Promise.resolve()); test("empty", async () => { const assertion = verify(); const observed = assertion.catch((error: unknown) => { console.log(error); }); const tasks = [assertion]; const alias = tasks; alias[0] = Promise.resolve(); const removed = alias.pop(); console.log(removed); await Promise.all(tasks); await observed; });',
    expected: [[missing, 3]],
  },
  {
    name: "mutating an array cannot forge singleton any visibility",
    body: 'test("empty", async () => { const assertion = assert.rejects(Promise.resolve()); const tasks = [assertion]; tasks.push(Promise.resolve()); await Promise.any(tasks); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "removing an array producer cannot forge all visibility",
    body: 'const verify = () => assert.rejects(Promise.resolve()); test("empty", async () => { const assertion = verify(); const observed = assertion.catch((error: unknown) => { console.log(error); }); const tasks = [assertion]; tasks.length = 0; await Promise.all(tasks); await observed; });',
    expected: [[missing, 3]],
  },
  {
    name: "same named generic return is not the native Promise",
    body: 'function invoke<Promise>(run: () => Promise): Promise { return run(); } test("asserted", () => { const result = invoke(() => { assert.equal(process.argv.length > 0, true); return { value: 1 }; }); console.log(result); });',
    expected: [],
  },
  {
    name: "concise Promise return owns conditional handler",
    body: 'const pending = () => Promise.resolve(); test("payload", async () => { assert.equal(process.argv.length > 0, true); await pending().then(() => { if (process.env.NO_SUCH_REVIEW_FLAG === "yes") { assert.fail("must run"); } }); });',
    expected: [[conditional, 3]],
  },
  {
    name: "concise assertion return cannot launder saved catch",
    body: 'const verify = () => assert.rejects(Promise.resolve()); test("empty", async () => { const assertion = verify(); await assertion.catch((error: unknown) => { console.log(error); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "concise assertion return retains visible saved await",
    body: 'const verify = () => assert.rejects(Promise.reject(new Error("expected"))); test("asserted", async () => { const assertion = verify(); await assertion; });',
    expected: [],
  },
  {
    name: "saved native array cannot launder aggregate catch",
    body: 'test("empty", async () => { const tasks = [assert.rejects(Promise.resolve())]; await Promise.all(tasks).catch((error: unknown) => { console.log(error); }); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "saved native array retains visible aggregate assertions",
    body: 'test("asserted", async () => { const assertion = assert.rejects(Promise.reject(new Error("expected"))); const tasks = [assertion]; await Promise.all(tasks); });',
    expected: [],
  },
  {
    name: "readonly array aliases retain native aggregate visibility",
    body: 'test("asserted", async () => { const tasks = [assert.rejects(Promise.reject(new Error("expected")))] as const; const alias = tasks; await Promise.all(alias); });',
    expected: [],
  },
  {
    name: "native allSettled cannot hide inline failed assertion",
    body: 'test("empty", async () => { await Promise.allSettled([assert.rejects(Promise.resolve())]); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "native allSettled cannot hide saved array assertion",
    body: 'test("empty", async () => { const tasks = [assert.rejects(Promise.resolve())] as const; const alias = tasks; await Promise.allSettled(alias); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "settled outcomes need an independent visible assertion",
    body: 'test("asserted", async () => { const outcomes = await Promise.allSettled([Promise.reject(new Error("expected"))]); assert.equal(outcomes.at(0)?.status, "rejected"); });',
    expected: [],
  },
  {
    name: "settling cannot swallow synchronous assertion argument",
    body: 'function verify(): number { assert.equal(process.argv.length > 0, true); return process.argv.length; } test("asserted", async () => { await Promise.allSettled([Promise.resolve(verify())]); });',
    expected: [],
  },
  {
    name: "generic saved synchronous callback retains immediate ownership",
    body: 'function invoke<T>(run: () => T): T { return run(); } test("asserted", () => { const result = invoke(() => { assert.equal(process.argv.length > 0, true); return 1; }); console.log(result); });',
    expected: [],
  },
  {
    name: "readonly object saved callback retains immediate ownership",
    body: 'function invoke(run: () => { readonly value: number }): { readonly value: number } { return run(); } test("asserted", () => { const result = invoke(() => { assert.equal(process.argv.length > 0, true); return { value: 1 }; }); console.log(result); });',
    expected: [],
  },
  {
    name: "generic saved async callback cannot launder catch",
    body: 'function invoke<T>(run: () => T): T { return run(); } test("empty", async () => { const result = invoke(() => assert.rejects(Promise.resolve())); await result.catch((error: unknown) => { console.log(error); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "generic saved async callback retains visible await",
    body: 'function invoke<T>(run: () => T): T { return run(); } test("asserted", async () => { const result = invoke(() => assert.rejects(Promise.reject(new Error("expected")))); await result; });',
    expected: [],
  },
  {
    name: "generic stored callback cannot credit swallowed async failure",
    body: 'async function invoke<T>(run: () => T): Promise<{ readonly result: T }> { const result = run(); await Promise.resolve(result).catch((error: unknown) => { console.log(error); }); return { result }; } test("empty", async () => { await invoke(() => assert.rejects(Promise.resolve())); });',
    expected: [[missing, 3]],
  },
  {
    name: "native any cannot credit one ignored failed assertion",
    body: 'test("empty", async () => { await Promise.any([assert.rejects(Promise.resolve()), Promise.resolve()]); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "native race cannot credit one ignored failed assertion",
    body: 'test("empty", async () => { await Promise.race([assert.rejects(Promise.resolve()), Promise.resolve()]); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "single native any input retains failure visibility",
    body: 'test("asserted", async () => { const tasks = [assert.rejects(Promise.reject(new Error("expected")))]; await Promise.any(tasks); });',
    expected: [],
  },
  {
    name: "single native race input retains failure visibility",
    body: 'test("asserted", async () => { const tasks = [assert.rejects(Promise.reject(new Error("expected")))]; await Promise.race(tasks); });',
    expected: [],
  },
  {
    name: "repeated calls do not prove a stable discriminator",
    body: 'let reads = 0; function next(): number { return ++reads; } test("optional", () => { assert.equal(next(), 1); if (next() === 1) { assert.fail("payload was skipped"); } });',
    expected: [["node-test(no-conditional-assertions)", 3]],
  },
  {
    name: "accessors do not prove a stable discriminator",
    body: 'let reads = 0; const value = { get kind(): number { return ++reads; } }; test("optional", () => { assert.equal(value.kind, 1); if (value.kind === 1) { assert.fail("payload was skipped"); } });',
    expected: [["node-test(no-conditional-assertions)", 3]],
  },
  {
    name: "assertion arguments cannot mutate a proven discriminator",
    body: 'let value = 1; function message(): string { value = 2; return "discriminator"; } test("optional", () => { assert.equal(value, 1, message()); if (value === 1) { assert.fail("payload was skipped"); } });',
    expected: [["node-test(no-conditional-assertions)", 3]],
  },
  {
    name: "captured values retain fail-closed discriminator proof",
    body: 'let reads = 0; function next(): number { return ++reads; } test("asserted", () => { const value = next(); assert.equal(value, 1); if (value === 1) { assert.equal(reads, 1); } });',
    expected: [],
  },
  {
    name: "saved synchronous wrapper assertions remain immediate",
    body: 'function invoke(run: () => void): void { return run(); } test("asserted", () => { const result = invoke(() => { assert.equal(process.argv.length > 0, true); }); console.log(result); });',
    expected: [],
  },
  {
    name: "saved transitive Promise returning helper cannot swallow rejection",
    body: 'function verify() { return assert.rejects(Promise.resolve()); } function invoke() { return verify(); } test("empty", async () => { const verification = invoke(); await verification.catch(() => {}); });',
    expected: [[missing, 3]],
  },
  {
    name: "inferred Promise returning helper owns conditional handler",
    body: 'function pending() { return Promise.resolve(); } test("payload", async () => { assert.equal(process.argv.length > 0, true); await pending().then(() => { if (process.env.MAYBE !== undefined) { assert.fail("unchecked payload"); } }); });',
    expected: [[conditional, 3]],
  },
  {
    name: "saved inferred Promise returning helper cannot swallow rejection",
    body: 'function verify() { return assert.rejects(Promise.resolve()); } test("empty", async () => { const verification = verify(); await verification.catch(() => {}); });',
    expected: [[missing, 3]],
  },
  {
    name: "saved synchronous helper assertions remain immediate",
    body: 'function verify(): number { assert.equal(process.argv.length > 0, true); return process.argv.length; } test("asserted", () => { const result = verify(); console.log(result); });',
    expected: [],
  },
  {
    name: "saved fail closed handler retains declaration scope",
    body: 'test("asserted", async () => { const rethrow = (error: unknown): never => { throw error; }; const assertion = assert.rejects(Promise.reject(new Error("expected"))).catch(rethrow); { const rethrow = (): void => {}; console.log(rethrow); await assertion; } });',
    expected: [],
  },
  {
    name: "native second then handler cannot skip payload",
    body: 'test("payload", async () => { assert.equal(process.argv.length > 0, true); await Promise.resolve().then(undefined, () => { if (process.env.MAYBE !== undefined) { assert.fail("unchecked payload"); } }); });',
    expected: [[conditional, 3]],
  },
  {
    name: "native handler preserves fail closed narrowing",
    body: 'test("payload", async () => { assert.equal(process.argv.length > 0, true); await Promise.resolve().then(() => { const mode = process.env.MODE; assert.equal(mode, "message"); if (mode === "message") { assert.equal(process.env.PAYLOAD, "expected"); } }); });',
    expected: [],
  },
  {
    name: "saved native assertions visibly awaited together",
    body: 'test("asserted", async () => { const assertion = assert.rejects(Promise.reject(new Error("expected"))); await Promise.all([assertion]); });',
    expected: [],
  },
  {
    name: "saved assertion wrappers cannot launder swallowed rejection",
    body: 'test("empty", async () => { const assertion = assert.rejects(Promise.resolve()) as Promise<void>; const alias = assertion; const handled = alias.then(undefined, () => {}); await handled; });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "saved assertion consumption catch cannot swallow rejection",
    body: 'test("empty", async () => { const assertion = assert.rejects(Promise.resolve()); try { await assertion; } catch { console.log("hidden"); } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "saved assertion consumption finally cannot swallow rejection",
    body: 'test("empty", async () => { const assertion = assert.rejects(Promise.resolve()); try { await assertion; } finally { return; } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "saved native assertion visibly returned",
    body: 'test("asserted", () => { const assertion = assert.rejects(Promise.reject(new Error("expected"))); return assertion; });',
    expected: [],
  },
  {
    name: "saved local helper visibly awaited",
    body: 'async function verify(): Promise<void> { await Promise.resolve(); assert.equal(process.argv.length > 0, true); } test("asserted", async () => { const verification = verify(); await verification; });',
    expected: [],
  },
  {
    name: "saved wrapper callback visibly awaited",
    body: 'async function invoke(run: () => Promise<void>): Promise<void> { const result = run(); await result; } test("asserted", async () => { await invoke(async () => { await Promise.resolve(); assert.equal(process.argv.length > 0, true); }); });',
    expected: [],
  },
  {
    name: "native handler callback does not independently prove parent assertions",
    body: 'test("empty", async () => { await Promise.resolve().then(() => { assert.equal(process.argv.length > 0, true); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "shadowed Promise cannot own dormant then callback",
    body: 'const Promise = { resolve: () => ({ then: (_run: () => void): void => {} }) }; test("payload", () => { assert.equal(process.argv.length > 0, true); Promise.resolve().then(() => { if (process.env.MAYBE !== undefined) { assert.fail("dormant"); } }); });',
    expected: [],
  },
  {
    name: "saved native then callback identity survives lexical shadow",
    body: 'const pending = Promise.resolve(); test("payload", async () => { const Promise = { resolve: (): number => 1 }; assert.equal(Promise.resolve(), 1); await pending.then(() => { if (process.env.MAYBE !== undefined) { assert.fail("unchecked payload"); } }); });',
    expected: [[conditional, 3]],
  },
  {
    name: "native then callback cannot skip payload after parent assertion",
    body: 'test("payload", async () => { assert.equal(process.argv.length > 0, true); await Promise.resolve().then(() => { if (process.env.MAYBE !== undefined) { assert.fail("unchecked payload"); } }); });',
    expected: [[conditional, 3]],
  },
  {
    name: "native catch callback cannot skip payload after parent assertion",
    body: 'test("payload", async () => { assert.equal(process.argv.length > 0, true); await Promise.resolve().catch(() => { if (process.env.MAYBE !== undefined) { assert.fail("unchecked payload"); } }); });',
    expected: [[conditional, 3]],
  },
  {
    name: "native finally callback cannot skip payload after parent assertion",
    body: 'test("payload", async () => { assert.equal(process.argv.length > 0, true); await Promise.resolve().finally(() => { if (process.env.MAYBE !== undefined) { assert.fail("unchecked payload"); } }); });',
    expected: [[conditional, 3]],
  },
  {
    name: "native handler reaches named local helper",
    body: 'function verify(): void { if (process.env.MAYBE !== undefined) { assert.fail("unchecked payload"); } } test("payload", async () => { const callback = verify as () => void; assert.equal(process.argv.length > 0, true); await Promise.resolve().then(callback); });',
    expected: [[conditional, 3]],
  },
  {
    name: "native handler reaches child registration",
    body: 'test("parent", async (context) => { assert.equal(process.argv.length > 0, true); await Promise.resolve().then(async () => { await context.test("child", () => { if (process.env.MAYBE !== undefined) { assert.fail("unchecked payload"); } }); }); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "foreign then callbacks stay dormant",
    body: 'const foreign = { then: (_run: () => void): void => {} }; test("payload", () => { assert.equal(process.argv.length > 0, true); foreign.then(() => { if (process.env.MAYBE !== undefined) { assert.fail("dormant"); } }); });',
    expected: [],
  },
  {
    name: "saved native assertion cannot launder swallowed rejection",
    body: 'test("empty", async () => { const assertion = assert.rejects(Promise.resolve()); await assertion.catch((error: unknown) => { console.log(error); }); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "saved local helper cannot launder swallowed rejection",
    body: 'async function verify(): Promise<void> { await Promise.resolve(); assert.fail("hidden"); } test("empty", async () => { const verification = verify(); await verification.catch((error: unknown) => { console.log(error); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "saved wrapper callback cannot launder swallowed rejection",
    body: 'async function invoke(run: () => Promise<void>): Promise<void> { const result = run(); await result.catch((error: unknown) => { console.log(error); }); } test("empty", async () => { await invoke(async () => { await Promise.resolve(); assert.fail("hidden"); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "saved native assertion visibly awaited through alias",
    body: 'test("asserted", async () => { const assertion = assert.rejects(Promise.reject(new Error("expected"))); const alias = assertion; await alias; });',
    expected: [],
  },
  {
    name: "saved assertion fail closed handler",
    body: 'test("asserted", async () => { const assertion = assert.rejects(Promise.reject(new Error("expected"))); await assertion.catch((error: unknown) => { throw error; }); });',
    expected: [],
  },
  {
    name: "conditional saved assertion consumption cannot own passing path",
    body: 'test("empty", async () => { const assertion = assert.rejects(Promise.reject(new Error("expected"))); if (process.env.MAYBE !== undefined) { await assertion; } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "finally return swallows rethrown assertion failure",
    body: 'test("empty", () => { try { assert.equal(1, 2); } catch (error) { console.log(error); throw error; } finally { return; } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "nonempty native literal entries iterator",
    body: 'test("table", () => { for (const [index, value] of [1, 1].entries()) { assert.equal(value, 1); assert.equal(index >= 0, true); } });',
    expected: [],
  },
  {
    name: "empty native literal entries iterator",
    body: 'test("table", () => { for (const [index, value] of [].entries()) { assert.equal(value, 1); console.log(index); } });',
    expected: [[missing, 3]],
  },
  {
    name: "awaited nonempty native parallel assertions",
    body: 'test("parallel", async () => { await Promise.all([1, 2].map(async (value) => { await Promise.resolve(); assert.equal(value > 0, true); })); });',
    expected: [],
  },
  {
    name: "empty native parallel assertions",
    body: 'test("parallel", async () => { await Promise.all([].map(async (value) => { await Promise.resolve(); assert.equal(value, 1); })); });',
    expected: [[missing, 3]],
  },
  {
    name: "unawaited parallel assertions cannot own parent",
    body: 'test("parallel", () => { Promise.all([1].map(async (value) => { await Promise.resolve(); assert.equal(value, 1); })); });',
    expected: [[missing, 3]],
  },
  {
    name: "swallowed parallel assertion failures",
    body: 'test("parallel", async () => { await Promise.all([1].map(async (value) => { await Promise.resolve(); assert.equal(value, 1); })).catch((error: unknown) => { console.log(error); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "shadowed Promise cannot own callbacks",
    body: 'const Promise = { all: async (_values: readonly unknown[]): Promise<void> => { console.log("not awaited"); } }; test("parallel", async () => { await Promise.all([1].map((value) => { assert.equal(value, 1); })); });',
    expected: [[missing, 3]],
  },
  {
    name: "nonempty native parallel optional callback",
    body: 'test("parallel", async () => { await Promise.all([1].map(async (value) => { await Promise.resolve(); if (process.env.MAYBE !== undefined) { assert.equal(value, 1); } })); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "success-only handler preserves assertion failures",
    body: 'test("asserted", async () => { await assert.rejects(Promise.reject(new Error("expected"))).then(() => { console.log("success"); }); });',
    expected: [],
  },
  {
    name: "second handler swallows assertion failures",
    body: 'test("empty", async () => { await assert.rejects(Promise.resolve()).then(undefined, (error: unknown) => { console.log(error); }); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "conditionally rethrowing handler still swallows",
    body: 'test("empty", async () => { await assert.rejects(Promise.resolve()).catch((error: unknown) => { if (process.env.MAYBE !== undefined) { throw error; } }); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "destructured native child method alias",
    body: 'test("parent", async (context) => { const { test: child } = context; await child("child", () => { assert.equal(1, 1); }); });',
    expected: [],
  },
  {
    name: "promise rejection handler swallows assertion failure",
    body: 'test("empty", async () => { await assert.rejects(Promise.resolve()).catch((error: unknown) => { console.log(error); }); });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "promise rejection handler fails closed",
    body: 'test("asserted", async () => { await assert.rejects(Promise.reject(new Error("expected"))).catch((error: unknown) => { console.log(error); throw error; }); });',
    expected: [],
  },
  {
    name: "logged catch unconditionally rethrows",
    body: 'test("asserted", () => { try { assert.equal(1, 1); } catch (error) { console.log(error); throw error; } });',
    expected: [],
  },
  {
    name: "nonlexical helper optional payload",
    body: 'function verify(): void { assert.equal(1, 1); if (process.env.MAYBE !== undefined) { assert.equal(process.env.MAYBE, "expected"); } } test("helper", () => { verify(); });',
    expected: [[conditional, 3]],
  },
  {
    name: "loose equality cannot prove strict guard",
    body: 'import loose from "node:assert"; test("optional", () => { const value = process.env.VALUE ?? 1; loose.equal(value, 1); if (value === 1) { assert.equal(process.env.PAYLOAD, "expected"); } });',
    expected: [[conditional, 3]],
  },
  {
    name: "strict equality proves strict guard",
    body: 'import loose from "node:assert"; test("asserted", () => { const value = process.env.VALUE ?? 1; loose.strictEqual(value, 1); if (value === 1) { assert.equal(process.env.PAYLOAD, "expected"); } });',
    expected: [],
  },
  {
    name: "nonempty literal helper table",
    body: 'function verify(value: number): void { assert.equal(value, 1); } test("table", () => { for (const value of [1, 1]) { verify(value); } });',
    expected: [],
  },
  {
    name: "empty literal helper table",
    body: 'function verify(value: number): void { assert.equal(value, 1); } test("table", () => { for (const value of []) { verify(value); } });',
    expected: [[missing, 3]],
  },
  {
    name: "optional helper in nonempty table",
    body: 'function verify(value: number): void { assert.equal(value, 1); } test("table", () => { for (const value of [1, 1]) { if (process.env.MAYBE !== undefined) { verify(value); } } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "assertion-free native child",
    body: 'test("parent", async (context) => { assert.equal(1, 1); await context.test("child", () => { console.log("empty"); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "awaited asserting native child owns parent assertions",
    body: 'test("parent", async (context) => { await context.test("child", () => { assert.equal(1, 1); }); });',
    expected: [],
  },
  {
    name: "aliased native child method",
    body: 'test("parent", async (context) => { const child = context.test; await child("child", () => { assert.equal(1, 1); }); });',
    expected: [],
  },
  {
    name: "destructured native context",
    body: 'test("parent", async ({ test: child }) => { await child("child", () => { assert.equal(1, 1); }); });',
    expected: [],
  },
  {
    name: "awaited native child table",
    body: 'test("parent", async (context) => { for (const value of [1, 1]) { await context.test("child", () => { assert.equal(value, 1); }); } });',
    expected: [],
  },
  {
    name: "same-named foreign assertion helper",
    body: 'import { expectDiagnostics } from "./foreign.ts"; test("empty", () => { expectDiagnostics(); });',
    expected: [[missing, 3]],
  },
  {
    name: "entry assertion survives loop back-edges",
    body: 'test("loop", () => { assert.equal(process.argv.length > 0, true); for (const value of process.argv) { console.log(value); } });',
    expected: [],
  },
  {
    name: "cohesive asynchronous lifecycle with owned cleanup",
    body: 'test("lifecycle", async () => { let state = "pending"; let closed = false; try { await Promise.resolve(); state = "running"; assert.equal(state, "running"); } finally { closed = true; } assert.equal(closed, true); });',
    expected: [],
  },
  {
    name: "early passing return",
    body: 'test("empty", () => { if (process.env.SKIP !== undefined) { return; } assert.equal(1, 1); });',
    expected: [[missing, 3]],
  },
  {
    name: "zero-iteration loop",
    body: 'test("empty", () => { for (const value of process.argv.slice(99)) { assert.equal(value, "expected"); } });',
    expected: [[missing, 3]],
  },
  {
    name: "catch-only assertion",
    body: 'test("empty", () => { try { console.log("can succeed"); } catch { assert.equal(1, 1); } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "swallowed assertion",
    body: 'test("empty", () => { try { assert.equal(1, 2); } catch { console.log("hidden failure"); } });',
    expected: [
      [missing, 3],
      [conditional, 3],
    ],
  },
  {
    name: "helper early return",
    body: 'function verify(): void { if (process.env.SKIP !== undefined) { return; } assert.equal(1, 1); } test("empty", () => { verify(); });',
    expected: [[missing, 3]],
  },
  {
    name: "named callback",
    body: 'function body(): void { console.log("empty"); } test("empty", body);',
    expected: [[missing, 3]],
  },
  {
    name: "namespace it",
    body: 'import * as runner from "node:test"; runner.it("empty", () => { console.log("empty"); });',
    expected: [[missing, 3]],
  },
  {
    name: "assertion method properties are not assertions",
    body: 'test("empty", () => { assert.equal.toString(); });',
    expected: [[missing, 3]],
  },
  {
    name: "unrelated test property",
    body: "const api = { test: (run: () => number): number => run() }; api.test(() => 42);",
    expected: [],
  },
  {
    name: "named asserting callback",
    body: 'function body(): void { assert.equal(1, 1); } test("asserted", body);',
    expected: [],
  },
  {
    name: "constant callback alias",
    body: 'const body = (): void => { assert.equal(1, 1); }; const alias = body; test("asserted", alias);',
    expected: [],
  },
  {
    name: "helper assertion ownership",
    body: 'function verify(): void { assert.equal(1, 1); } test("asserted", () => { verify(); });',
    expected: [],
  },
  {
    name: "dormant nested function",
    body: 'test("empty", () => { function dormant(): void { assert.equal(1, 1); } console.log(dormant); });',
    expected: [[missing, 3]],
  },
  {
    name: "all passing branches assert",
    body: 'test("branches", () => { if (process.env.MODE === "left") { assert.equal(1, 1); } else { assert.equal(2, 2); } });',
    expected: [
      [conditional, 3],
      [conditional, 3],
    ],
  },
  {
    name: "explicit native test skip",
    body: 'test("platform", (context) => { if (process.platform !== "darwin") { context.skip("Requires macOS"); return; } assert.equal(1, 1); });',
    expected: [],
  },
  {
    name: "unrelated skip method",
    body: 'test("empty", () => { const context = { skip: (why: string): void => { console.log(why); } }; context.skip("not native"); });',
    expected: [[missing, 3]],
  },
  {
    name: "local callback wrapper",
    body: 'function run(body: () => void): void { body(); } test("wrapped", () => { run(() => { assert.equal(1, 1); }); });',
    expected: [],
  },
  {
    name: "optional local callback wrapper",
    body: 'function run(body: () => void): void { if (process.env.SKIP === undefined) { body(); } } test("wrapped", () => { run(() => { assert.equal(1, 1); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "unconfigured foreign wrapper",
    body: 'import { inProbe } from "./foreign.ts"; test("wrapped", () => { inProbe({}, () => { assert.equal(1, 1); }); });',
    expected: [[missing, 3]],
  },
  {
    name: "reassigned callback cannot retain assertion ownership",
    body: 'let body = (): void => { assert.equal(1, 1); }; body = (): void => { console.log("empty"); }; test("empty", body);',
    expected: [[missing, 3]],
  },
  {
    name: "cyclic callback references fail closed",
    body: 'const first = second; const second = first; test("empty", first);',
    expected: [[missing, 3]],
  },
] satisfies readonly {
  readonly name: string;
  readonly body: string;
  readonly expected: readonly (readonly [string, number])[];
}[];

for (const probe of cases) {
  test(`native scope/code-path assertion ownership: ${probe.name}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": frameworkConfig(),
        "test/probe.test.ts": `import test from "node:test";\nimport assert from "node:assert/strict";\n${probe.body}`,
        "test/foreign.ts":
          "export function inProbe(_files: unknown, _run: () => void): void {} export function expectDiagnostics(): void {}",
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["test/probe.test.ts"]),
          probe.expected,
          "test/probe.test.ts",
        );
      },
    );
  });
}

const exceptionCases = [
  {
    name: "native handler cannot suppress optional payload",
    body: 'test("payload", async () => { assert.equal(process.argv.length > 0, true); await Promise.resolve().finally(() => { if (process.env.MAYBE !== undefined) {\n// Exhaustive variants supposedly validate every optional payload.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.fail("unchecked payload");\n} }); });',
    expected: [["node-test(valid-exceptions)", 6]],
  },
  {
    name: "exhaustive throwing assertions with nested callbacks",
    body: 'function operation(reason: string): never { throw new Error(reason); } test("variants", () => { if (process.env.MODE === "left") {\n// Exhaustive variants validate each operation refusal through a native throwing assertion.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.throws(() => operation("left"), /left/);\n} else {\n// Exhaustive variants validate each operation refusal through a native throwing assertion.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.throws(() => operation("right"), /right/);\n} });',
    expected: [],
  },
  {
    name: "optional loop cannot hide behind exhaustive arms",
    body: 'test("variants", () => { assert.equal(1, 1); for (const item of process.argv.slice(99)) { if (item === "x") {\n// Exhaustive variants validate both branches for their matching payloads.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(item, "x");\n} else {\n// Exhaustive variants validate both branches for their matching payloads.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(item, "y");\n} } });',
    expected: [
      ["node-test(valid-exceptions)", 6],
      ["node-test(valid-exceptions)", 10],
    ],
  },
  {
    name: "nonempty table exhaustive arms",
    body: 'test("variants", () => { for (const item of ["x", "y"]) { if (item === "x") {\n// Exhaustive variants validate both branches for their matching payloads.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(item, "x");\n} else {\n// Exhaustive variants validate both branches for their matching payloads.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(item, "y");\n} } });',
    expected: [],
  },
  {
    name: "exhaustive switch variants",
    body: 'test("variants", () => { switch (process.env.MODE) { case "left":\n// Exhaustive variants validate this distinct payload before leaving its arm.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(1, 1); break;\ndefault:\n// Exhaustive variants validate the fallback payload before leaving its arm.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(2, 2); break;\n} });',
    expected: [],
  },
  {
    name: "optional assertion with generic explanation",
    body: 'test("optional", () => { assert.equal(1, 1); if (process.env.MAYBE !== undefined) {\n// Exhaustive platform variants need this assertion boundary for their native contracts.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(2, 2);\n} });',
    expected: [["node-test(valid-exceptions)", 6]],
  },
  {
    name: "exhaustive arms",
    body: 'test("variants", () => { if (process.env.MODE === "left") {\n// Exhaustive variants validate both payloads and cannot skip their assertions.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(1, 1);\n} else {\n// Exhaustive variants validate both payloads and cannot skip their assertions.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(2, 2);\n} });',
    expected: [],
  },
  {
    name: "unconditional assertion does not make empty variant exhaustive",
    body: 'test("variants", () => { assert.equal(1, 1); if (process.env.MODE === "left") {\n// Exhaustive variants supposedly validate every payload without optional branches.\n// oxlint-disable-next-line node-test/no-conditional-assertions\nassert.equal(2, 2);\n} else { console.log("unchecked payload"); } });',
    expected: [["node-test(valid-exceptions)", 6]],
  },
] satisfies readonly {
  readonly name: string;
  readonly body: string;
  readonly expected: readonly (readonly [string, number])[];
}[];

const originCases = [
  {
    path: "test/probe.test.ts",
    imported: "./quality-probe-support.ts",
    name: "expectDiagnostics",
    invocation: "expectDiagnostics();",
    expected: [],
  },
  {
    path: "test/nested/probe.test.ts",
    imported: "../quality-probe-support.ts",
    name: "expectDiagnostics",
    invocation: "expectDiagnostics();",
    expected: [],
  },
  {
    path: "test/nested/probe.test.ts",
    imported: "./quality-probe-support.ts",
    name: "expectDiagnostics",
    invocation: "expectDiagnostics();",
    expected: [[missing, 3, 1]],
  },
  {
    path: "test/probe.test.ts",
    imported: "./quality-probe-support.ts",
    name: "inProbe",
    invocation: "await inProbe({}, async () => { assert.equal(1, 1); });",
    expected: [],
  },
  {
    path: "test/nested/probe.test.ts",
    imported: "./quality-probe-support.ts",
    name: "inProbe",
    invocation: "await inProbe({}, async () => { assert.equal(1, 1); });",
    expected: [[missing, 3, 1]],
  },
  {
    path: "test/probe.test.ts",
    imported: "./racing.ts",
    name: "withRacingEditing",
    invocation: "await withRacingEditing(() => {}, async () => { assert.equal(1, 1); });",
    expected: [],
  },
  {
    path: "test/probe.test.ts",
    imported: "./racing.ts",
    name: "withRacingFileSystem",
    invocation: "await withRacingFileSystem(() => {}, async () => { assert.equal(1, 1); });",
    expected: [],
  },
  {
    path: "test/nested/probe.test.ts",
    imported: "./racing.ts",
    name: "withRacingEditing",
    invocation: "await withRacingEditing(() => {}, async () => { assert.equal(1, 1); });",
    expected: [[missing, 3, 1]],
  },
] satisfies readonly {
  readonly path: string;
  readonly imported: string;
  readonly name: string;
  readonly invocation: string;
  readonly expected: readonly (readonly [string, number, number?])[];
}[];
for (const [index, probe] of originCases.entries()) {
  test(`configured declarations retain canonical origin isolation ${index}`, async () => {
    const support =
      'import assert from "node:assert/strict"; export function expectDiagnostics(): void { assert.equal(1, 1); } export async function inProbe(_files: unknown, run: () => Promise<void>): Promise<void> { await run(); }';
    const foreign =
      'export function expectDiagnostics(): void { console.log("no assertions"); } export async function inProbe(_files: unknown, _run: () => Promise<void>): Promise<void> { console.log("not invoked"); }';
    const racing =
      "export async function withRacingEditing(_patch: () => void, run: () => Promise<void>): Promise<void> { await run(); } export async function withRacingFileSystem(_patch: () => void, run: () => Promise<void>): Promise<void> { await run(); }";
    await inProbe(
      {
        ".oxlintrc.json": frameworkConfig(),
        "test/quality-probe-support.ts": support,
        "test/nested/quality-probe-support.ts": foreign,
        "test/racing.ts": racing,
        "test/nested/racing.ts": racing.replaceAll("await run();", "console.log(run);"),
        [probe.path]: `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { ${probe.name} } from "${probe.imported}"; test("ownership", async () => { ${probe.invocation} });`,
      },
      async (directory) => {
        expectDiagnostics(lint(directory, [probe.path]), probe.expected, probe.path);
      },
    );
  });
}

for (const probe of exceptionCases) {
  test(`conditional exception proof: ${probe.name}`, async () => {
    await inProbe(
      {
        ".oxlintrc.json": frameworkConfig(),
        "test/probe.test.ts": `import test from "node:test";\nimport assert from "node:assert/strict";\n${probe.body}`,
      },
      async (directory) => {
        expectDiagnostics(
          lint(directory, ["test/probe.test.ts"]),
          probe.expected,
          "test/probe.test.ts",
        );
      },
    );
  });
}
