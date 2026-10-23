---
packages:
  npm:alchemy-new-publish-action:
    type: patch
---

## What changed

`on-immutable` now defaults to `skip-if-digest-matches`. When the same package version already exists with the same archive digest, and the same manifest digest when the version record has one, the publish succeeds and uploads nothing. The job summary says the publish was skipped. A different digest for that version still fails. Set `on-immutable` to `fail` to stop the run when the version already exists.
