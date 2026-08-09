# pi-apply-edits

A Pi package that provides one reliable file-mutation tool: `apply_edits`.

Requires Pi 0.84.1 or later. Pi 0.84.0 and earlier are not supported.

By default, the extension removes Pi's built-in `edit` and `write` tools before
the first model turn when this package owns the active `apply_edits` registration
and existing-file replacement is supported. It does not override those registry
entries, so they remain active on unsupported platforms or when requested.

## Install

```sh
pi install git:github.com/fitchmultz/pi-apply-edits@v0.4.0
```

Or load a checkout directly:

```sh
pi -e /path/to/pi-apply-edits
```

Keep all three mutation tools for a session:

```sh
pi -e /path/to/pi-apply-edits --apply-edits-with-builtins
```

Or set `PI_APPLY_EDITS_KEEP_BUILTINS=1`, which is useful for child, RPC, and
scripted sessions.

If `apply_edits` is excluded with `--tools` or `--exclude-tools`, the extension
does not hide `edit` or `write`. When `apply_edits` is active, explicitly
listing the built-ins still requires `--apply-edits-with-builtins` or the
environment opt-in.

## Tool contract

Ladder (cheapest correct choice first):

1. **Whole file / most of file / new file** → `rewrite` with full contents (`onMissing: "create"` only when creating). No `oldText` matching.
2. **Small unique substring** → `edits` with short exact `oldText`
3. **Insert at an anchor** → `edits` with `insert: "before"` or `insert: "after"`
4. **Several files together** → `files: [{ path, edits|rewrite }, ...]` (plan-first batch; nothing writes until every file can be planned)

Provide `files: [...]`, a single-file `path` with exactly one of `edits` or
`rewrite`, or the exact compact retry payload returned after an eligible failure:

```json
{
  "path": "src/example.ts",
  "edits": [
    {
      "oldText": "const state = 'old';",
      "newText": "const state = 'new';"
    }
  ]
}
```

Insert without replacing the anchor. `newText` is inserted exactly; include any needed newline or separator:

```json
{
  "path": "src/example.ts",
  "edits": [
    {
      "oldText": "import fs from \"node:fs\";",
      "newText": "\nimport path from \"node:path\";",
      "insert": "after"
    }
  ]
}
```

Multi-file batch (plan all, then write):

```json
{
  "files": [
    {
      "path": "src/a.ts",
      "edits": [{ "oldText": "foo", "newText": "bar" }]
    },
    {
      "path": "src/b.ts",
      "rewrite": "export {}\n",
      "onMissing": "create"
    }
  ]
}
```

Edits are ordered. Each edit sees the in-memory result of prior edits, but the
file is committed only after every edit succeeds. A repeated match is rejected
unless that edit explicitly sets `"all": true`.

To rewrite an existing file:

```json
{
  "path": "src/example.ts",
  "rewrite": "complete file content\n"
}
```

Creation is explicit so a typo does not silently create the wrong path:

```json
{
  "path": "src/new-file.ts",
  "rewrite": "complete file content\n",
  "onMissing": "create"
}
```

`onMissing` is valid only with `rewrite`.

## Compact retries

Two pre-write failures can be retried without resending unchanged file bodies:

```json
{"retry":{"from":"<tool-call-id>"}}
```

```json
{"retry":{"from":"<tool-call-id>","oldText":"corrected unique anchor"}}
```

The tool includes the appropriate payload in eligible error text. `create` is
available only for rewrite-only requests and refuses to overwrite every target
observed missing during the original failure if any of them appears before retry.
`oldText` is available only for edit-only
requests and changes only the failing anchor; the original `newText` is preserved.
Both retries are single-use when execution begins, remain available while a
prepared call awaits approval, expire when the current agent run settles or the
session changes, and pass the reconstructed full request through normal
validation and `tool_call` policy hooks. Other failures require a normal request.

## Matching and failure behavior

1. Exact text is tried first.
2. If exact text is absent, complete-line matching may correct typography,
   Unicode compatibility, trailing whitespace, or one uniform indentation
   shift.
