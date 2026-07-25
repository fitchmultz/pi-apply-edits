# Changelog

## 0.2.12 — 2026-07-24

- Align tracked package-lock root version and license metadata with the published package.

## 0.2.11 — 2026-07-24

- Prebuild every nested-create staging tree before any batch target publication, so deterministic staging failures leave all targets unchanged.
- Reject targeted edits that would move or add U+FEFF at the content start instead of silently deleting unrelated text.
- Stage beside the verified ancestor when possible so cleanup survives ancestor rename/replacement.

## 0.2.10 — 2026-07-24

- Coalesce sibling creates sharing a missing root into one staged subtree publication, preventing the first create from invalidating later precomputed plans.

## 0.2.9 — 2026-07-24

- Stage complete missing directory trees under the verified ancestor and publish them with one rename, preventing parent-symlink swaps from redirecting nested creates or leaking temporary links.

## 0.2.8 — 2026-07-24

- Preserve leading U+FEFF in targeted-edit anchors so internal U+FEFF content is matched and replaced at the requested boundary.

## 0.2.7 — 2026-07-24

- Symmetric missing-path case folding covers APFS `ẞ`/`ß` aliases before batch publication.
- Targeted edits preserve pre-existing leading U+FEFF content while still blocking added BOMs.
- Bound cumulative ordered-edit expansion to prevent replace-all amplification from exhausting memory.
- Cache per-EOL replacement conversions across repeated matches.
- Preserve invocation order while resolving canonical single-file lock keys.

## 0.2.6 — 2026-07-24

- Pairwise ancestor-path checks avoid locale-sort interlopers (`a`, `a-`, `a/x`).
- Dangling parent symlinks fail create planning before any batch write.
- Create plans bind to the canonical parent and reject parent identity/symlink changes before publish.
- Single-file calls use the same missing-path canonical lock key as batches.

## 0.2.5 — 2026-07-24

- Strengthen missing-path case folding for APFS aliases (`ſ`/`s`, `ς`/`σ`, `ß`/`ss`, `ﬀ`/`ff`).
- Preserve exact `oldText` line endings before tolerance matching, preventing mixed-EOL wrong-block edits.
- Convert replacement line endings per matched anchor rather than file-wide dominant EOL.

## 0.2.4 — 2026-07-24

- Treat `ENOTDIR` as an invalid path (not a missing creatable file) during snapshot/plan.
- Reject multi-file batches where one target is a path-ancestor of another before any write.
- Plan-time checks that publication directories are writable (`W_OK|X_OK`) for replace and create.

## 0.2.3 — 2026-07-24

- Batch lock/dedupe keys canonicalize missing paths via deepest existing ancestor (symlink parents + case-fold on macOS/Windows) so alias creates cannot partial-write.
- Exact match discovery includes overlapping occurrences (`ana` in `banana`); uniqueness/overlap checks reject them.
- Remove heuristic `\n` unescaping of canonical strings; JSON already decodes real newlines.

## 0.2.2 — 2026-07-24

- Narrow `\n` unescape so Windows paths (`C:\new`, `C:\tmp`) and prose escapes are not corrupted.
- Insert `all` skips anchors that already have long/block insert text instead of doubling them.
- Short inserts no longer false-positive as already-applied against shared prefixes (`tes`/`t` in `test`).

## 0.2.1 — 2026-07-24

- Unescape model payloads like `line1\nline2` in rewrite/oldText/newText when no real newlines are present.
- Missing-edit diagnostics show the file head when no close match exists.

## 0.2.0 — 2026-07-24

- `insert: "before" | "after"` on edits: add text at an anchor without replacing it.
- Multi-file batches via `files: [{ path, edits|rewrite }, ...]` (plan all, then write; path aliases deduped via realpath).
- Insert already-applied detection and overlap checks use the matched anchor span.
- Plan-time safety preflight (setuid/setgid/hardlink/capabilities/platform) so multi-file batches fail closed before any write.
- Reject stray top-level edit fields when `files` is set.

## 0.1.2 — 2026-07-24

- Soften prompts: sell `rewrite` as easy whole-file path; do not ban shell.

## 0.1.1 — 2026-07-24

- Prompt/docs ladder: make `rewrite` the easy whole-file path (no `oldText`); keep `edits` for small unique patches.

## 0.1.0 — 2026-07-24

- Initial public release of `apply_edits` for Pi.
- Ordered multi-edit batches with atomic commit, rewrite/create modes, and fuzzy line matching.
- Hides built-in `edit`/`write` by default; keep them with `--apply-edits-with-builtins` or `PI_APPLY_EDITS_KEEP_BUILTINS`.
- Validated against Pi 0.82.0.
