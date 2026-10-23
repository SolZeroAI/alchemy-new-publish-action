---
packages:
  npm:alchemy-new-publish-action:
    type: patch
---

## What changed

Packing rewrites an absolute symlink whose target stays inside the package root into the equivalent relative symlink in the archive. The link on disk is not changed. A symlink that leaves the package root, or that points at a forbidden path, still fails the run.
