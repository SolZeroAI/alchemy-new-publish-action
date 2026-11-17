#!/usr/bin/env bash
set -euo pipefail

# nub installs the Node pin from package.json and .nvmrc. The nub installer is a
# static binary, so this script does not install nvm or Node first.
nub_version="$(sed -n 's/^[[:space:]]*"packageManager": "nub@\([^"]*\)".*/\1/p' package.json)"

if [ -z "$nub_version" ]; then
  echo "package.json packageManager must be nub@<version>." >&2
  exit 1
fi

export PATH="$HOME/.nub/bin:$PATH"

installed="$(nub --version 2>/dev/null | awk 'NR==1{print $1}' | tr -d 'v' || true)"

if [ "$installed" != "$nub_version" ]; then
  curl -fsSL https://nubjs.com/install.sh | bash -s "$nub_version"
  export PATH="$HOME/.nub/bin:$PATH"
  hash -r
fi

nub install --frozen-lockfile
