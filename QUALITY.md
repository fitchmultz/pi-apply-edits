# Code quality and maintainability

Oxlint owns code quality; Oxfmt owns supported-file formatting. TypeScript,
behavioral tests, package qualification, and review are separate gates.

## Development and acceptance

Use the declared npm version, Node 24.15 or newer for development, Git, Go
1.26 or newer, and Rust 1.99.0. CI pins Go 1.27.1 and Rust 1.99.0. Go and Rust
build the corrected **development checkers**, not the production extension.

```sh
npm ci
npm run lint:agent
npm run lint:fix
npm run format
npm run check:compat
```

With lifecycle scripts intentionally disabled, run `npm run quality:prepare`
after `npm ci --ignore-scripts`. Preparation builds and installs the pinned
checker corrections reproducibly; lint also prepares them. Do not bypass this
step in editors. The workspace's Oxc extension uses the project-installed
Oxlint/Oxfmt and enables type-aware linting. Disable competing formatters for
these file types. Oxc supplies editor lint diagnostics; the TypeScript language
service supplies compiler diagnostics. The canonical typecheck remains an
independent acceptance gate. A production-only install does not build the checker.
The verified native build caches live outside the repository under
`~/.cache/pi-apply-edits/`; see the [type-aware checker correction](patches/tsgolint/README.md)
and [native import-graph correction](patches/oxlint/README.md).

Isolated host qualification uses a private `HOME`. Put the physical Rust
toolchain's `bin` directory on `PATH` before invoking the qualifier, rather than
passing rustup shims that depend on the original home:

```sh
export PATH="$(rustc --print sysroot)/bin:$PATH"
```

`check:compat` composes suppression/scope policy, strict lint, formatting,
canonical `tsc --noEmit`, the Node test suite (including installed-CLI quality
probes), and `npm pack --dry-run`. The package ships native TypeScript, so there
is no separate transpilation build. The existing qualification workflow runs
this contract against each host, then loads a fresh Git consumer through the
real Pi CLI. Child failures propagate; CI never modifies source with fixes.

## Maintained-code inventory

| Files                                       | Quality owner                  | Semantic/compiler coverage                                                |
| ------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `src/**/*.ts`, `extensions/**/*.ts`         | Oxlint / Oxfmt                 | Type-aware lint, strict TypeScript, behavioral tests                      |
| `scripts/**/*.ts`, handwritten declarations | Oxlint / Oxfmt                 | Type-aware lint, strict TypeScript, policy/CLI probes                     |
| `test/**/*.ts`                              | Oxlint / Oxfmt                 | Type-aware lint, strict TypeScript, Node test/assertion checks            |
| `src/macos-acl.js`                          | Oxlint / Oxfmt                 | Unchecked JXA; applicable non-type-aware rules and real macOS ACL tests   |
| JSON, Markdown, YAML                        | Oxfmt                          | Configuration/provenance checks where applicable                          |
| `test/fixtures/reject-xattr.c`              | Existing C fixture conventions | Compiled and exercised by native Linux metadata tests; unsupported by Oxc |

Unchecked JavaScript is not excluded. Only installed-metadata type-dependent
rules and unexpressible TypeScript-syntax requirements are disabled for its
exact scope. Project membership, inherited `checkJs`, and `@ts-check` determine
semantic checking; probes separately exercise lint and compiler diagnostics,
including checked consumers importing unchecked JavaScript.

There is no generated application source or vendored JavaScript. Dependency
files and the pinned external checker build cache are not maintained source.
`package-lock.json` remains npm-owned, not formatter-owned. Fixture string bytes
retain their behavioral meaning; no fixture expectations are refreshed merely
to satisfy tooling.

## Enforcement and exceptions

Production limits remain complexity 10, depth 3, four parameters, 40 statements,
80 function lines and 500 file lines (excluding comments/blank lines). Tests and
approved test-only helpers retain complexity 15, depth 4, six parameters, but
have no size/statement limits. Handwritten declarations retain type/API checks
without structural metrics.

Application inputs have explicit readonly contracts. Native inputs are allowed
only by verified declaration origin; `Promise` input permission never permits
floating work. Generic containers are not blanket-allowlisted. Public mutable
result types remain compatible: completed receipts transfer ownership to the
caller, while internal read views and lifecycle owners stay explicit.

- Qualified `node:test` registration is framework-owned. `context.test()` and
  ordinary asynchronous work still need handling.
- Native Node/Pi/schema declarations have positive and same-name foreign-origin
  negative probes. The checker correction must pass these probes after a clean
  install; configuration schema acceptance is insufficient.
- Sequential publication, locks, filesystem traversal, and ordered fault
  injection use explained, exact `no-await-in-loop` exceptions. Independent
  observations may run concurrently; dependent persistence does not.
- Retained external positional callbacks/compatibility functions have exact
  boundary-file arity overrides; internal APIs keep the ordinary limit.
- Meaningful positional `undefined`, documented no-ops, fail-closed variant
  assertions, and intentional control validation have only their demonstrated
  narrow handling. No blanket disables, `@ts-ignore`, or `@ts-nocheck` are allowed.
- Comment-aware policy distinguishes real directives from strings and isolated
  checker fixtures. Unused disables fail. Negative compiler suppressions belong
  only in described dedicated type tests.

The root configs, ignore paths, checker patches, suppression/test policy,
package scripts, and CI are owner-reviewed surfaces in `.github/CODEOWNERS`.
Additional relaxations need concrete evidence and explicit approval.

## Responsibility boundaries: before and after

### Patch interpretation

Before: `parsePatch` owned the envelope, header/path offsets, operation dispatch,
chunk grammar, anchors and EOF transitions in one branched function;
`applyPatchUpdate` mixed matching with replacement rendering and expansion state.

After: `PatchParser` owns its cursor and header spans; operation/chunk readers
consume their own grammar. `PatchMatcher` owns immutable original-source matching
and bounded normalization. `PatchUpdater` owns suffix advancement, expansion
accounting and byte/EOL reconstruction. `src/patch.ts` retains the public exports.
A grammar change stays in the parser; a matching change stays in the matcher.

### Editing batches

Before: `registerEditsBatch` combined canonical path discovery, reservations,
planning, alias conflicts, shared subtree preparation, publication, partial
receipts and cleanup. Text matching and diagnostics shared the same large module.

After: `EditingBatch` owns one invocation's lifecycle and expresses its phases;
queue/path resolution, content planning, matching/indentation, bounded diagnostics
and receipts have focused owners under `src/editing/`. The receipt ledger owns
status updates. Every file is still planned before any target is published;
prepared shared roots are discarded on failure, and partial/uncertain outcomes
remain visible rather than being replayed automatically.

### Filesystem publication

Before: `file-system.ts` mixed snapshot/identity checks, platform support and
metadata, create planning, entry moves/deletes, replacement recovery, nested
staging/publication and guarded cleanup.

After: the facade preserves the established API. `src/fs/` separates observation,
snapshots, planning, platform primitives, preparation, replacement, entry moves,
entry deletion, nested staging/publication and owned cleanup. Publication owners
retain their resources and failure state until cleanup finishes. Cancellation,
no-clobber publication, metadata preservation and inode-identity guards remain
independent guarantees, exercised by real syscall/race tests. Private module
loading in tests follows the whole owner graph so platform caches cannot mask
fault injection after decomposition.

These are maintainability improvements, not claims that every removed diagnostic
was a runtime bug. Formatting consistency, checker-integrity corrections, safer
contracts and any independently demonstrated runtime fixes are reported separately.
