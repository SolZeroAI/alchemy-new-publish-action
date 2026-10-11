#!/usr/bin/env bash
# Point the moving major tag (v1) at a stable semver release.
# The semver tag itself is never force-pushed.
set -euo pipefail

tag="${TAG:?TAG is required}"

if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Refusing to move major tags for non-semver ref: ${tag}" >&2
  exit 1
fi

major="v${BASH_REMATCH[1]}"
prerelease="${BASH_REMATCH[4]:-}"

head_sha="$(git rev-parse HEAD)"
tagged_sha="$(git rev-parse "refs/tags/${tag}^{}")"
if [[ "$head_sha" != "$tagged_sha" ]]; then
  echo "HEAD ${head_sha} is not ${tag} (${tagged_sha})." >&2
  exit 1
fi

if [[ -n "$prerelease" || "${PRERELEASE:-}" == "true" ]]; then
  echo "Prerelease ${tag} stays immutable. Not moving ${major}."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git tag -fa "$major" -m "Update ${major} to ${tag}"

# Push only the moving major tag. The semver tag is immutable.
git push origin "refs/tags/${major}:refs/tags/${major}" --force
echo "Moved ${major} to ${tag} (${head_sha})."
