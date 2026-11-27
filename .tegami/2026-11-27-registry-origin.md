---
packages:
  npm:alchemy-new-publish-action:
    type: patch
---

## What changed

The default registry origin is https://alchemy.new. The web host routes `/v1/*` to the API Worker, which has no hostname of its own. Pre is https://pre.alchemy.new. Set `registry-url` to publish there. The OIDC audience stays `https://alchemy.new/registry/publish`.
