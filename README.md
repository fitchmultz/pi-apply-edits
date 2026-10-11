# pi-apply-edits

pi-apply-edits is a [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) extension for changes to one or more text files.
The tools preserve existing text formats by default and report which changes complete.

![Pi selects a file tool, checks all requested files, then previews changes or writes files and returns file results.](.github/readme/editing-flow.png)

## Install and start

The extension requires Node 24+ and Pi 1.0.0+. You can use official Pi or Fitch Pi.
See [tool examples](docs/reference.md#choose-a-tool) and [platform requirements](#platform-requirements) for details.

```sh
pi install git:github.com/fitchmultz/pi-apply-edits
pi
```

Enter a request in Pi. For example:

> Rename `oldName` to `newName` in `src/a.ts` and `src/b.ts`.

Use `/reload` to refresh extension code in an existing session.
Restart Pi after you change dependencies.

## Use the tools

| Task                                                    | Tool            |
| ------------------------------------------------------- | --------------- |
| Patch, create, delete, or move files                    | `apply_patch`   |
| Replace text, replace an anchored range, or insert text | `replace_text`  |
| Create a file or replace its complete contents          | `write_files`   |
| Preview a patch without a write                         | `preview_patch` |

Pi selects a tool from your request. Previews are optional.
Add `"preview": true` to a `replace_text` or `write_files` call to preview its changes.

`create` refuses an existing path. `replace` requires an existing file.
Creates and moves do not overwrite existing destinations.
Set `preserveFormatting: false` for a file in `write_files` to write its supplied content exactly.

Write failures can leave a partial batch. External file changes can require file recovery.
Check each file result and reported recovery path before you retry.
Expand the tool result in Pi to see diffs and file results.

## Configuration

The extension hides Pi's default `edit` and `write` tools when a write tool is active and file replacement is supported.
Keep the default tools with `pi --apply-edits-with-builtins`.
You can also set `PI_APPLY_EDITS_KEEP_BUILTINS=1`.
Custom and remote tools retain their existing selections.

Use [pi-change-working-dir](https://github.com/fitchmultz/pi-change-working-dir) version 0.5.0 or later if you need directory changes.
Paths bind to its selected directory before approval. Without that extension, paths use Pi's session directory.

## Platform requirements

Existing-file replacement requires these native tools:

- macOS: system `/bin/cp` and `osascript`.
- Linux: GNU `/bin/cp` and `getcap`.
- Android/Termux: `pkg install coreutils attr libacl`. GNU `mv` must support `--exchange` and `--no-clobber`.

Android/Termux rejects extended ACLs and non-SELinux extended attributes.
On other platforms, explicit file creation remains available.
Pi's default write tools stay active when file replacement is unavailable.

Paths are literal. The tools do not expand `~` or `file://`.
Absolute paths and `..` can access files outside the working directory.
Check the target paths before you approve changes.

Text writes reject non-UTF-8, NUL-containing, hard-linked, and non-regular targets.
A call supports up to 64 files. `replace_text` supports up to 100 edits per file.

## Reference and development

[Editing reference](docs/reference.md): tool examples, matching rules, previews, file results, migration notes, and filesystem guarantees.

[Development](docs/development.md) · [Code quality](QUALITY.md) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/fitchmultz/pi-apply-edits/issues)

## License

[MIT](LICENSE). Parser portions are also covered by [Apache-2.0](LICENSE-codex).
