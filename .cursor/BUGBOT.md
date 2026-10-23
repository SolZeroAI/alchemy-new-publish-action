# Bugbot

Review this repository as a GitHub Action that uploads a package archive. The package is private. It is not an application, and it does not deploy Alchemy, Workers, or a database.

Flag these:

- A token, grant, or OIDC JWT that can reach a log, an error message, a job summary, or an action output. Mask `anr_` and `anu_` values as soon as they exist. The OIDC audience is `https://alchemy.new/registry/publish`.
- A pack path that can include `.git`, a secret file, or `alchemy.new.jsonc` at the archive root. The manifest is uploaded with its own request. Nested copies of the manifest may stay in the archive.
- A symlink whose target leaves the package root. That must fail the run. An absolute symlink that stays inside the package root is rewritten to a relative link in the archive at pack time. The file on disk must not change. An absolute symlink in a prebuilt archive must fail. A symlink that points at a forbidden path must fail.
- A change under `src/` that does not rebuild `dist/index.cjs`.
- A force-push of an immutable semver tag. Only the floating `v1` tag moves, and only for a stable `1.x.y` release.
- An npm publish, a Marketplace publish, or `id-token: write` on the release workflow. This package is not published to npm.
- A retry that swallows a non-retryable registry error, or a complete call whose `sha256` or `manifestSha256` is not the hash of the bytes that were uploaded.
