# Review — pi-apply-edits v0.2.0 (4f88aaf)

Full-codebase adversarial review. `tsc --noEmit` clean; `node --test` 55 pass / 1 skipped (Linux capability test on macOS). Reproduction scripts and test log in `/tmp/repro-batch-symlink.mjs`, `/tmp/repro-batch-case.mjs`, `/tmp/pi-apply-edits-tests.log`.

## Verdict

Not acceptable as-is. The new multi-file batch feature has a reproduced permanent deadlock when two batch entries alias the same file through a symlink or through case-variant paths on macOS's default case-insensitive filesystem. The tool call hangs forever with no error, no writes, and no timeout, which blocks the agent turn. Everything else, including the single-file path, the atomic publish machinery, and the insert feature, is in good shape with one medium idempotence gap.

## Findings

1. **Severity: critical** — Multi-file batch deadlocks forever when two entries resolve to the same real file. `applyEditsBatch` dedups on string equality of `resolveInputPath` results (src/apply-edits.ts:283-295), but `withFileMutationQueue` keys its lock on `realpath` (pi-coding-agent `file-mutation-queue.js`). `withOrderedFileLocks` (src/apply-edits.ts:339-345) then acquires locks *nested*, so two distinct input strings mapping to one realpath key make the inner acquisition wait on the outer's own release. Reproduced two ways, both hang indefinitely with zero output:
   - symlink alias + target in one batch (`alias.txt` → `a.txt`), `/tmp/repro-batch-symlink.mjs`;
   - case-variant paths on default APFS (`a.txt` + `A.TXT`, no symlink), `/tmp/repro-batch-case.mjs` — a realistic model mistake.
   Symlinked directory components (`src/x.ts` vs `lib/x.ts` where `src → lib`) hit the same hole. Fix: dedup batch entries on the same key the queue uses (realpath with ENOENT fallback to the resolved path), or flatten lock acquisition so a repeated key errors instead of nesting.

2. **Severity: medium** — `insert` is not idempotent and has no already-applied detection. src/apply-edits.ts:214 filters no-op replacements via `current.slice(start, end) !== text`; for zero-width inserts the slice is always `""`, so the filter never fires. A retried insert (after an uncertain-commit error, a batch partial failure, or a plain model retry) silently duplicates the inserted text. Replace mode has two protections ("already produces the requested text", src/apply-edits.ts:214-220, and "replacement text already appears at line N" in `missingEditMessage`); insert has neither. A cheap guard: error when the text adjacent to the anchor already equals `newText`.

3. **Severity: medium** — The "atomic" batch label overpromises relative to the real guarantee. Actual behavior is atomic *planning* plus sequential best-effort writes: on a mid-publish FS failure, earlier files stay committed and their per-file recovery links have already been unlinked, so no rollback is possible. The tool description ("apply an atomic multi-file batch", extensions/apply-edits.ts:151), schema description ("Atomic multi-file batch", extensions/apply-edits.ts:82), and CHANGELOG ("Atomic multi-file batches") all lead with "atomic"; the qualification lives in fine print ("planned atomically before any write", README; ponytail comment src/apply-edits.ts:305) and in the failure message ("after N successful writes", src/apply-edits.ts:311-316). Reword to "all-or-nothing planning" or equivalent so a model does not assume write atomicity.

4. **Severity: low** — Under `insert` + `all`, overlapping normalized anchor windows both fire. Zero-width replacements never trip `hasOverlaps` (start < prev.end is impossible for zero-width ranges), so fuzzy matches that would be rejected as overlapping for replace each insert text (e.g., `oldText: "a\na"` with `all: true` against three drifted `a ` lines inserts twice). Contrived but silently surprising.

5. **Severity: low** — In files mode, `prepareApplyEditsArguments` rejects top-level `path`/`edits`/`rewrite`/`content`/`onMissing` alongside `files` (extensions/apply-edits.ts:107-116) but silently ignores stray top-level `old_string`/`new_string`/`all`/`insert`, which single-file mode would have repaired or rejected. Minor consistency gap in the alias-repair contract.

6. **Severity: low** — `insert` with an indent-normalized match keeps the caller's text verbatim (no reindent, src/apply-edits.ts:610-613). Reasonable choice, documented only as a code comment; README's matching section does not mention it.

## Honesty of the multi-file atomicity claim

Qualified-honest, with two caveats. The documented guarantee ("planned atomically before any write; nothing is written unless every file can be planned") matches the code: all snapshots and mutations are computed before any publish, and a plan-phase failure writes nothing (verified by test "multi-file batch writes nothing when a later file cannot be planned"). A mid-publish FS failure leaves earlier files written with no rollback, but the error message honestly discloses the count of successful writes. The caveats: (a) the headline word "atomic" in the tool/schema/CHANGELOG text implies write atomicity that does not exist (finding 3); (b) the per-file `assertSnapshotCurrent` recheck at commit means a file changed between plan and its commit fails that file mid-batch, again leaving earlier writes — safe per file, partial per batch, same disclosure path.

## Verified

- Single-file flow: plan → `withFileMutationQueue` → publish is unchanged and correct; no nesting, no deadlock exposure.
- `insert` semantics: zero-width replacement placement (`toReplacement`, src/apply-edits.ts:542-551), empty-`newText` rejection (src/apply-edits.ts:186-188), `oldText === newText` allowed only for insert, line-ending conversion of inserted text, `all` support, and works through exact/normalized/indent-normalized matching. Tests cover before/after/all/empty.
- Batch: per-entry validation with indexed errors, duplicate detection (string-level), sorted lock order (no lock-order deadlock between concurrent batches), plan-then-write, no-change summary, and batch details/diff rendering in the TUI. Tests cover success, plan-failure rollback, and duplicate rejection.
- Atomic publish machinery (src/file-system.ts): metadata-preserving clone with verification, setuid/setgid/hardlink/capability refusals, snapshot-stability double-stat reads, recovery-link protocol with no-rollback conflict policy, cleanup paths, and create via hardlink with exclusive-write fallback. The hook-based failure-injection tests exercise the uncertain-commit windows well.
- Path resolution: literal-vs-transformed ambiguity, `~`, `file://`, Unicode-space and `@`-prefix literalness — all tested.
- Matching budgets: fuzzy/diagnostic work limits, 10k replacement cap, bounded diff generation, 64 MB heap diagnostic test.
- Tool contract alignment: schema, description, promptGuidelines, README ladder, and CHANGELOG all describe insert and files; extension tests assert the contract text. Built-in hide/keep logic and opt-outs tested.
- `npm run typecheck` exit 0; full test suite exit 0 (55/56, 1 platform skip).

## Risks

- Batch behavior under concurrent external writers is only as strong as per-file `assertSnapshotCurrent`; a batch can partially commit whenever any later file races (disclosed in the error, but no test covers a mid-batch commit-phase failure specifically — the batch tests only exercise plan-phase failure).
- No Windows or Linux run of this suite was performed here; platform-specific publish paths (getcap, `/bin/cp`) verified by reading only.
- Deadlock repros used symlink and case-folding; other aliasing (bind mounts, NFC/NFD Unicode normalization on APFS) likely behaves the same and was not individually tested.

## Recommended Next Step

- Fix finding 1 before shipping v0.2.0: dedup and lock batch paths on the realpath-based queue key, and add regression tests for the symlink-alias and case-variant batch cases (the two repro scripts in /tmp convert directly into tests). Then address the insert idempotence guard (finding 2) and soften the "atomic" wording (finding 3).
