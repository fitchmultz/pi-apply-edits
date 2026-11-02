# Quality coverage

[The engineering standard](docs/engineering-standard.md), version 5.1.2, owns the
lint, compiler, formatting, exception, and verification requirements. Appendix B
records this repository's mappings and decisions.

## Acceptance

Use Node 24.15 or newer, Git, and the npm version in `package.json` for development.
The extension's runtime floor is Node 24.0. The published Oxlint, oxlint-tsgolint,
and Oxfmt packages run directly from the locked dependency tree.

```sh
npm ci
npm run lint:agent
npm run lint:fix
npm run format
npm run check:compat
```

`npm run check:compat` runs these independent gates through `scripts/check.ts`:

| Gate                               | Owner                               |
| ---------------------------------- | ----------------------------------- |
| Policy and coverage                | `scripts/check-policy.ts`           |
| Full semantic lint                 | `oxlint --deny-warnings .`          |
| Supported-file formatting          | `oxfmt --check .`                   |
| Main compiler project              | `tsc --noEmit`                      |
| JXA and declaration project        | `tsc --noEmit -p tsconfig.jxa.json` |
| Behavior and installed-tool probes | `node --test test/*.test.ts`        |
| Distribution inventory             | `npm pack --dry-run`                |

Every gate runs even when an earlier independent gate fails. Any failed gate
makes the aggregate fail. The package uses native TypeScript, with no separate
transpilation build or generated application source.

CI runs the contract on the declared official Pi cohort and the latest official
release on macOS, and the current Fitch fork on Linux. The host qualifier also
loads a fresh Git consumer through the real Pi CLI. Local results do not replace
these hosted checks.

## Maintained files

| Files                               | Lint and formatting                                        | Compiler and behavior                                                    |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `extensions/**/*.ts`, `src/**/*.ts` | Oxlint and Oxfmt, production profile                       | `tsconfig.json`, runtime tests                                           |
| `scripts/**/*.ts`                   | Oxlint and Oxfmt, production profile                       | `tsconfig.json`, policy and CLI probes                                   |
| `test/**/*.ts`                      | Oxlint and Oxfmt, test profile                             | `tsconfig.json`, Node assertion checks and tests                         |
| `src/macos-acl.js`                  | Semantic Oxlint and Oxfmt, production profile, JXA globals | `tsconfig.jxa.json` with `allowJs` and `checkJs`, native macOS ACL tests |
| `src/macos-acl-runtime.d.ts`        | Applicable Oxlint and Oxfmt, declaration profile           | `tsconfig.jxa.json` with `skipLibCheck: false`                           |
| JSON, Markdown, and YAML            | Oxfmt                                                      | Config validation where applicable                                       |
| `package-lock.json`                 | npm                                                        | Clean locked installation                                                |
| `test/fixtures/reject-xattr.c`      | Established C fixture style                                | Compiled by native Linux metadata tests                                  |

The policy gate inventories existing tracked and untracked files that Git does
not ignore. It resolves compiler settings and imported-file membership through
TypeScript, checks every maintained JavaScript and TypeScript file, and rejects
literal relative production imports or re-exports of test-only support. New unassigned source
fails coverage. Handwritten declarations must belong to a project that actually
checks declarations. JXA runs under `osascript`, so its compiler project uses
script detection, ES2024 libraries, and narrow native bridge declarations.

Root quality settings are compared with the adopted standard and the explicit
mappings in `scripts/quality-config.ts`. Additional nested configs, ignore files,
compiler projects, and reduced acceptance commands require an explicit mapping
change. `package-lock.json` has npm ownership. There are no generated or vendored
JavaScript or TypeScript files to exempt from maintained-source checks.

## Ownership and exceptions

Editing and filesystem implementations borrow caller data through readonly
views. Public named requests, plans, hooks, and receipts retain their mutable
contracts, including explicit `undefined` in optional fields. Prepared operations
retain the caller's original references. Result adapters detach mutable SDK
receipts from internal results and from each other.

The standard's production and test structural profiles apply without a finding
budget. The bounded exceptions are:

- `QX-001`: the declaration-qualified `nodeTest` registration allowance. Use
  `import { test as nodeTest } from "node:test"` for registrations and context
  methods for subtests. Context subtests and ordinary asynchronous work still
  require ownership.
- `QX-002`: the two public five-parameter compatibility functions and three
  five-parameter Pi `execute` callbacks, enumerated by operation.
- `QX-003`: enumerated exhaustive variant assertions. Optional branches do not
  qualify merely because another assertion executes first.
- `QX-004`: the `run` entrypoint in `src/macos-acl.js`, invoked by `osascript`.
  Other names and files retain unused-symbol checks.

Appendix B contains the comparisons, evidence, and remaining protection.
`scripts/quality-exceptions.json` binds each directive to its file, rule, ID,
enclosing operation, and duplication bound. Native unused-disable checks remain
active. Strings and documentation examples are not directives. Described negative
compiler expectations belong only in dedicated type tests.

## Tool limits

Published native checks provide their documented guarantees, not universal
immutability or effect analysis. The readonly-parameter rule is off under the
standard, while readonly views, private-member checks, and direct parameter
mutation checks remain. Stock `import/no-cycle` is qualified for the static and
type-only cycles exercised by the probes. The retired custom dynamic and external
cycle detection is not claimed as stock behavior.

The registration allowance matches declaration origin and local import name,
not the runtime calling context. Calling imported `nodeTest` inside a running
test can create a subtest without a floating-Promise finding. Use the test
context's methods there. The assertion plugin uses conservative native scope and
code-path facts. It does not prove arbitrary getters, repeated calls, or effects
stable. Save a discriminator before asserting and branching on it.

The Oxc editor extension uses the workspace's installed tools. Keep its
project-aware linting enabled and use the TypeScript language service for
compiler diagnostics. Acceptance remains the full command above.
