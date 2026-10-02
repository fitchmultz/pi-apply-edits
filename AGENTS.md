# Editing test ownership

- Exercise shipped mutations through `replaceTextInFiles`, `writeFiles`, or `applyPatchToFiles`; do not recreate the retired single-file executor or an upsert adapter for tests.
- Keep text-matching tables in `test/apply-edits.test.ts` and patch grammar/context tables in `test/patch.test.ts`. Filesystem race tests may intercept real syscalls to reach otherwise nondeterministic publication, metadata and cleanup boundaries.
- Editing functions return error receipts. Assert `details.error` and the verified/failed/uncertain paths; a fulfilled promise alone does not prove publication.
- Preserve native filesystem, queue, metadata, bounded-work, lifecycle and transport guards. Platform skips are not successful platform qualification.
- Run `npm run check:compat` against each supported Pi host. Do not edit source or tests while checks run in that checkout.