3. Corrected matches must still be unambiguous unless `all` is explicit.
4. A failed or ambiguous edit returns current nearby text when useful and
   writes nothing from that call.

The extension repairs a small closed set of common model argument mistakes:
`file_path`, write-style `content`, Claude-style `old_string` / `new_string` /
`replace_all`, top-level replacement fields, and JSON-stringified `edits`.
Canonical and alias fields must agree; conflicting aliases or mutation modes
are rejected rather than guessed.

## Filesystem behavior

- Relative paths use the session working directory. Absolute paths are accepted.
  `..` and absolute paths can address files outside that directory; this tool is
  not a filesystem sandbox. All other path characters are literal: `~`,
  `file://`, Unicode spaces, and leading `@` segments are never expanded or rewritten.
- Calls on the same file share Pi's mutation queue; calls on different files
  remain parallel.
- Existing files are published by same-directory atomic replacement from a
  metadata-preserving native clone.
- A best-effort directory-entry, metadata, and content recheck runs immediately
  before rename. Portable Node has no compare-and-swap rename, so an external writer in the
  final system-call window can still win or be overwritten. Post-rename
  verification reports success only for the prepared target. If either inode
  changes, it never attempts rollback: the target is left untouched and a named
  recovery path retains the earlier version for inspection.
- Symbolic links are followed without replacing the link itself.
- Existing ownership, ordinary permissions, ACLs, extended attributes, UTF-8
  BOMs, and dominant line endings are preserved on macOS and Linux. Setuid and
  setgid files are rejected without mutation. Linux also requires `getcap` and
  rejects capability-bearing files because the kernel can clear capabilities
  when content changes. Replacement relies on `/bin/cp` metadata cloning, requires
  GNU `cp` on Linux, and fails before mutation if metadata cannot be verified.
- Existing-file replacement fails closed on other platforms; keep Pi's
  built-ins enabled there until a native metadata-preserving publisher is
  implemented. Explicit create remains available.
- Missing parent directories are created only for an explicit create. Creates are
  fully staged before publication, and the missing root and every file name are
  then claimed with exclusive no-clobber operations. Concurrent creates under one
  missing root, and two spellings of one missing target on a case-insensitive
  volume, serialize through one package-local create mutex. It has no path key, so
  ancestor publication and `realpath` capitalization cannot change its identity. This
  deliberately serializes all operations that discover a missing target; existing-file
  operations remain parallel. If publication stops after a file name is claimed, the
  partial root and private staging tree are retained at named paths for inspection.
- Cleanup atomically moves temporary, recovery, and staged paths into private
  quarantine directories, rechecks identity, and preserves detected swaps for inspection.
- A newly claimed directory is owner-checked before publication or cleanup, so a
  cross-user substitution in a shared-writable ancestor is rejected and left untouched.
  A same-user process can still rename the new directory away and substitute its own in
  the `mkdir`-to-`lstat` gap. Portable Node exposes neither the identity created by
  `mkdir` nor dirfd-relative operations, so closing that gap cleanly needs a native
  primitive. Later identity checks still fail closed on detected swaps.
- Non-UTF-8, NUL-containing, non-regular, dangling-symlink, and hard-linked
  targets are rejected without mutation. A dangling symbolic-link batch entry is
  rejected during key discovery, before Pi acquires any lock; otherwise its target
  could appear and make two batch keys resolve to one queue. Pi 0.84.1 has no atomic
  multi-key queue API, so an external process can still create both an alias and its
  target after this check. Closing that final window requires an upstream primitive.
- Corrective matching and diff generation have explicit work budgets.
  Oversized fuzzy matches fail for a more exact retry; expensive diffs are
  omitted from details before publication.
- Diffs are kept out of model-facing result text but retained in bounded
  structured details and shown when the TUI row is expanded. Requests are capped
  at 64 files and 100 ordered edits per file.

`apply_edits` is a distinct tool name. Extensions that specifically listen for
`edit` or `write` tool-call events will not observe it and should add
`apply_edits` support before those built-ins are disabled.

## Development checks

```sh
npm ci
npm run check
```

The package uses Pi's public peer APIs and declares TypeBox as its only direct
runtime dependency. Validated against Pi 0.84.1.
