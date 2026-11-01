# Engineering-standard qualification

## Revision and status

The adoption starts from `e988520` and targets standard 5.1.2. Local qualification
passed for implementation commit `9a3179de77ac1bd302c878a08bd50b0410a6c201`, tree
`8119620f6365a1f39c1584fde4b8ff9ab9d4dffc`. The macOS mirror's independently
written Git tree matches this tree. Required hosted acceptance and independent
reviews remain merge requirements. The delivery PR records their exact head and
run identities.

The supplied guide's original SHA-256 is
`41b6d505b36007218ca56b7b3443fcbd96d994715da5a83aaca52b58af47d3d6`.
The repository copy has Oxfmt formatting and Appendix B records. Source changes,
not this digest, establish effective enforcement.

## Tool and host identity

The published registry resolved these versions on 1 November 2026:

| Tool            | Version  |
| --------------- | -------- |
| Oxlint          | 1.90.0   |
| oxlint-tsgolint | 7.0.2005 |
| Oxfmt           | 0.75.0   |
| oxc-parser      | 0.156.0  |
| TypeScript      | 7.0.2    |

Local macOS qualification uses Node 24.22.1 and the declared npm 12.2.0 against
the locked official Pi 1.0.0 and TypeBox 1.3.34 cohort. Hosted qualification
resolves each target independently. At adoption, latest official Pi resolves to
1.4.0 and the Fitch fork to `0a0e06fb18ba206866d4051870c8f5cb420c9be9`.
These resolved values do not substitute for executing the selected host.

## Recorded local results

Commands use the declared npm 12.2.0. All commands below exited zero except the
intentional faults described under disposable qualification.

| Environment and command                      | Result                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| macOS, clean `npm ci`                        | Passed                                                                     |
| macOS, `npm run check:compat`                | All seven gates passed; 620 tests passed, zero failed, nine platform skips |
| Android, clean `npm ci`                      | Passed                                                                     |
| Android, eleven runtime suites               | 301 tests passed, zero failed, 51 platform skips                           |
| macOS, two formatter runs                    | Source bytes unchanged after each run                                      |
| macOS, native lint fix followed by formatter | Both passed; source bytes unchanged                                        |

The Android command selects the shipped runtime and filesystem boundaries, not
the unsupported Android-native quality binaries:

```sh
node --test test/apply-edits.test.ts test/editor.test.ts test/entry-queue.test.ts \
  test/extension.test.ts test/file-system.test.ts test/native-paths.test.ts \
  test/patch.test.ts test/restore.test.ts test/runtime.test.ts \
  test/transport.test.ts test/macos-acl.test.ts
```

Both installations report three advisories in the retained development SDK
graph. They also report blocked dependency lifecycle scripts under npm's native
policy. These notices are not hidden by the acceptance runner.

## Normal acceptance controls

`npm run check:compat` runs policy, full native lint, formatting, the main
compiler, the JXA compiler and declarations, all Node tests, and pack inspection.
The source inventory includes existing tracked and untracked maintained files.
A physically deleted tracked file is not treated as existing source.

| Contract                                                                                                                           | Normal regression owner                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Actual composed production, test, and JXA scopes                                                                                   | `test/quality-rules.test.ts`                           |
| Native Node plugin and static or type-only cycles                                                                                  | `test/quality-rules.test.ts`                           |
| Meaningful valid and invalid rule options, unsafe propagation, async ownership, unknown forwarding, and invalid rejections         | `test/quality-rules.test.ts`                           |
| All six registration controls and typed shadows                                                                                    | `test/quality-allowances.test.ts`                      |
| Both semantic and canonical project contexts, handwritten declarations, strict minima, and imported membership                     | `test/quality-scope.test.ts`                           |
| Six production boundaries, IIFEs, long tests, and retained test limits                                                             | `test/quality-metrics.test.ts`                         |
| Wrong file or operation, equal-count unauthorized replacement, duplication, stale records, unused directives, and literal examples | `test/quality-policy.test.ts`                          |
| Assertion ownership and exhaustive exception eligibility                                                                           | `test/quality-flow.test.ts`                            |
| Representative explicit, category, semantic, structural, composition, formatter, and command downgrades                            | `test/quality-integrity.test.ts`                       |
| Public mutable and readonly consumer contracts, including explicit undefined                                                       | `test/file-system.test-d.ts` and canonical compilation |
| Real accepted and rejected ACL worker requests and CLI behavior                                                                    | `test/macos-acl.test.ts`                               |
| Real filesystem, cancellation, metadata, queue, loader, journal, and provider transport behavior                                   | The remaining runtime and filesystem suites            |

