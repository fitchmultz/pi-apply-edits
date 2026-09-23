# pi-apply-edits

Focused editing tools for Pi: `apply_patch`, `replace_text`, `write_files`, and
`preview_patch`. Requires Node 22.19 or later and Pi 0.87.0 or later; works with
both official Pi and the Fitch fork.

## Install

```sh
pi install git:github.com/fitchmultz/pi-apply-edits@v1.0.2
```

Restart Pi after installing or updating extension code. `/reload` does not replace
already-loaded code. A checkout can be loaded with `pi -e /path/to/pi-apply-edits`.
The extension entry remains `extensions/apply-edits.ts` for existing package filters.

On Android/Termux, atomic publication also requires GNU `cp`/`mv`, `getfacl`, and
`getfattr`: `pkg install coreutils attr libacl`.

All four tools are registered by default, subject to Pi's tool selections and
exclusions. When an owned mutation tool is active and replacement is supported,
Pi's default `edit` and `write` are hidden. Unrelated custom/remote writers remain
active. Preview-only selections do not hide writers or run publication probes.
To retain the default writers too, use `--apply-edits-with-builtins` or
`PI_APPLY_EDITS_KEEP_BUILTINS=1`.

With `pi-change-working-dir`, use version 0.5.0 or later. Paths are bound to the
selected directory before approval hooks run, so a directory change while approval
waits cannot redirect the admitted operation. Without that extension, paths use
the native session directory. An identifiable older directory owner returns upgrade
guidance rather than silently using a different directory.

## Choose a tool

| Task | Tool |
| --- | --- |
| Focused changes across one or more files | `apply_patch` |
| Repeated replacements, large anchored ranges, inserts | `replace_text` |
| New files or complete replacements | `write_files` |
| Read-only patch inspection | `preview_patch` |

Each call plans all its files before publication. A later publication failure can
still leave a partial batch; inspect the receipt instead of replaying the entire call.
Previews are optional, never a required extra editing step.

### Patches

`apply_patch` accepts one string, `input`. Models supporting native grammar tools
send patch text directly; other models use the same string in a normal JSON call.
`preview_patch` has the identical input format.

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-const state = 'old';
+const state = 'new';
*** Add File: src/new.ts
+export const ready = true;
*** Delete File: obsolete.txt
*** End Patch
```

To move a file, place `*** Move to: new/path` immediately after its Update File
header. Changes may follow; omitting them performs a pure move. Add and Move never
overwrite an existing destination. Directory operations are rejected. Moves stay
on one filesystem and retain source metadata. A move publishes its destination
before removing its source, so a failed source removal can leave both entries.

Patches preserve existing BOMs, local mixed line endings, final-newline state, and
untouched/context bytes. Added indentation is literal. Exact matching is tried
before bounded whitespace and typography correction. Named `@@ anchor` lines
must each be unique in the remaining source suffix and advance past that line;
stacked anchors are supported. The old/context block must also be unique in the
remaining suffix. `*** End of File` restricts the final chunk to the actual tail.
An unanchored additions-only chunk appends; a named-anchor additions-only chunk
inserts after its anchor (EOF explicitly appends). Chunks refer to the original
file in order. Deleting an unterminated tail transfers its missing final newline
to the retained last line.

The parser is adapted from [OpenAI Codex](https://github.com/openai/codex/tree/4e21628f9ec9ee656650cd2b62ef92225725b5ac/codex-rs/apply-patch),
pinned to `rust-v0.155.1` (Apache-2.0; see `LICENSE-codex`). Strict envelopes,
ambiguity rejection, stacked anchors, anchored insertion, and byte-format
preservation are deliberate differences from the reference implementation. Blank
context lines require their leading space; stripped prefixes are not repaired.

### Compact replacements and ranges

```json
{
  "files": [{
    "path": "src/example.ts",
    "edits": [{ "oldText": "oldName", "newText": "newName", "all": true }]
  }]
}
```

Edits are ordered within each file. Each sees the result of preceding edits, and
nothing is published until all succeed. Anchors must be unique unless `all: true`
explicitly selects every non-overlapping match.

Use `endText` for a large range without resending its body. Both anchors are
included, unique, and ordered. It cannot be combined with `all: true` or `insert`:

```json
{
  "files": [{
    "path": "src/conflicted.ts",
    "edits": [{ "oldText": "<<<<<<< HEAD\n", "endText": ">>>>>>> origin/main\n", "newText": "" }]
  }]
}
```

`insert: "before"` or `"after"` preserves the anchor. No separator is inferred;
include needed newlines/spaces in `newText`. Empty `newText` deletes replacements
or ranges but is invalid for insertion.

Exact anchors are preferred. When absent, complete-line matching can correct
Unicode typography, trailing whitespace, or a uniform indentation shift. Every
correction is reported. Replacement indentation follows that shift; inserts retain
literal indentation. Ambiguous matches, overlapping matches, and unrepresentable
tab corrections fail before publication.

### Complete files

```json
{
  "files": [
    { "path": "src/new.ts", "content": "export {};\n", "mode": "create" },
    { "path": "src/existing.ts", "content": "complete content\n", "mode": "replace" }
  ]
}
```

`mode` is required. `create` refuses an existing entry; `replace` requires an
existing file. Replacement preserves an existing UTF-8 BOM and dominant line
ending by default. Set `preserveFormatting: false` on a file to write the supplied
UTF-8 content exactly, including deliberate BOM and mixed-EOL changes. Creates
always use exact content. Invalid Unicode and NUL-containing text are rejected.

## Previews and receipts

Use `preview_patch`, or top-level `preview: true` on `replace_text` and `write_files`.
Previews read current files and produce planned diffs without writes, staging,
permission-to-write requirements, or publication probes. They are not cached plans
or a guarantee that publication will succeed; applying re-reads and validates again.

Model-facing preview diffs are capped at 50 KB or 2,000 lines. Complete generated
diffs remain in structured details and the expanded TUI. Applied calls return a
compact summary; expanding their TUI result shows the retained evidence. Entry-only
moves/deletes have operation evidence rather than a text diff.

Every executed editing call returns:

- `details.modifiedFiles`: verified committed absolute paths, including both paths
  of a completed move. Partial-error results can contain committed paths. Uncertain
  paths are excluded. Previews and unchanged files contribute no paths.
- `details.files`: absolute `path`, operation, optional `moveTo`, diff/matching
  evidence, warnings, and `status`: `applied`, `unchanged`, `failed`, `unattempted`,
  or `uncertain`. Planned preview changes are `unattempted` and marked read-only.
- `details.preview: true` for read-only calls; `details.error` when the call failed.

Pi receives an error flag without losing the receipt. Compaction retains committed
paths even from partial errors. Consumers should use `modifiedFiles`, never infer
completed writes from a successful tool name, patch text, or intended file list.
Syntax/schema/policy failures before execution remain native Pi errors.

## Migration from 0.7

Version 1 removes the executable `apply_edits` tool, compact retry handles, argument
aliases, and JSON-string repairs. Update explicit tool allowlists and consumer
hooks to the four names above. Both structured tools use one `files` array, even
for a single file. Use explicit `write_files` modes instead of `onMissing` and
`requireMissing`; use `replace_text` for existing replacement/range/insert workloads.
The package name, extension entry path, and keep-builtins switches are unchanged.

## Filesystem behavior

- Relative paths use the admitted execution directory. `..` and absolute paths can address files outside the
  working directory; this tool is not a filesystem sandbox. All other path characters
  are literal: `~`, `file://`, Unicode spaces, and leading `@` segments are never
  expanded or rewritten. POSIX traversal is native: `link/../file` follows the link
  before visiting its parent, and trailing separators still require directories.
  Windows keeps native DOS/UNC normalization.
