# Changelog

## 0.1.2 — 2026-07-24

- Soften prompts: sell `rewrite` as easy whole-file path; do not ban shell.

## 0.1.1 — 2026-07-24

- Prompt/docs ladder: make `rewrite` the easy whole-file path (no `oldText`); keep `edits` for small unique patches.

## 0.1.0 — 2026-07-24

- Initial public release of `apply_edits` for Pi.
- Ordered multi-edit batches with atomic commit, rewrite/create modes, and fuzzy line matching.
- Hides built-in `edit`/`write` by default; keep them with `--apply-edits-with-builtins` or `PI_APPLY_EDITS_KEEP_BUILTINS`.
- Validated against Pi 0.82.0.
