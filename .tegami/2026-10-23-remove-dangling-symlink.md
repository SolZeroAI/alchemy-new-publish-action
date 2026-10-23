---
packages:
  npm:alchemy-new-publish-action:
    type: patch
---

## What changed

The 1.0.1 release failed to download on runners because of a dangling tracked symlink. That symlink is removed.
