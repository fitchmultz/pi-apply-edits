# Engineering-standard qualification

## Revision and status

The adoption starts from `e988520` and targets standard 5.1.2. The implementation
is an adoption candidate until the integrated acceptance command and required
hosted reviews and compatibility checks pass. The delivery PR records its exact
head and hosted run identities.

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

The faults cover native lint, semantic lint, each compiler project, formatting,
a real failed Node assertion, and omitted maintained-source policy. Native
exception ablation removes the actual QX-002 and QX-003 site directives and
checks the original arity and conditional-assertion findings. Formatting
qualification verifies two stable formatter runs and the normal lint-fix then
format sequence against unchanged source bytes.

## Retained and lost detection

The standard intentionally turns off universal readonly-parameter classification
and strict synchronous void returns. Accurate readonly contracts, direct
parameter-mutation checks, private readonly members, unsafe-flow checks,
floating work, and async-callback checks remain active.

Stock native cycle detection is qualified for the static and type-only cases
above. The custom patched dynamic and external cycle detection is retired and is
not claimed as stock behavior. No replacement semantic engine is introduced.
Appendix B records QX-001 through QX-004 and their exact remaining limits.
