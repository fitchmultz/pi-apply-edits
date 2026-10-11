# Development

pi-apply-edits is distributed through Git/GitHub only. Publishing to npm is unsupported.

Use Node 24.15 or later for the pinned npm 12 development toolchain. The extension's
runtime floor remains Node 24.0. Development checker preparation also requires
Git, Go 1.26 or later, and Rust 1.99.0; production installs do not build checkers.

```sh
npm ci --ignore-scripts
npm run check:compat
```

The package uses public Pi and TypeBox peer APIs, with jsdiff as its only direct
runtime dependency. `check:compat` runs policy and installed-checker probes,
strict type-aware Oxlint, Oxfmt checking, canonical TypeScript checking,
tests, and a pack dry-run
against the installed host; its official development cohort is Pi 1.0.0 and
TypeBox 1.3.34. The suite includes real Pi loader/policy/settlement, native nested
receipts, and journal reload/restore checks with scripted responses and no model
calls. Both 1.0 targets use the public same-file queue; batch reservations,
prospective aliases, and publication/recovery safeguards remain package-owned.
Fitch Pi no longer provides checkpoint or mutation-key APIs. CI qualifies the declared
official Pi version on macOS/Node 24 and `fitchmultz/pi@main` on Linux/Node 24;
both lanes verify a fresh Git consumer through the real Pi CLI. Linux metadata
fault tests require `attr`, `acl`, and a C compiler.
Temporary directories must allow the current user to set the tested permission
bits (on macOS, a directory inherited from `/tmp` may need its group set to the
current user's primary group before creating fixtures).

See [Code quality and maintainability](../QUALITY.md) for coverage, narrow semantic
exceptions, editor setup, and the production responsibility boundaries.
