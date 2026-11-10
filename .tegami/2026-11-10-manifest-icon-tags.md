---
packages:
  npm:alchemy-new-publish-action:
    type: minor
---

## What changed

The action now accepts the optional manifest `icon` field, an `https://` URL of a square image. alchemy.new shows it as the package icon. Before this change, the action rejected a manifest with `icon` as an unknown field.

The action now checks manifest `tags` before it packs: at most 3 unique tags, each at most 24 lowercase letters, digits, and single hyphens. The registry rejects a release that breaks this rule, so a dry run now reports the problem first.
