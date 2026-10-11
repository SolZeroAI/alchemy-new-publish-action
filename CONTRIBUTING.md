# Contributing

This repository is a JavaScript action. The runner starts `dist/index.cjs` with Node 24. Source lives in `src/` and is bundled with esbuild as CommonJS, because `@actions/core` loads Node builtins through `require`. The package itself is ESM so tests can import `src/` directly. The `.cjs` extension keeps the bundle CommonJS.

Node 24 is required for the action runtime and for CI. Local checks also run on Node 22.

```sh
nub ci
nub run typecheck
nub run lint
nub run test
nub run build
git diff --exit-code -- dist
node scripts/ci-dry-run.mjs
node --import tsx scripts/pack-large.mjs
```

Commit `dist/index.cjs` with the source change. CI rejects a pull request whose bundle does not match `nub run build`. Install dependencies with nub. `nub.lock` is the lockfile. Do not add `package-lock.json`; nub stays in npm mode while that file exists.

## Why this is a JavaScript action

Publishing is a multipart upload with sha256 checks, retries, JSONC parsing, and archive inspection. Those belong in a tested program. A composite action would shell out to `curl` and `tar`, which is harder to test and easier to leak a token when the shell traces commands. Node 24 is the current GitHub Actions JavaScript runtime. Node 20 was removed from hosted runners on 2026-09-23.

Dependencies are `@actions/core` (inputs, outputs, masking, OIDC, job summary), `tar` (archive entries and listing), `minizlib` (gzip for the pack stream), and `ignore` (gitignore include/exclude patterns). Tegami (`tegami` 1.5.0) versions and releases the repository. The registry client uses `fetch`.

Packing does not use `tar.create`. That scheduler deadlocks on hardlinked trees and does not pause gzip when the file writer is full. `src/archive.ts` writes one entry at a time into a gzip stream that honors backpressure, then stores the `.tar.gz` in a temp file. `node --import tsx scripts/pack-large.mjs` packs a synthetic tree over 256 MiB uncompressed and checks that the gzip, sha256, and symlink entries come back. CI runs it as its own job.

## Releases

Do not publish this action to the Marketplace until a maintainer has reviewed it. Do not cut a tag by hand.

Tegami owns version bumps and GitHub releases. Add a changelog under `.tegami/` in the pull request. The explicit style names this package:

```md
---
packages:
  npm:alchemy-new-publish-action:
    type: patch
---

## What changed

One paragraph.
```

`type` is `major`, `minor`, or `patch`. From `0.0.0`, `major` becomes `1.0.0`. The package is private, so Tegami versions it and does not publish it to npm.

`.github/workflows/release.yml` runs `nub run tegami -- ci` on every push to `master`.

1. A push that adds changelog files versions the package and opens a pull request from `tegami/version-packages` onto `master`.
2. Merging that pull request leaves a publish lock on `master`. The next run creates the GitHub release and the immutable tag `alchemy-new-publish-action@1.2.3`. `scripts/action-release.mts` does that step. Tegami's npm publish does not run for this private package.

After Tegami creates a stable `1.x.y` tag, the same job moves the floating `v1` tag to that commit. Prereleases and other majors do not move `v1`. `v1` is not a GitHub Release. The semver tag is never force-pushed. `scripts/move-v1-tag.mts` pushes only when `GITHUB_ACTIONS` is set, and only `refs/tags/v1`.

Users pin `SolZeroAI/alchemy-new-publish-action@v1`. Until the first stable 1.x release, that tag does not exist; pin a commit SHA.
