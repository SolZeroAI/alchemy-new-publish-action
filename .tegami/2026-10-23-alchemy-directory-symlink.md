---
packages:
  npm:alchemy-new-publish-action:
    type: patch
---

## Alchemy package links

When `node_modules/alchemy` is a directory symlink into the package, the archive gets a relative symlink for each file under it. An absolute link is included when its target stays inside the package root. `node_modules/alchemy/bin/cli.js` is then its own member. A target that leaves the package root, or that points at a forbidden path, still fails the run.
