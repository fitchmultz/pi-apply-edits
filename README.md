# pi-apply-edits

A Pi package that provides one reliable file-mutation tool: `apply_edits`.

Requires Pi 0.84.0 or later. Pi 0.83 and earlier are not supported.

By default, the extension keeps `apply_edits` active and removes Pi's built-in
`edit` and `write` tools from the active tool set before the first model turn.
It does not override those registry entries, so they can still coexist when
requested.

## Install

```sh
pi install git:github.com/fitchmultz/pi-apply-edits
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

Insert without replacing the anchor:

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
available only for rewrite-only requests and refuses to overwrite a target that
appeared after the original failure. `oldText` is available only for edit-only
requests and can change only the failing anchor. Both retries are single-use,
expire when the current agent run settles or the session changes, and pass the
reconstructed full request through normal validation and `tool_call` policy
hooks before execution. Other failures require a normal request.

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

- Relative paths use the session working directory. Absolute, `~`, and
  `file://` paths are accepted. An existing literal path wins over a transformed
  path, and two existing candidates are rejected as ambiguous. Path characters
  are otherwise literal; Unicode spaces and leading `@` segments are never
  rewritten.
- Calls on the same file share Pi's mutation queue; calls on different files
  remain parallel.
- Existing files are published by same-directory atomic replacement from a
  metadata-preserving native clone.
- A best-effort descriptor/content recheck runs immediately before rename.
  Portable Node has no compare-and-swap rename, so an external writer in the
  final system-call window can still win or be overwritten. Post-rename
  verification reports success only for the prepared target. If either inode
  changes, it never attempts rollback: the target is left untouched and a named
  recovery path retains the earlier version for inspection.
- Symbolic links are followed without replacing the link itself.
- Existing ownership, ordinary permissions, ACLs, extended attributes, UTF-8
  BOMs, and dominant line endings are preserved on macOS and Linux. Setuid and
  setgid files are rejected without mutation. Linux also requires `getcap` and
  rejects capability-bearing files because the kernel can clear capabilities
  when content changes. Replacement relies on `/bin/cp` metadata cloning and
  fails before mutation if metadata cannot be verified.
- Existing-file replacement fails closed on other platforms; keep Pi's
  built-ins enabled there until a native metadata-preserving publisher is
  implemented. Explicit create remains available.
- Missing parent directories are created only for an explicit create.
- Non-UTF-8, NUL-containing, non-regular, dangling-symlink, and hard-linked
  targets are rejected without mutation.
- Corrective matching and diff generation have explicit work budgets.
  Oversized fuzzy matches fail for a more exact retry; expensive diffs are
  omitted from details before publication.
- Diffs are kept out of model-facing result text but retained in bounded
  structured details and shown when the TUI row is expanded.

`apply_edits` is a distinct tool name. Extensions that specifically listen for
`edit` or `write` tool-call events will not observe it and should add
`apply_edits` support before those built-ins are disabled.

## Development checks

```sh
npm install
npm run check
```

The package has no runtime dependencies beyond Pi's public extension API.
Validated against Pi 0.84.0.
