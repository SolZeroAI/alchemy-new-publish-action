# Contributing

This repository is a JavaScript action. The runner starts `dist/index.cjs` with Node 24. Source lives in `src/` and is bundled with esbuild as CommonJS, because `@actions/core` loads Node builtins through `require`. The package itself is ESM so tests can import `src/` directly. The `.cjs` extension keeps the bundle CommonJS.

Local development and CI use Node `24.15.0` (`engines` is `>=24.15.0 <25`). The action runtime stays `node24`. The package manager is nub `0.9.6` (`packageManager` and `devEngines.packageManager`). That is an intentional lead on the Shared Project DNA pin, which is nub `0.4.11`.

```sh
nub install --frozen-lockfile
nub run check
nub run check-dist
node scripts/ci-dry-run.mjs
node --import tsx scripts/pack-large.mjs
```

`nub run check` typechecks, runs oxlint, checks formatting with oxfmt, runs the unit tests, and builds `dist/index.cjs`. Commit `dist/index.cjs` with the source change. CI rejects a pull request whose bundle does not match `nub run build`.

`nub.lock` is the lockfile. Do not add `package-lock.json`; nub stays in npm mode while that file exists. Do not add ESLint, Prettier, Biome, or dprint. Lint and format are oxlint `1.87.0` and oxfmt `0.72.0`. `anti-slop` is installed from `github:dmmulroy/anti-slop` and its rules are warnings until a cleanup pull request.

## Why this is a JavaScript action

Publishing is a multipart upload with sha256 checks, retries, JSONC parsing, and archive inspection. Those belong in a tested program. A composite action would shell out to `curl` and `tar`, which is harder to test and easier to leak a token when the shell traces commands. Node 24 is the current GitHub Actions JavaScript runtime. Node 20 was removed from hosted runners on 2026-09-23.

Dependencies are `@actions/core` (inputs, outputs, masking, OIDC, job summary), `tar` (archive entries and listing), `minizlib` (gzip for the pack stream), and `ignore` (gitignore include/exclude patterns). Tegami (`tegami` 1.5.0) versions and releases the repository. The registry client uses `fetch`.

Packing does not use `tar.create`. That scheduler deadlocks on hardlinked trees and does not pause gzip when the file writer is full. `src/archive.ts` writes one entry at a time into a gzip stream that honors backpressure, then stores the `.tar.gz` in a temp file. `node --import tsx scripts/pack-large.mjs` packs a synthetic tree over 256 MiB uncompressed and checks that the gzip, sha256, and symlink entries come back. CI runs it as its own job.

## Releases

Do not publish this action to the Marketplace until a maintainer has reviewed it. Do not cut a tag by hand. Do not bump `package.json` or `VERSION` in a feature pull request. Tegami writes both when it versions the package.

Tegami owns version bumps and GitHub releases. `scripts/tegami.mts` is the config. `nub run tegami` runs it. Add a changelog under `.tegami/` when the published action has an observable change. The explicit style names this package:

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

When a pull request does not change the published action, add the GitHub label `release:none` and do not add a `.tegami/` entry. The label has to exist on the repository before Tegami will honor it.

`.github/workflows/release.yml` runs after the Validate workflow succeeds on a push to `master`. The job mints a GitHub App installation token with `actions/create-github-app-token`, pinned by commit SHA. Secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` identify the app. The token is limited to this repository and requests contents write and pull requests write. Checkout and `nub run tegami ci` use that token. The floating `v1` tag move uses the same token.

1. A push that adds changelog files versions the package, writes `VERSION`, and opens a pull request from `tegami/version-packages` onto `master`. The app opens that pull request, so GitHub starts Validate and Tegami PR Preview.
2. Merging that pull request leaves a publish lock on `master`. The next run creates the GitHub release and the immutable tag `alchemy-new-publish-action@1.2.3`. `scripts/action-release.mts` does that step. Tegami's npm publish does not run for this private package.

After Tegami creates a stable `1.x.y` tag, the same job moves the floating `v1` tag to that commit. Prereleases and other majors do not move `v1`. `v1` is not a GitHub Release. The semver tag is never force-pushed. `scripts/move-v1-tag.mts` pushes only when `GITHUB_ACTIONS` is set, and only `refs/tags/v1`. Validate runs on a push to the `master` branch and on a pull request into `master`. A tag push is outside that trigger, so moving `v1` does not start another release.

Pull requests also run Tegami PR Preview, which uploads a release note artifact. Tegami PR Comment posts that note from a trusted checkout of the default branch. The preview job does not receive a token that can write to the repository.

Users pin `SolZeroAI/alchemy-new-publish-action@v1`. Until the first stable 1.x release, that tag does not exist; pin a commit SHA.
