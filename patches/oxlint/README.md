# Native Oxlint import-cycle correction

## Provenance and scope

`import-cycles.patch` applies to Oxlint **1.87.0**, Oxc revision
[`2bd08ebe8f36fcf1954a675ffdeb4c6d0129f609`](https://github.com/oxc-project/oxc/tree/2bd08ebe8f36fcf1954a675ffdeb4c6d0129f609).
The npm lockfile remains authoritative for the JavaScript wrapper and native binding
package. Upgrade the pin, patch, and qualification together; preparation rejects a
different wrapper version.

The upstream rule did not collect dynamic imports and unconditionally excluded
`node_modules` despite accepting `ignoreExternal: false`. This patch:

- collects decoded string literals and expression-free template literals in a
  separate dynamic-request map, without changing static ESM import/export entries;
- resolves static and literal-dynamic requests with the existing native resolver;
- traverses eligible occurrences for `import/no-cycle`, honors `ignoreTypes` and
  `ignoreExternal`, and reports the eligible occurrence's source span;
- treats `allowUnsafeDynamicCyclicDependency: true` as static-only traversal, so a
  dynamic occurrence cannot hide an independently complete static cycle;
- preserves named self-reexports, self-import detection, root-cycle detection and
  `maxDepth`, and keeps `oxc/no-barrel-file` traversal static-only.

Runtime-computed import specifiers are not statically resolvable. This correction
makes no claim to detect those edges, CommonJS/AMD cycles, or unresolved modules.
Other import rules still consume the original static declaration records.

The patch includes native `NoCycle` regressions and small physical external-package
fixtures and a static-barrel regression. Existing upstream expectations are retained.
The repository's quality probes provide the installed-CLI and editor integration
boundary.

## Reproducible installation

```sh
npm ci --ignore-scripts
npm run quality:prepare
# Native correction alone, including help:
node scripts/prepare-oxlint.ts
node scripts/prepare-oxlint.ts --help
```

Preparation needs Git, Rust **>=1.97** (qualified with **1.99.0**), Cargo, and `cc`.
Rust's native host target must match Node's platform/architecture. macOS arm64 is
locally qualified; other platform mappings are not evidence of qualification.
When using an isolated HOME, put a working physical Rust toolchain's `bin` on PATH
first; a rustup shim with no default toolchain is not a usable Rust installation.

The script fetches and verifies the exact revision, checks and applies the patch,
then uses the upstream NAPI library build:

```sh
cargo build --locked --release -p oxlint --lib --features allocator
```

It verifies that `Cargo.lock` is unchanged. The outside-repository cache lives under
`~/.cache/pi-apply-edits/oxlint/<fingerprint>/`. Its key includes the source revision,
patch bytes, preparation-script bytes, Node platform/architecture, Rust host target,
Rust/Cargo versions, and C-compiler version. Build/profile flags and compiler wrappers
are cleared rather than silently changing the corrected build. The cached addon is
SHA-256 verified before use. A checksum mismatch fails closed; remove the named cache
directory and rerun preparation to rebuild.

The completely built and checked addon is copied to a temporary file in the actual
`@oxlint/binding-*` package directory, verified, and atomically renamed over the
installed addon. Both the raw npm CLI and `oxlint --lsp` load that NAPI addon. A
standalone Rust executable would **not** correct the npm CLI or editor server. No
extra lint flags or runtime environment overrides are needed. Restart already
running language servers after preparing or reinstalling dependencies.

LSP qualification uses physical workspace/file URIs. Aliased workspace paths (for
example, `/tmp` versus `/private/tmp` on macOS) can miss cycles when the upstream
root path differs from resolved dependency paths; this patch does not change path
canonicalization.

If the development `oxlint` dependency is absent, native preparation skips; version,
prerequisite, download, patch, build, and checksum errors otherwise fail. The composed
`prepare-checker.ts` then performs the existing immutable Go-checker preparation.
Its `-modcacherw` flag only permits cleanup of downloaded modules in isolated homes;
`-mod=readonly`, source pins, patches, checksums and atomic installation are retained.

## Updating or removing the correction

Retire the patch only after an upstream version passes the installed native matrix:
static/type cycles, mixed occurrences of the same specifier, pure/transitive dynamic
cycles with both unsafe-dynamic settings, decoded literals/templates, self imports
and named self-reexports, physical external packages with both external settings,
and bounded depth. Also verify unchanged duplicate-import, empty-export and barrel
rules, type-aware Go diagnostics, JavaScript plugin diagnostics, and editor/LSP
publication. Schema acceptance alone does not establish these semantics.