- Overlapping single-file and batch calls retain invocation order and share Pi's
  mutation queue. Calls on unrelated files remain parallel.
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
- Text edits follow symbolic links without replacing the link itself. Delete and
  pure Move operate on the link entry, including dangling links, leaving its target
  untouched. Combining content changes with a link-entry move is rejected; use
  separate calls. Windows link-entry moves are rejected before publication.
- Existing ownership, ordinary permissions, ACLs, and extended attributes are
  preserved using native copying on macOS and Linux. macOS also uses the system
  `osascript` command to retain inherited ACL entries exactly. Text formatting is preserved
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
- Creates preserve native macOS ACL inheritance, including direct-child-only
  rules. The system `osascript` command calls the native ACL API for private
  staging; no compiler or additional package is required. Inherited rights that
  prevent staging or content verification cause an explicit failure.
- Missing parent directories are created only for an explicit create or move destination. Creates are
  fully staged before publication, and the missing root and every file name are
  then claimed with exclusive no-clobber operations. Concurrent creates under one
  missing root, and two spellings of one missing target on a case-insensitive
  volume, serialize through one package-local create mutex. It has no path key, so
  ancestor publication and `realpath` capitalization cannot change its identity. This
  deliberately serializes all operations that discover a missing target; existing-file
  operations remain parallel. If publication stops after a file name is claimed, the
  partial root and private staging tree are retained at named paths for inspection.
  A create through `missing/../file` also creates the traversed directory, during
  publication only. Such directories join their own staged subtree when possible.
  A batch rejects a traversal directory overlapping another group's missing root
  or a requested file before writing anything; split those operations into separate calls.
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
- Text writes reject non-UTF-8, NUL-containing, non-regular, dangling-symlink, and
  hard-linked targets without mutation. A dangling symbolic-link batch entry is
  rejected during key discovery, before Pi acquires any lock; otherwise its target
  could appear and make two batch keys resolve to one queue. Pi has no atomic
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

Extensions that listen only for `edit` or `write` tool-call events must add the
new tool names and consume verified receipts before those defaults are hidden.

## Development checks

```sh
npm ci --ignore-scripts
npm run check:compat
# Optional: actual native checkpoint/reload/restore regression (no model calls)
PI_HOST_INDEX=/path/to/checkpoint-capable-pi/dist/index.js node --test test/checkpoint.test.ts
```

The package uses public Pi and TypeBox peer APIs, with jsdiff as its only direct
runtime dependency. `check:compat` runs typechecking, tests, and a pack dry-run
against the installed host; its official development cohort is Pi 0.87.1.
The suite includes real Pi loader/policy/settlement
checks with scripted responses and no model calls. Native checkpoints skip on
unsupported official hosts, but must pass on the fork. CI qualifies the declared
official Pi version on macOS/Node 22.19 and `fitchmultz/pi@main` on Linux/Node 24;
both lanes verify a fresh Git consumer through the real Pi CLI. Linux metadata
fault tests require `attr`, `acl`, and a C compiler.
Temporary directories must allow the current user to set the tested permission
bits (on macOS, a directory inherited from `/tmp` may need its group set to the
current user's primary group before creating fixtures).
