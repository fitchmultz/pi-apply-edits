# Changelog

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
