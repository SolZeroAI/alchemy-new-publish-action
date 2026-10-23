---
packages:
  npm:alchemy-new-publish-action:
    type: patch
---

## Default pack excludes

Packing drops `.agents`, `.cursor`, `.claude`, `.tegami`, and `.changeset` at any depth. Inside `node_modules` only, packing also drops `*.d.ts`, `*.map`, and `*.md`. Markdown outside `node_modules` stays in the archive.
