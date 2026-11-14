# Development

pi-apply-edits is distributed through Git and GitHub. Use Node 24.22.3 (24.x) or 26.13.1 and later,
Git, and the npm version declared in `package.json`.

## Install and check

```sh
npm ci
npm run check:compat
```

A lifecycle-disabled installation works too:

```sh
npm ci --ignore-scripts
npm run check:compat
```

`npm ci` installs the real `pi-change-working-dir` 0.6.0 source pinned to a Git
commit for companion integration tests. The project `.npmrc` uses npm 12.2.0's
[`allow-git=root`](https://docs.npmjs.com/cli/v12/using-npm/config#allow-git) to
allow directly declared Git dependencies. Transitive Git dependencies remain
blocked, and lifecycle-script permissions are unchanged.

The tests load the installed companion package without fetching resources. After
installation, run the complete checks with Pi's automatic network activity disabled:

```sh
PI_OFFLINE=1 npm run check:compat
```

Use `npm run lint:agent` for diagnostics, `npm run lint:fix` for ordinary fixes,
and `npm run format` for formatting. Inspect fixes before committing.

`check:compat` runs policy and installed-tool probes, strict semantic lint,
formatting checks, both canonical compiler projects, behavioral tests, and a
pack dry-run. Each independent gate runs and contributes to the final status.
Keep the checkout unchanged while checks run.

`tsconfig.json` maps `@earendil-works/pi-ai` to Pi's extension view
(`pi-coding-agent/dist/core/extensions/pi-ai-extension-view.d.ts`), the module
Pi's loader gives extensions, so `StringEnum` fields infer their literal types
inside TypeBox objects.

## Qualify supported hosts

Run the same command against each installed target host. The locked development
cohort is official Pi 1.5.2 and TypeBox 1.3.34. CI also resolves the latest official
Pi release and the current `fitchmultz/pi` commit. Its qualifier verifies the
selected host's package identity and a fresh Git consumer through the actual CLI.

The suite exercises the real Pi loader, tool policy, settlement, nested receipts,
and journal reload with scripted model responses. No paid model calls are needed.
Pi owns the public same-file mutation queue. Batch reservations, prospective
aliases, publication, and recovery remain package responsibilities.

Linux metadata tests require `attr`, `acl`, `libcap` tools, and a C compiler.
macOS tests use the native ACL API through `/usr/bin/osascript`. Temporary
directories must allow the user to set the permission bits under test. On macOS,
a directory inherited from `/tmp` can need its group set to the user's primary
group before fixtures are created. Android tests require the actual Termux
metadata and atomic-move tools. Platform skips are not platform qualification.

## Change quality policy

Follow [the engineering standard](engineering-standard.md), version 5.1.2.
Record an evidence-backed exception in Appendix B before changing an applicable
rule or authorized operation. Update the operation inventory and its controls in
the same review. [Quality coverage](../QUALITY.md) lists source owners, required
gates, editor behavior, and known tool limits.
