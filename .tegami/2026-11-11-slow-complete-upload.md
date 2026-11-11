---
packages:
  npm:alchemy-new-publish-action:
    type: patch
---

## What changed

The action now waits up to 5 minutes for the registry to finish an upload. The registry reads and checks the whole archive before it answers, and an 80 MB archive can take more than 30 seconds. Before this change, the action stopped waiting after 30 seconds, and the retry failed with "The specified multipart upload does not exist".

If completing the upload reports an error but the registry already holds the version with the same archive and manifest digests, the action reports a successful publish.
