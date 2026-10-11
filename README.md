# pi-apply-edits

pi-apply-edits is a Pi extension for focused patches, repeated replacements, and complete file writes.
Use it to make multi-file changes with formatting preservation, optional previews, and clear results showing what was written.

![Pi selects an editing tool, plans every file, then previews changes or writes and verifies files before returning a receipt.](.github/readme/editing-flow.png)

Pi plans each requested file, then either previews the changes or writes files and reports what completed.

## Install and start

Requires **Node 24+ and Pi 1.0.0+**. Works with official Pi and Fitch Pi.

```sh
pi install git:github.com/fitchmultz/pi-apply-edits
pi
```

In an existing Pi session, use `/reload` to refresh extension code; restart after changing dependencies.
Then ask Pi for a change, such as:

> Rename `oldName` to `newName` in these two files and show me the result.

The extension registers four tools for Pi to use. When a writing tool is active and your
platform supports replacement, it hides Pi's default `edit` and `write` tools.
You can [keep the built-in tools](#configuration) too.

See [examples below](#examples) for the tool formats, or the [editing reference](docs/reference.md) for the full details.

## Choose a tool

| What you want to do                                      | Tool            |
| -------------------------------------------------------- | --------------- |
| Patch, create, delete, or move files                     | `apply_patch`   |
| Replace repeated text, an anchored range, or insert text | `replace_text`  |
| Create a file or replace its complete contents           | `write_files`   |
| Inspect a patch without writing                          | `preview_patch` |

All files in a call are planned before writing begins. **A failure during writing can still leave a partial batch.**
Check the reported completed, failed, uncertain, and unattempted paths before retrying.
Previews are optional.

## Examples

These are the inputs Pi sends to the tools; you can ask for the same changes in plain language.

### Make a focused patch

`apply_patch` accepts this patch text. `preview_patch` uses the same format for a read-only preview.

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-const state = 'old';
+const state = 'new';
*** Add File: src/new.ts
+export const ready = true;
*** End Patch
```

Patches preserve existing BOMs, local line endings, final-newline state, and untouched bytes.
Context must identify a unique match. Creates and moves refuse to overwrite an existing destination.
See the [patch reference](docs/reference.md#patches) for anchors, deletions, and moves.

### Replace repeated text

Pass this to `replace_text`:

```json
{
  "files": [
    {
      "path": "src/example.ts",
      "edits": [{ "oldText": "oldName", "newText": "newName", "all": true }]
    }
  ]
}
```

Without `all: true`, the match must be unique. Edits within a file run in order and see earlier edits.
Use `endText` for an inclusive range, or `insert` to keep an anchor and add text beside it.
The [replacement reference](docs/reference.md#compact-replacements-and-ranges) covers both.

### Write a complete file

Pass this to `write_files`:

```json
{
  "files": [
    { "path": "src/new.ts", "content": "export {};\n", "mode": "create" },
    { "path": "src/existing.ts", "content": "complete content\n", "mode": "replace" }
  ]
}
```

`create` requires a missing file; `replace` requires an existing one.
Replacements preserve the existing UTF-8 BOM and dominant line ending by default.
Set `preserveFormatting: false` on a file to write its supplied content exactly.
Creates always use exact content.

## Preview and inspect results

Use `preview_patch`, or add top-level `"preview": true` to a `replace_text` or `write_files` call.
Previews show planned changes without writes, staging, or publication probes.
Applying later reads and validates the files again.

Expand a tool result in Pi to inspect its generated diffs and per-file outcomes.
For integrations, `details.modifiedFiles` contains verified committed paths; it can include
completed writes even when the call fails. Previews add no committed paths.
See [previews and receipts](docs/reference.md#previews-and-receipts) for the full result format.

## Configuration

- **Keep Pi's default writers:** start Pi with `pi --apply-edits-with-builtins`, or set `PI_APPLY_EDITS_KEEP_BUILTINS=1`.
- **Change working directories:** if you use [pi-change-working-dir](https://github.com/fitchmultz/pi-change-working-dir), use version 0.5.0 or later. Paths bind to the selected directory before approval; otherwise they use Pi's session directory.
- **Try a checkout:** run `pi -e /path/to/pi-apply-edits`. The extension entry is `extensions/apply-edits.ts`.

Pi's tool selections and exclusions still apply. Unrelated custom and remote writers remain active.
A preview-only selection leaves writers active and skips publication probes.

## Platform and file safety

Existing-file replacement supports macOS, Linux, and Android/Termux when the required native tools are available:

- **macOS:** uses the system `/bin/cp` and `osascript` for metadata and ACL preservation.
- **Linux:** requires GNU `/bin/cp` and `getcap`.
- **Android/Termux:** run `pkg install coreutils attr libacl`. GNU `mv` must support `--exchange` and `--no-clobber`; extended ACLs and non-SELinux extended attributes are rejected.

On other platforms, existing-file replacement is unavailable; explicit creation remains available.
Pi's built-in writers stay active when replacement support is unavailable.

Paths are literal: `~` and `file://` are not expanded. Absolute paths and `..` can reach outside
the working directory. Text writes reject non-UTF-8, NUL-containing, hard-linked, and non-regular targets.
Concurrent external changes can still race with publication; inspect any reported recovery paths before retrying.
The [filesystem reference](docs/reference.md#filesystem-behavior) explains platform limits, symbolic links, metadata, and recovery.

## More information

- [Editing reference](docs/reference.md): all tool formats, matching rules, receipts, and filesystem behavior.
- [Migrating from 0.7](docs/reference.md#migration-from-07): update tool allowlists and integrations.
- [Development](docs/development.md): setup and compatibility checks.
- [Code quality and maintainability](QUALITY.md): checker setup, editor configuration, and responsibility boundaries.
- [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/fitchmultz/pi-apply-edits/issues)

## License

[MIT](LICENSE). Parser portions are also covered by [Apache-2.0](LICENSE-codex).
