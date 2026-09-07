# pi-apply-edits

A Pi package that provides one reliable file-mutation tool: `apply_edits`.

Requires Node 22.19 or later and Pi 0.84.1 or later.

By default, the extension removes Pi's built-in `edit` and `write` tools before
the first model turn when this package owns the active `apply_edits` registration
and existing-file replacement is supported. It does not override those registry
entries, so they remain active on unsupported platforms or when requested.

## Install

```sh
pi install git:github.com/fitchmultz/pi-apply-edits@v0.7.0
```

Restart Pi after installing or updating extension code. `/reload` does not replace
already-loaded code.

Or load a checkout directly:

```sh
pi -e /path/to/pi-apply-edits
```

On Android/Termux, atomic publication also requires GNU `cp`/`mv`, `getfacl`, and
`getfattr`:

```sh
pkg install coreutils attr libacl
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
3. **Large middle range** → `edits` with unique `oldText` and inclusive `endText` anchors
4. **Insert at an anchor** → `edits` with `insert: "before"` or `insert: "after"`
5. **Several files together** → `files: [{ path, edits|rewrite }, ...]` (plan-first batch; nothing writes until every file can be planned)

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

Replace or delete a range without resending its contents. Both anchors are included,
must be unique and ordered, and cannot be combined with `all: true` or `insert`.
An explicit `all: false` is allowed:

```json
{
  "path": "src/conflicted.ts",
  "edits": [
    {
      "oldText": "<<<<<<< HEAD\n",
      "endText": ">>>>>>> origin/main\n",
      "newText": ""
    }
  ]
}
```

Inserts keep the anchor unchanged and infer no separators. Include any needed
newline or space in `newText`; supplied newlines use the matched area's
line-ending style:

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
unless a non-range edit explicitly sets `"all": true`. Range edits require one
unique start and one unique end anchor.

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

Add `requireMissing: true` alongside `onMissing: "create"` for a create-only guard
that refuses to overwrite an existing file. Without the guard, `onMissing` controls
only what happens when the target is missing.

Rewrites preserve an existing UTF-8 BOM and its dominant line ending by default.
To intentionally change those bytes, set `preserveFormatting: false`:

```json
{
  "path": "src/example.ts",
  "rewrite": "exact UTF-8 content with LF endings\n",
  "preserveFormatting": false
}
```

This writes the supplied UTF-8 content exactly, including any BOM and LF, CRLF, or
mixed line endings. Creates are always exact. `onMissing`, `requireMissing`, and
`preserveFormatting` are valid only with `rewrite`, including inside `files`.
Invalid Unicode and NUL-containing content remain rejected in every mode.

## Previews

Add `preview: true` to a normal single-file or batch request to inspect changes
without writing:

```json
{
  "path": "src/example.ts",
  "edits": [{ "oldText": "ready()", "newText": "start()" }],
  "preview": true
}
```

Previews use the same ordered edits, range anchors, insertions, normalization, and
formatting rules as an apply. They return “Would…” results and diffs without
creating files, staging directories, or running publication capability probes.
They are content-only checks, not a promise that publication will succeed. Applying
without `preview` re-reads the files and checks all filesystem protections again;
a preview is never a cached commit plan or permission grant.

Preview diff text sent to the model is capped at 50 KB or 2,000 lines, with an
explicit truncation note. Complete generated patches remain in structured details
for SDK/RPC clients and the expanded TUI result. Actual writes keep diffs out of
model-facing text and return a compact summary instead.

`preview` belongs at the top level, not inside file entries. It also works with a
compact retry and does not consume that retry. Preview failures do not allocate
new compact retries.

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
requests and changes only the failing start anchor; the original `endText` and
`newText` are preserved. Range-end failures require a normal request. Both retries
keep the original absolute paths even after working-directory changes. They
are single-use when write execution begins, remain available while a
prepared call awaits approval, expire when the current agent run settles or the
session changes, and pass the reconstructed full request through normal
validation and `tool_call` policy hooks. Other failures require a normal request.

## Matching and failure behavior

1. Exact text is tried first for every anchor.
2. If exact text is absent, complete-line matching may correct typography,
   Unicode compatibility, trailing whitespace, or one uniform indentation
   shift. Corrections report their matching strategy and starting lines. Tab
   indentation is retained; a correction that cannot represent a caller's tab at
   the adjusted depth is rejected with exact-anchor guidance.
3. Corrected matches must still be unambiguous unless `all` is explicit on a
   non-range edit. A range requires unique, ordered `oldText` and `endText` anchors.
4. A failed or ambiguous edit returns current nearby text when useful and
   writes nothing from that call.

The extension repairs a small closed set of common model argument mistakes:
`file_path`, write-style `content`, Claude-style `old_string` / `new_string` /
`replace_all`, `preserve_formatting`, top-level replacement fields, and
JSON-stringified `edits` or `files`.
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
  metadata-preserving native clone. Android/Termux uses GNU `mv --exchange` so the
  displaced inode becomes the recovery file atomically.
- A best-effort directory-entry, metadata, and content recheck runs immediately
  before publication. Portable Node has no compare-and-swap rename, so on macOS
  and Linux an external writer in the final system-call window can still win or
  be overwritten. Android's exchange retains whichever inode occupied the target
  at that instant. Post-publication verification reports success only for the
  prepared target. If either inode changes, it never attempts rollback: the target
  is left untouched and a named recovery path retains the earlier version for inspection.
- Symbolic links are followed without replacing the link itself.
- Existing ownership, ordinary permissions, ACLs, and extended attributes are
  preserved using native copying on macOS and Linux. Text formatting is preserved
  by default as described above. Setuid and setgid files are rejected without
  mutation. Linux also requires `getcap` and
  rejects capability-bearing files because the kernel can clear capabilities
  when content changes. Replacement relies on `/bin/cp` metadata cloning, requires
  GNU `cp` on Linux, and fails before target publication on required metadata-copy
  errors. Linux follows native ACL/xattr copy rules, including system xattr-policy
  exclusions; it no longer treats xattr-copy errors as best-effort success.
- Android/Termux preserves ownership, ordinary permissions, SELinux context,
  and default text formatting. It fails closed on extended ACLs or non-SELinux
  extended attributes because Termux `cp` cannot preserve them. Startup probes
  GNU `mv --exchange` and `--no-clobber`; Pi's built-ins remain enabled if any
  required command or atomic operation is unavailable.
- Existing-file replacement fails closed on other platforms. Explicit create
  remains available.
- Missing parent directories are created only for an explicit create. Creates are
  fully staged before publication, and the missing root and every file name are
  then claimed with exclusive no-clobber operations. Concurrent creates under one
  missing root, and two spellings of one missing target on a case-insensitive
  volume, serialize through one package-local create mutex. It has no path key, so
  ancestor publication and `realpath` capitalization cannot change its identity. This
  deliberately serializes all operations that discover a missing target; existing-file
  operations remain parallel. If publication stops after a file name is claimed, the
  partial root and private staging tree are retained at named paths for inspection.
- Cleanup atomically quarantines temporary and recovery files in private directories.
  Staged publish roots move into a reserved one-character slot inside their private container.
  Empty temporary and staging containers are removed in place, so a concurrent entry is never
  relocated with its parent. Identity is rechecked after each file move, and detected swaps are
  preserved for inspection.
- Planning rejects a mutation before staging or any batch write when its longest computed
  temporary, staging, or cleanup path exceeds 991 UTF-8 bytes on macOS, 4063 on Linux or
  Android, or 32702 UTF-16 code units on Windows. These explicit support boundaries retain a 32-unit
  POSIX or 64-unit Windows safety margin below the platform path limit. The error reports the
  planned length and limit; no filesystem mutation occurs.
- A newly claimed directory is owner-checked before publication or cleanup, so a
  cross-user substitution in a shared-writable ancestor is rejected and left untouched.
  A same-user process can still rename the new directory away and substitute its own in
  the `mkdir`-to-`lstat` gap. Portable Node exposes neither the identity created by
  `mkdir` nor dirfd-relative operations, so closing that gap cleanly needs a native
  primitive. Later identity checks still fail closed on detected swaps.
- Writes reject non-UTF-8, NUL-containing, non-regular, dangling-symlink, and
  hard-linked targets without mutation. A dangling symbolic-link batch entry is
  rejected during key discovery, before Pi acquires any lock; otherwise its target
  could appear and make two batch keys resolve to one queue. Pi 0.84.1 has no atomic
  multi-key queue API, so an external process can still create both an alias and its
  target after this check. Closing that final window requires an upstream primitive.
- Batches report planning and per-file publication progress. A publication error
  lists completed, failed-or-uncertain, and unattempted paths, including nested
  groups that published out of input order. Inspect those paths and any named
  recovery files before submitting remaining changes; partial batches are never
  automatically retried.
- Corrective matching and diff generation have explicit work budgets. Oversized
  fuzzy matches fail for a more exact retry. Diffs use native time/edit-distance
  limits plus 1 MiB of combined input and 20,000 total lines; omitted diffs and
  unavailable counts are stated, not guessed. Sparse edits in large files still
  produce useful patches within those limits.
- Every generated patch is retained in structured details and is accessible when
  the TUI row is expanded; there is no second display-only line cap. Requests are
  capped at 64 files and 100 ordered edits per file.

`apply_edits` is a distinct tool name. Extensions that specifically listen for
`edit` or `write` tool-call events will not observe it and should add
`apply_edits` support before those built-ins are disabled.

## Development checks

```sh
npm ci
npm run check
```

The package uses public Pi and TypeBox peer APIs, with jsdiff as its only direct
runtime dependency. CI checks macOS and Linux on Node 22.19 and 24, against Pi 0.84.1 and
0.85.1. The suite includes a real Pi loader/policy/settlement smoke with scripted
responses and no network or provider calls. Linux metadata fault tests require
`attr`, `acl`, and a C compiler.
