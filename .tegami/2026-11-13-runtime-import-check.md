---
packages:
  npm:alchemy-new-publish-action:
    type: minor
---

## What changed

The action refuses an archive that imports a package the deploy cannot resolve. alchemy.new installs nothing and runs `alchemy deploy` from the archive, so a package that release CI pruned out of `devDependencies` fails the deploy with `Cannot find package`. The check names the missing package, the file that imports it, and the `package.json` that should list it under `dependencies`. Set `runtime-import-check` to `warn` or `off` to change this.
