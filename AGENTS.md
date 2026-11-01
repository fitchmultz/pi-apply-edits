# Editing test ownership

- Exercise shipped mutations through `replaceTextInFiles`, `writeFiles`, or `applyPatchToFiles`; do not recreate the retired single-file executor or an upsert adapter for tests.
- Keep text-matching tables in `test/apply-edits.test.ts` and patch grammar/context tables in `test/patch.test.ts`. Filesystem race tests may intercept real syscalls to reach otherwise nondeterministic publication, metadata, and cleanup boundaries.
- Editing functions return error receipts. Assert `details.error` and the verified, failed, and uncertain paths. A fulfilled promise alone does not prove publication.
- Preserve native filesystem, queue, metadata, bounded-work, lifecycle, and transport guards. Platform skips are not successful platform qualification.
- Do not edit source or tests while checks run in that checkout.

## Quality and delivery

Follow [the engineering standard](docs/engineering-standard.md), version 5.1.2.
Use its evidence-based exception process and update its Appendix B records and
`scripts/quality-exceptions.json` when an authorized operation changes.

Use the declared npm version and `npm ci`. Run `npm run check:compat` against
both the declared and latest official Pi hosts and the current Fitch fork.
The aggregate runs independent policy, lint, formatting, compiler, test, and
package gates. Keep failures and platform skips visible.

Keep supported behavior and public contracts intact. Verify the exact combined
revision, address required reviewers, and preserve hosted CI and ownership gates.
See [development](docs/development.md) for commands and [quality coverage](QUALITY.md)
for source ownership and tool limits.
