# Contributing

This repository is a JavaScript action. The runner starts `dist/index.cjs` with Node 24. Source lives in `src/` and is bundled with esbuild as CommonJS, because `@actions/core` loads Node builtins through `require`. The package itself is ESM so tests can import `src/` directly. The `.cjs` extension keeps the bundle CommonJS.

Node 24 is required for the action runtime and for CI. Local checks also run on Node 22.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
git diff --exit-code -- dist
node scripts/ci-dry-run.mjs
```

Commit `dist/index.cjs` with the source change. CI rejects a pull request whose bundle does not match `npm run build`.

## Why this is a JavaScript action

Publishing is a multipart upload with sha256 checks, retries, JSONC parsing, and archive inspection. Those belong in a tested program. A composite action would shell out to `curl` and `tar`, which is harder to test and easier to leak a token when the shell traces commands. Node 24 is the current GitHub Actions JavaScript runtime. Node 20 was removed from hosted runners on 2026-09-23.

Dependencies are `@actions/core` (inputs, outputs, masking, OIDC, job summary), `tar` (archive entries and listing), `minizlib` (gzip for the pack stream), and `ignore` (gitignore include/exclude patterns). The registry client uses `fetch`.

Packing does not use `tar.create`. That scheduler deadlocks on hardlinked trees and does not pause gzip when the file writer is full. `src/archive.ts` writes one entry at a time into a gzip stream that honors backpressure, then stores the `.tar.gz` in a temp file. `node --import tsx scripts/pack-large.mjs` packs a synthetic tree over 256 MiB uncompressed and checks that the gzip, sha256, and symlink entries come back. CI runs it as its own job.

## Releases

Do not publish this action to the Marketplace until a maintainer has reviewed it. A release is a GitHub Release whose tag is exact semver, such as `v1.2.3`. That tag is immutable: this workflow never force-pushes it.

`.github/workflows/release.yml` runs on that release. After tests pass and `dist/` matches the source, it moves the major tag (`v1` for a `v1.x.y` release) to the same commit. Prerelease tags such as `v1.2.3-rc.1` do not move `v1`.

Do not create a GitHub Release named `v1`. `v1` is only the moving tag. If the repository uses immutable releases, a tag attached to a release cannot be moved, so the semver tag stays put and `v1` must not itself be a release.

Users pin `SolZeroAI/alchemy-new-publish-action@v1`.
