# Reproducible type-aware checker corrections

The repository keeps `oxlint-tsgolint` lockfile-pinned at **7.0.2003**. Its current
engine has declaration-identity and readonly-container false negatives. These
patches repair the checker, not application Promise ownership or configured
strictness. No native binaries or upstream source trees are committed.

## Inputs and installation

- tsgolint: [`eb9339115edde6811ca94c3433adf69ea9852880`](https://github.com/oxc-project/tsgolint/tree/eb9339115edde6811ca94c3433adf69ea9852880)
- TypeScript Go submodule: `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`
- Upstream TypeScript patches: ordered `patches/*.patch` at that exact revision
- Bundled TypeScript library correction: `readonly-array-library.patch`, applied
  inside the prepared TypeScript Go submodule before building
- Local patches, in order: `safe-call.patch`, `value-and-readonly.patch`
- Go module inputs: upstream `go.mod`, `go.sum`, `go.work`, `go.work.sum`
- Build: Git and **Go >=1.26**; qualified locally with **Go 1.27.1**, macOS arm64

```sh
npm ci --ignore-scripts
node scripts/prepare-checker.ts
npm run check:compat
```

Ordinary development installs prepare the engine through `postinstall`; the
acceptance workflow also prepares it explicitly, including after ignored install
scripts. Preparation skips only when the development dependency is absent, as in
production-only Git installs. Version, download, patch, build and checksum failures
remain fatal when the development checker is installed.

Preparation follows canonical upstream initialization: fetch the immutable
revision, verify the submodule revision, apply upstream TypeScript patches, copy
its generated collections, and apply local patches. The build uses
`-mod=readonly -modcacherw -buildvcs=false -trimpath -ldflags='-s -w'` and
`CGO_ENABLED=0`. Writable cache directories let isolated qualification homes be
removed normally; dependency manifests and checksums remain readonly inputs.

A cache under `~/.cache/pi-apply-edits/tsgolint/` is keyed by both source revisions,
all patch SHA-256 digests, platform, architecture and Go version. The executable's
stored SHA-256 is verified before reuse. An integrity failure names the exact
cache directory to remove. The installed native package executable is replaced
by a verified same-directory atomic rename only after a successful build.
Therefore **raw Oxlint, lint/fix/agent scripts and editor/LSP invocations use the
same corrected engine** without a special environment variable. Rerun preparation
after reinstalling dependencies; `--help` describes the invocation and exit codes.

## Declaration identity

`safe-call.patch` is reused verbatim from the independently qualified correction
in `pi-subagents` commit `32c2ad92` (parent `4e52582`). It resolves the actual callee
symbol, follows import/re-export aliases, then matches the original declaration
name and qualified source. Instance methods, property/accessor values and
unrelated values with the same callable type do not inherit registration ownership.
File origins are canonicalized using the host filesystem's realpath and case rules.

`node:test`'s `it` alias resolves to `test`, and its `describe` alias resolves to
`suite`. Thus approved canonical declaration names are `test` and `suite`, not
import spellings. `context.test()` is independently owned subtest work and must
still be awaited. The safe-Promise allowlist remains empty.

`value-and-readonly.patch` also repairs the shared value matcher, whose previous
non-package branch ignored file/lib qualification entirely. Type-qualified
allowances and safe calls remain separate checks. Package qualification requires
an actual external-library declaration source; a local ambient module with the
same package spelling cannot confer ownership.

## Readonly integrity

The stock checker rejects even primitive `ReadonlyMap` inputs with
`treatMethodsAsReadonly: false`, but accepts `Readonly<Map<...>>` mutators and
`Readonly<ReadonlyMap<..., MutableValue>>`. The latter are enforcement defects,
not permission to blanket-allow containers or enable methods globally.

The correction recognizes only collection properties declared by actual default
TypeScript library interfaces. `ReadonlyMap` keys and values and `ReadonlySet`
values are checked through instantiated signatures. Mutable `Map`/`Set` mutators
remain mutable even behind mapped `Readonly` wrappers. A readonly mapped view
containing only native `get`, `has`, and `size` capabilities is accepted when its
exposed keys and values are recursively readonly; iterator/callback views of
mutable collections remain conservatively rejected. Plain or `Partial` views of
mutable collection methods still require an explicit readonly projection.
Ordinary mapped methods use the checker's actual readonly-symbol semantics,
not synthetic/mapped flags or missing declarations as automatic permission.
Partial `ReadonlyMap` and `ReadonlySet` views audit each actual exposure independently: iterators, entry
pairs, callbacks (including their collection receiver), and set-algebra results
cannot hide mutable stored data by omitting `get` or `has`. Fresh iterator entry
pairs may be mutable, but their stored keys and values must be recursively
readonly; a stored mutable tuple still fails. Size-only views expose no stored
data. Unknown future native exposure channels are conservatively rejected until
their instantiated signatures have an explicit analysis. Additional application
properties are checked normally; same-named local/package types do not receive
native handling. Optional methods are normalized before examining signatures.
Set subset/disjoint predicates also expose stored elements to the other set's
`has` callback; the superset predicate only reads the other set's keys.
Readonly arrays retain element/tuple checks and also audit consumer-added members;
derived and partial views check their actual native method channels. Instantiated
symbols and their mappers are followed through generated checker shims, whose
inputs are maintained in `shim/checker/extra-shim.json` and regenerated canonically.
Intersections are checked constituent by constituent **before**
any native allowance, so `Theme & { counter: number }` fails while the readonly
attached-state form passes. Ordinary unions retain constituent checking.

Qualified native allowances exempt only members owned by the approved declaration
and its original native inheritance contract. Application declarations merged
into lib handles or package classes/interfaces are audited separately, including
inherited additions and index signatures. Mutable additions and readonly fields
containing mutable values fail; readonly application additions pass without
rejecting legitimate library merges. This covers global `URL`, module-augmented
`Theme`/`TSchema`, and Node `Stats`, while preserving their original APIs.
Qualified aliases resolve their own declaration symbol and origin; native SDK
aliases retain only their original API, not foreign augmentations.

This is acceptance of specific native collection contracts, not freezing,
method purity, or universal immutability. `no-param-reassign` independently
protects parameter properties. Generic containers remain outside the allowlist;
`treatMethodsAsReadonly: false` and `ignoreInferredTypes: true` are unchanged.
Plain `() => T` callbacks already pass this release; mutable attached callable
state still fails, so no obsolete generic-callback suppression is added.

### Bundled readonly array callback contract

The pinned TypeScript Go bundle declares `ReadonlyArray.flatMap`'s callback
receiver as mutable `T[]`, although it receives the original array at runtime.
`readonly-array-library.patch` changes only that third argument to `readonly T[]`;
the corresponding `Array.flatMap` signature remains mutable. This prevents a
readonly input from exposing a mutating callback channel while retaining ordinary
readonly array operations and legitimate mutable-array callbacks.

The patch applies to `internal/bundled/libs/lib.es2019.array.d.ts` after upstream
preparation (prepared revision `db8b2fb437bb33ce5dca5d3ce128300c8f63763f`).
That external declaration is embedded directly by `go:embed`; the normal build
does not regenerate it. Its generator consumes the separately pinned TypeScript
source `4d4f005c8541e0255a9d8791205fdce326e462bc`. Regenerating that external bundle
requires the equivalent source correction or reapplication of this patch before
building. The library patch's SHA-256 participates in the checker cache identity.

Installed-CLI probes require TS2339 for mutation through the readonly callback
receiver and retain a mutable-array positive. Native editor/LSP linting rejects
the unavailable mutator through `no-unsafe-call`; compiler diagnostics remain a
separate language-service boundary. The independent npm TypeScript
compiler and its declarations are not modified; this correction belongs only to
the reproducibly built development checker.

## Qualification and removal

Run the installed native CLI through `test/quality-allowances.test.ts`, including
rule IDs and locations: approved declarations, same-name local/file/package
values, shadows, wrong existing paths, aliases/re-exports, ordinary asynchronous
work and unawaited subtests. Readonly probes cover native origins, primitives,
mutable containers, nested values, mapped wrappers, attached state, and callbacks.
The isolated probe sources remain unsuppressed so upgrades can expose stale fixes.

Replace these patches only after a compatible upstream release passes those
same positive and negative probes following clean installation. A newer version,
accepted schema, or successful positive example alone is insufficient evidence.
