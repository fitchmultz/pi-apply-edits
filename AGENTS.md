# Editing test ownership

- Exercise shipped mutations through `replaceTextInFiles`, `writeFiles`, or `applyPatchToFiles`; do not recreate the retired single-file executor or an upsert adapter for tests.
- Keep text-matching tables in `test/apply-edits.test.ts` and patch grammar/context tables in `test/patch.test.ts`. Filesystem race tests may intercept real syscalls to reach otherwise nondeterministic publication, metadata and cleanup boundaries.
- Editing functions return error receipts. Assert `details.error` and the verified/failed/uncertain paths; a fulfilled promise alone does not prove publication.
- Preserve native filesystem, queue, metadata, bounded-work, lifecycle and transport guards. Platform skips are not successful platform qualification.
- Run `npm run check:compat` against each supported Pi host. Do not edit source or tests while checks run in that checkout.

## Code quality, maintainability, and verification

Use the repository's npm lockfile, Node runtime, TypeScript configuration,
and verification commands. Preserve compatible verified work and complete
policy integration and resulting source cleanup.

Treat correctness, long-term maintainability, and trustworthy enforcement as
equal objectives. Keep the configured production complexity, size, readonly,
and safety requirements. A finding need not identify an existing runtime bug
to justify a maintainability improvement.

Use authorized semantic exceptions only when their conditions are demonstrated.
Additional relaxations require concrete evidence and explicit approval.

Apply type-aware checks to TypeScript and checked JavaScript. Keep other
maintained JavaScript covered by applicable lint, formatting, and tests.
Verify declaration-qualified allowances with positive and negative
origin-isolation probes. Keep floating-Promise protection strict.

Preserve accurate API contracts and runtime behavior. Resolve unsafe types
with validation, narrowing, and sound type relationships. Use contextual
inference where useful. Keep explicit public contracts and application-owned
readonly data intentional.

Refactor large production functions along real responsibilities. Make state
ownership, async phases, failure behavior, and cleanup clear. Keep internal
APIs private where possible. A single-use helper is useful when it creates a
meaningful boundary. Avoid forwarding layers, arbitrary file splits, giant
shared context objects, and speculative frameworks.

Preserve ordering, cancellation, deletion guards, error identity, retries,
and lifecycle cleanup. Keep cohesive lifecycle tests together. Tests retain
branching and parameter limits but are exempt from size and statement limits.

Correct invalid fixtures while preserving assertions that express intended
behavior. Verify both isolated and suite execution. Review autofixes and the
maintainability of the resulting structure.

Run `npm run lint:agent` for diagnostics, `npm run lint:fix` for ordinary fixes,
and `npm run format` for formatting. Run the actual acceptance workflow,
`npm run check:compat`, on the integrated revision against each supported host.

Report configuration changes, formatting, maintainability improvements,
checker fixes, fixture repairs, and runtime bugs separately. Report commands,
results, coverage, exceptions, and verification limits accurately.

## Dependency maintenance

- Frequently and proactively check releases and make appropriate upgrades across maintained packages and all runtime, development, build, test, and tool dependencies, prioritizing the latest stable official Pi and the intended maintained Pi fork. Routine in-scope maintenance needs no repeated approval; delivery remains subject to existing authority and gates.
- Review crossed release notes, changelogs, migration guidance, and security advisories before upgrading. Verify real APIs and contracts across supported hosts and platforms using each target's exact SDK/CLI and compatible, consistently locked dependency cohort, including host-supplied companions. Preserve lockfile policies, peer contracts, and support floors; a matching version string or locked snapshot alone is not latest-host qualification.
- Adopt beneficial current conventions, patterns, APIs, and functionality instead of extending deprecated or obsolete approaches. Preserve supported behavior and independent use; align affected callers, documentation, generated surfaces, and fixtures through their canonical owners.
- Follow [development rules](docs/development.md) and [quality/checker contracts](QUALITY.md). Run all applicable required lint, format, type, test, build, package, native, CI, and review gates; report exact targets, commands, results, skips, and unverified limits honestly. Documentation checks alone do not qualify runtime behavior. Never weaken safety, checkers, fixture contracts, or supported-target requirements to make an update pass.
- Roll out updates controllably with a rollback path through existing review, approval, and release gates; honor every explicit hold. This authorization is not blanket permission to publish, install into or restart an active runtime, disclose private data, or change global model or authentication settings.
