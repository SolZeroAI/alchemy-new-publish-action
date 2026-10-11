# Publish to alchemy.new

GitHub Action that packs a ready-to-deploy archive and publishes an immutable version to the alchemy.new package registry.

alchemy.new deploys that archive into a visitor's cloud account. It does not install dependencies or build the app. The archive root is the package root. It must contain the deployment entrypoint and `node_modules/alchemy/bin/cli.js`. `alchemy.new.jsonc` is uploaded beside the archive, not inside it.

The action uses [OIDC trusted publishing](#trusted-publisher) unless you pass an `anr_` API token. It does not print credentials.

## Example

Build on `linux/amd64` (the deploy sandbox's platform), then publish. The version defaults to the git tag, with one leading `v` removed. `package` can be omitted when `alchemy.new.jsonc` already names `source.org` and `source.project`.

```yaml
name: Publish to alchemy.new

on:
  release:
    types: [published]
  push:
    tags:
      - "v[0-9]+.[0-9]+.[0-9]+"
      - "v[0-9]+.[0-9]+.[0-9]+-*"

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    name: Build and publish (linux/amd64)
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Setup Node
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
          cache: npm

      - name: Install and build
        run: |
          npm ci --omit=dev
          npm run build

      - name: Publish to alchemy.new
        uses: SolZeroAI/alchemy-new-publish-action@v1
        with:
          package: example-org/example-stack
          path: .
```

Install with the package manager the project actually uses, on `linux/amd64`, and omit dev dependencies. The Alchemy publisher guide uses `nub install --frozen-lockfile`. If the package manager keeps its store inside the project (pnpm and Yarn Berry do), that store has to be inside `path` so links still resolve after extract.

A prebuilt archive works too. `org` and `project` are separate inputs so the registry's example works unchanged:

```yaml
- uses: SolZeroAI/alchemy-new-publish-action@v1
  with:
    org: example-org
    project: example-stack
    version: 1.2.3
    archive: alchemy.new.tar.gz
```

`@v1` exists after the first stable release. Until then, pin a commit SHA.

## Trusted publisher

No long-lived registry secret is required.

1. Sign in at [alchemy.new](https://alchemy.new).
2. Open the [packages page](https://alchemy.new/packages) and create the org and the package.
3. Add a trusted publisher for this repository (`owner/name`). You can also restrict the workflow file name (for example `publish.yml`), the GitHub Environment, and the git ref.
4. Give the job `permissions: id-token: write`.

The action requests an OIDC token for `https://alchemy.new/registry/publish` and exchanges it at `POST /v1/oidc/github/exchange`. The registry returns a package-scoped `anu_` grant that expires in 15 minutes. That grant is not a long-lived secret, and this action does not store it.

## Token fallback

Use an `anr_` API token when the job cannot request an OIDC token. An admin mints it from the package page. It is shown once, it expires, and it can be revoked. It can publish that package (or every package in the org, if it was minted that way). It cannot mint tokens, change members, or yank versions.

```yaml
permissions:
  contents: read

steps:
  - uses: SolZeroAI/alchemy-new-publish-action@v1
    with:
      package: example-org/example-stack
      path: .
      token: ${{ secrets.ALCHEMY_NEW_TOKEN }}
```

Paste an `anr_` token only. An `anu_` grant cannot be pasted into `token`. The action masks the value with `::add-mask::` before it logs anything.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `package` | manifest `source` | `org/project`. Must match `alchemy.new.jsonc`. |
| `org` | manifest `source.org` | Registry org. Must match the manifest when both are set. |
| `project` | manifest `source.project` | Registry project. Must match the manifest when both are set. |
| `version` | git tag, then `source.version` | Exact semver without build metadata. A tag `v1.2.3` becomes `1.2.3`. |
| `archive` | | Prebuilt `.tar.gz` whose root is the package root. Mutually exclusive with `path`. |
| `path` | workspace, when `archive` is omitted | Directory to pack. |
| `manifest` | `alchemy.new.jsonc` at the package root | Raw manifest file. Uploaded separately. Comments are kept. At most 256 KB. |
| `include` | pack the directory | Newline-separated gitignore patterns. Only matching paths are considered. |
| `exclude` | | Extra gitignore patterns, dropped in addition to the defaults. |
| `default-excludes` | `true` | Drop VCS metadata, secrets, tests, caches, and dev junk. |
| `registry-url` | production API origin | API origin. The action appends `/v1/...`. |
| `token` | OIDC exchange | `anr_` API token. |
| `dry-run` | `false` | Validate and write the summary. Do not call the registry. |
| `on-immutable` | `fail` | `fail`, or `skip-if-digest-matches` when the archive sha256 matches and the manifest sha256 matches if the version record has one. |

`include` and `exclude` accept `#` comments on their own lines.

## Outputs

| Output | Description |
| --- | --- |
| `version` | Published version, without a leading `v`. |
| `sha256` | Lowercase hex sha256 of the archive. |
| `manifest-sha256` | Lowercase hex sha256 of the raw manifest bytes, including comments. |
| `size` | Archive size in bytes. |
| `url` | Deploy URL, `https://alchemy.new/?package=org/project&version=1.2.3`. |

The job summary lists the archive size, both digests, packed files, and paths the packer excluded. It also says `alchemy.new.jsonc` is not in the archive. A dry run sets the same outputs from the local files.

## What gets packed

Pass `archive` when the release job already built a `.tar.gz`. Otherwise the action packs `path`. The package root is the archive root. There is no wrapping directory.

The action does not install or prune dependencies. It refuses to upload an archive that fails the same checks the registry and the runner do:

- `alchemy.new.jsonc` is schema version 1, `source.kind` is `registry`, and `source` names this package. When `source.version` is set, it is the version being published
- the root `alchemy.new.jsonc` is not a member of the archive. Nested copies may stay. A prebuilt archive that contains a root copy fails before upload
- `deployment.entrypoint` present in the archive
- `node_modules/alchemy/bin/cli.js` present
- no `.git` or `.alchemy`
- no secret env file (`.env.example` and `.env.sample` may stay)
- no `.npmrc`
- no private key
- gzip, at most 256 MiB
- manifest at most 256 KB

A checkout's `.git` directory and a local `.env` are dropped while packing. A prebuilt archive that still contains them fails before upload. Setting `default-excludes: false`, or naming a secret in `include`, fails instead of uploading that file.

### Default excludes

These paths are left out of a packed archive when `default-excludes` is `true`. `include` does not pull a hard-rejected path back in. To pack a test fixture or other soft-excluded path, set `default-excludes: false` and pass the files in `include`. Hard-rejected files still fail the run, so also `exclude` anything you do not want to fail on, such as `.git`.

**Hard-rejected.** A packed tree drops them. A prebuilt archive that contains them fails. An `include` that selects them fails.

- `.git`, `.alchemy`, `.hg`, `.svn`
- `.env`, `.env.*` other than `.env.example` and `.env.sample`, `.envrc`, and files ending in `.env`
- `.npmrc`, `.netrc`
- `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, including inside `node_modules` (`.pub` files are not keys)
- `*.pem` outside `node_modules` (`node_modules/**/*.pem` may stay)
- `*.key`, `*.p12`, `*.pfx`, `*.p8` anywhere

**Also excluded by default.** A prebuilt archive may still contain these. Packing drops them.

- tests: `__tests__`, `__mocks__`, `test`, `tests`, `coverage`, `.nyc_output`, `.pytest_cache`, `*.test.*`, `*.spec.*`
- caches: `.cache`, `.turbo`, `.parcel-cache`, `.next/cache`
- editor and CI metadata: `.github`, `.circleci`, `.gitlab`, `.buildkite`, `.husky`, `.vscode`, `.idea`, `.aws`
- junk: `.DS_Store`, `Thumbs.db`, `.eslintcache`, `.stylelintcache`, `*.log`, `*.tsbuildinfo`, `*.tar.gz`, `*.tgz`, `.gitmodules`

Symlinks are stored as symlinks. That is what pnpm and nub need inside `node_modules`. A symlink whose target is absolute, or whose normalized target leaves the package root, fails the run and nothing is uploaded. A symlink that points at a forbidden path, such as `.env` or `.git`, fails the same way. The store the links point at has to be inside `path`.

Packing writes a temporary `.tar.gz` on disk. File bytes are read and compressed into that file; the archive is not buffered in memory. The sha256 and the multipart upload then read the file back. Archives over 80 MiB produce a warning. Packing stops once the gzip passes 256 MiB, before upload.

## Immutable versions

Publishing the same version again is a conflict. The action looks up the version first.

- The archive sha256 differs, or the version record includes a manifest sha256 that differs: the run fails and prints the digests. Publish a new version.
- The digests match and `on-immutable` is `fail`: the run fails and tells you the bytes are already published.
- The digests match and `on-immutable` is `skip-if-digest-matches`: the run succeeds, sets outputs from that version, and does not upload. A version record with no `manifestSha256` is compared on the archive digest only.
- A yanked version is still immutable. The message says it cannot be replaced and will not deploy.

```yaml
with:
  on-immutable: skip-if-digest-matches
```

## Dry run

`dry-run: true` packs, validates, hashes, prints the file list, and writes the job summary. It does not exchange a token or call the registry. `id-token: write` is not required.

## Registry calls

| Step | Request |
| --- | --- |
| Exchange a GitHub OIDC token | `POST /v1/oidc/github/exchange` with `{ token, org, project }` and no `Authorization` header |
| See whether the version exists | `GET /v1/packages/{org}/{project}/versions/{version}` |
| Start a multipart upload | `POST /v1/packages/{org}/{project}/versions/{version}/uploads` |
| Upload the manifest | `PUT .../uploads/{uploadId}/manifest` with the raw file bytes and `Content-Type: application/json` |
| Upload each part | `PUT .../uploads/{uploadId}/parts/{partNumber}` with `Content-Type: application/octet-stream` |
| Finish | `POST .../complete` with `{ sha256, manifestSha256, parts: [{ partNumber, etag }] }` |
| Give up after a failed upload | `POST .../abort` |

The manifest goes up after the upload starts and before the parts. A second PUT before complete would replace it. Complete without a manifest returns `manifest_required`. Parts use the `partSize` from the start response. A small archive is one part. Every part is at most 8 MiB, and every part except the last is at least 5 MiB. Transient HTTP 408, 429, 500, 502, 503, and 504 responses, and network failures, retry up to four times with backoff. A `Retry-After` header is honored. Both digests are computed locally and sent on complete. The registry hashes the objects again.

This action does not yank, deprecate, mint tokens, or submit a listing. `POST /v1/registry/submissions` is a separate review step and does not use this credential.

## Contract notes

The publish contract calls the base URL "the alchemy.new API origin" and does not name a host. `https://alchemy.new` is the website. A request to `https://alchemy.new/v1/...` returns HTTP 500 `{"error":"Only HTML requests are supported here"}`. The live web app calls `https://alchemy-new-api-prod.jonbeckman.workers.dev`, so that origin is the default `registry-url`. The deploy URL stays on `https://alchemy.new`.

That production worker's OpenAPI document, as fetched while this action was written, does not list `/v1/oidc/github/exchange` or `/v1/packages/...` yet. Those routes are the unpublished registry contract this action implements. `GET /v1/packages/example-org/example-stack` on that host returned an empty 404. Nothing here was uploaded to a live registry.

Other readings, where the contract was loose:

- The version lookup response body is not specified. The action treats a 200 as the same version record that complete returns, including `sha256`, `manifestSha256`, and `yanked`. A record without a sha256 cannot be skipped. A record without `manifestSha256` can be skipped when the archive sha256 matches, because that digest is not there to compare. A record that includes a different manifest sha256 cannot be skipped.
- Schema version is 1. There is no schema v2. The attached project schema's `source` list names GitHub releases and npm only, while the registry API requires `source.kind` of `registry` for this publish. The publisher skill's compatibility note still says to use schema version 2 and that version 1 is retired. This action follows the registry API: schema version 1 and a registry source. It does not require a particular `$schema` URL. The skill uses `https://alchemy.new/schema/project.json`. The schema document's id is `https://alchemy.new/schema/v1/project.json`.
- `immutable_version` is specified as the result of publishing an existing version, not which call returns it. The action handles it on the version lookup, on start, and on complete.
- There is no list-parts call. A dropped connection retries the current part, then aborts the upload. A later job starts a new upload.
- The exchange example sends the GitHub JWT in the JSON body. The action does not also send it as `Authorization`, because that header is an `anr_` or `anu_` credential.
- Part bodies are slices of the gzip file, so the part `Content-Type` is `application/octet-stream`. The contract allows that or `application/gzip`. The stored object is `application/gzip`.
- "Private key names" is not an exhaustive list. The action rejects `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `*.key`, `*.p12`, `*.pfx`, and `*.p8` everywhere, plus `*.pem` outside `node_modules`. It also rejects `.netrc`, `.envrc`, and `*.env`. `.env.example` and `.env.sample` are the only env-file exceptions.
- `source.version` is optional. When it is set, it must be the version being published. A mismatch fails before upload, because a published version cannot be replaced.
- One-click parameter checks belong to listing review, not to this upload.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). The action is JavaScript for Node 24, bundled to `dist/index.cjs`. Dependencies install with nub. CI typechecks, lints, tests, and fails if the bundle is stale. It also dry-runs the bundle against `fixtures/ready-package`, checks that a prebuilt archive containing `.git` is rejected, and checks that a prebuilt archive with `alchemy.new.jsonc` at its root is rejected. Releases are cut by Tegami on `master`. The floating `v1` tag moves only for a stable 1.x release.

[Security reports](SECURITY.md) go through GitHub private vulnerability reporting.
