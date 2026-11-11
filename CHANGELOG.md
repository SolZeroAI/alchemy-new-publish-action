## alchemy-new-publish-action@1.1.0

### What changed

Outside-root symlinks fail together. The error names each link path and its target, lists up to 20, and explains that `NPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false` keeps nub's store inside the project. Packing warns when a packed `package.json` `exports`, `main`, `module`, or `bin` target was removed by exclude rules. The action sets `file-count` and `size-bytes` from the archive it built, including a dry run and a skipped publish.

### What changed

The action now accepts the optional manifest `icon` field, an `https://` URL of a square image. alchemy.new shows it as the package icon. Before this change, the action rejected a manifest with `icon` as an unknown field.

The action now checks manifest `tags` before it packs: at most 3 unique tags, each at most 24 lowercase letters, digits, and single hyphens. The registry rejects a release that breaks this rule, so a dry run now reports the problem first.

## alchemy-new-publish-action@1.0.3

### What changed

Development typecheck uses tsrs 0.20.0-ts7.1.0-beta. The editor language service uses that package's tsdk launcher at `./node_modules/tsrs/tsdk`. The install script that created `.vscode/tsrs/tsgo` is removed.

## alchemy-new-publish-action@1.0.2

### What changed

The 1.0.1 release failed to download on runners because of a dangling tracked symlink. That symlink is removed.

## alchemy-new-publish-action@1.0.1

### Alchemy package links

When `node_modules/alchemy` is a directory symlink into the package, the archive gets a relative symlink for each file under it. An absolute link is included when its target stays inside the package root. `node_modules/alchemy/bin/cli.js` is then its own member. A target that leaves the package root, or that points at a forbidden path, still fails the run.

### Default pack excludes

Packing drops `.agents`, `.cursor`, `.claude`, `.tegami`, and `.changeset` at any depth. Inside `node_modules` only, packing also drops `*.d.ts`, `*.map`, and `*.md`. Markdown outside `node_modules` stays in the archive.

### What changed

Packing rewrites an absolute symlink whose target stays inside the package root into the equivalent relative symlink in the archive. The link on disk is not changed. A symlink that leaves the package root, or that points at a forbidden path, still fails the run.

### What changed

`on-immutable` now defaults to `skip-if-digest-matches`. When the same package version already exists with the same archive digest, and the same manifest digest when the version record has one, the publish succeeds and uploads nothing. The job summary says the publish was skipped. A different digest for that version still fails. Set `on-immutable` to `fail` to stop the run when the version already exists.

### Production registry host

The default registry origin is https://api.alchemy.new. Pre stays available through the registry-url input as https://api-pre.alchemy.new.

## alchemy-new-publish-action@1.0.0

### Initial release

Publish a ready archive to the alchemy.new package registry. The manifest is uploaded separately from the tar, and the floating v1 tag tracks each stable 1.x release.
