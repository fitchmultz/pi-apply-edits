# Review

## Verdict
The implementation is not acceptable as-is for v0.2.0. The insert feature mostly works, but multi-file batches are only plan-first, not atomic, and path aliases can deadlock the batch lock acquisition. The public atomicity claim is not honest when a later publish fails because earlier files remain committed.

## Findings
1. **Severity: high** - Multi-file commit is sequential and non-transactional, despite being advertised as atomic. `src/apply-edits.ts:300-318` plans all content, then calls `commitPlannedMutation` one file at a time; its own comment at line 305 admits that a mid-publish failure leaves earlier files written. Publish-only checks such as setuid/setgid and hard-link rejection occur later in `src/file-system.ts:84-94`, so even deterministic, knowable failures are not preflighted. A focused probe with a normal first file and hard-linked second file returned "after 1 successful write" and left the first file changed. This contradicts `extensions/apply-edits.ts:80-85,145-156` and `CHANGELOG.md:6`, which call the batch atomic. `test/apply-edits.test.ts:909-930` proves only all-or-nothing planning, not all-or-nothing publication. The feature should be named a plan-first or preflighted batch unless a real transaction and recovery protocol is implemented.
2. **Severity: high** - Canonical path aliases can deadlock batch locking. Duplicate detection and sort order use textual resolved paths in `src/apply-edits.ts:282-299`, while `withOrderedFileLocks` nests Pi mutation-queue locks at `src/apply-edits.ts:339-344`. Pi 0.82 canonicalizes existing queue paths through `realpath`, so a real path and a symlink alias pass this code's duplicate check but map to the same queue key; the inner acquisition waits forever for the outer acquisition to release. A focused real-path-plus-symlink batch probe timed out after one second instead of completing or rejecting. Different alias orderings can also invert canonical lock order across concurrent batches. Canonicalize, deduplicate, and sort by the exact same key used by the queue before acquiring any lock, then add alias and concurrent-overlap tests.
3. **Severity: medium** - `insert` with `all: true` can apply overlapping normalized anchors despite the schema promising only non-overlapping matches. `toReplacement` collapses an insertion's matched anchor span to a zero-length point (`src/apply-edits.ts:542-551`), so `hasOverlaps` at `src/apply-edits.ts:741-744` cannot see overlap between the normalized windows generated at `src/apply-edits.ts:596-615`. A probe against three normalized `a` lines with a two-line anchor inserted twice, once for windows 1-2 and again for 2-3. This violates `extensions/apply-edits.ts:22-25`. Preserve the anchor span separately and perform overlap checks on that span.

## Verified
- Read all requested implementation, extension, tests, README, changelog, and package metadata at commit `4f88aaf` / tag `v0.2.0`.
- Exact-first matching, ambiguity rejection, ordered in-memory edits, bounded fuzzy matching/diagnostics, and replacement overlap detection are coherent and well tested.
- Basic `insert: "before" | "after"`, insert validation, repeated exact anchors with `all`, line-ending conversion, and BOM handling work in the covered cases.
- Single-file existing-file publication has strong safeguards: stable snapshots, same-directory replacement, recovery links, metadata cloning, pre-rename rechecks, post-rename verification, and fail-closed handling for unsafe target types. The documented final rename race is accurately acknowledged.
- Relative, absolute, tilde, and file-URL path behavior is explicit and tested, including literal/transformed ambiguity.
- Tool argument repair is narrow, conflicting aliases are rejected, structured diffs are bounded, and built-in tool activation behavior matches the README.
- Fresh `npm run check` passed: typecheck, 55 tests, and package dry-run; one Linux capability test was skipped on macOS.

## Risks
- Per-file replacement still has the documented non-CAS final rename window in which an external replacement can win or be overwritten (`README.md:111-116`).
- Linux metadata/capability behavior was not exercised on this macOS host; the Linux capability test was skipped.
- I did not inject ENOSPC, I/O, or directory-sync faults. The deterministic hard-link probe nevertheless proves the same partial-batch control flow.

## Recommended Next Step
- Before release, remove the atomic wording unless true transactional semantics are added, canonicalize batch lock keys to eliminate alias deadlocks, and fix insert overlap detection. Add focused regression tests for later publish failure, real-path/symlink duplicates, concurrent alias lock order, and normalized overlapping inserts.