The composed category control uses installed metadata, not a guessed default.
`eslint/no-new` is suspicious, default-disabled, and absent from the explicit
rule list. Discarding a newly constructed Error also exposes the category-enabled
`oxc/missing-throw` diagnostic. The tests assert both identities. Test scope also
retains the explicit floating-Promise and configured assertion findings.

## macOS bridge evidence

The bridge declarations describe the APIs actually used by the standalone JXA
script. They contain no `any` and do not replace the Node or Pi dependency
closure. The JXA project checks the handwritten declarations with
`skipLibCheck: false`; the main project excludes those runtime-only globals.

The installed macOS SDK supplies the C and Objective-C contracts:

- `usr/include/sys/acl.h:142-145` declares opaque ACL and reference types.
  Lines 152-203 declare the bound allocation, entry, flag, copy, validation,
  and free functions.
- Foundation `NSData.h:141,594` declares byte length and mutable append.
- Foundation `NSString.h:93,679,990` declares UTF-8 encoding and conversions.
- Foundation `NSFileHandle.h:132,136,351` declares the standard handles and the
  existing synchronous write method used by the script.

Real `/usr/bin/osascript -l JavaScript` observations establish bridge
representation, which the C headers alone cannot establish:

```json
{
  "pointer": "function",
  "reference": "function",
  "initialReference": "undefined",
  "length": "string",
  "encoding": "string",
  "decoded": "string",
  "arrayAt": "b"
}
```

The script therefore models an out-reference as a pointer or undefined and
narrows its value after a successful C call. The compiler rejects passing an
unwritten reference directly to the native pointer parameter. Foundation byte
length and encoding bridge values are strings, and decoded NSString data unwraps
to a JavaScript string. Native ACL, inheritance-depth, cancellation, helper-exit,
and protocol tests exercise the declarations through the real bridge.

The intentional behavior change validates worker request fields before transfer
and rejects missing CLI paths explicitly. The valid mode and path contract,
legacy non-inherit CLI copy behavior, error forwarding, ACL ordering, and cleanup
remain covered by real process and filesystem tests.

## Disposable qualification

Acceptance wiring uses isolated source copies, the installed published tools,
real compiler projects, and the actual `npm run check:compat` command. Each fault
must produce its intended diagnostic, fail the aggregate, and still reach every
independent gate. These mutations are qualification inputs, not shipped source.

All seven independent fault runs exited one and reached all seven gates. Each
failed only the intended gate; all other gates passed.

| Fault                                                        | Intended finding and failed gate                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Numeric loose equality                                       | `eslint(eqeqeq)` at `src/guide-control.ts:2:15`; lint                                  |
| Assign parsed JSON directly to a string                      | `typescript(no-unsafe-assignment)` at `src/guide-control.ts:1:14`; lint                |
| Assign string to numeric export                              | TS2322 at `src/guide-control.ts:1:14`; main compiler                                   |
| Incorrect pointer-return JSDoc                               | TS2322 at `src/macos-acl.js:30:3`, with TS2345 at both pointer consumers; JXA compiler |
| Unformatted numeric export                                   | Oxfmt identifies `src/guide-control.ts`; formatter                                     |
| `assert.equal(1, 2, "guide acceptance assertion must fail")` | Native Node assertion failure; test                                                    |
| Maintained root `unassigned.js` outside compiler projects    | Missing checked-project ownership at line 1; policy                                    |

Native exception ablation removes the actual QX-002 and QX-003 site directives.
It exits one with exactly five original arity and 23 original conditional-assertion
diagnostics. No other native diagnostic is accepted. Formatting qualification
checks two stable formatter runs and the normal lint-fix then format sequence
against the source's Git index, with zero diff each time.

Full logs, the source-copy qualification runner, and its JSON report are retained
with the task evidence at `~/workspaces/pa-evidence/` in the authoring environment.
The normal regression owners above remain part of repository acceptance.

## Retained and lost detection

The standard intentionally turns off universal readonly-parameter classification
and strict synchronous void returns. Accurate readonly contracts, direct
parameter-mutation checks, private readonly members, unsafe-flow checks,
floating work, and async-callback checks remain active.

Stock native cycle detection is qualified for the static and type-only cases
above. The custom patched dynamic and external cycle detection is retired and is
not claimed as stock behavior. No replacement semantic engine is introduced.
Appendix B records QX-001 through QX-004 and their exact remaining limits.
