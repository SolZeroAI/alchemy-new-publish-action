# Security

Report a vulnerability in this action through GitHub private vulnerability reporting on [SolZeroAI/alchemy-new-publish-action](https://github.com/SolZeroAI/alchemy-new-publish-action). Please do not open a public issue for a token leak, an archive that can smuggle a secret, or a publishing bypass.

The action masks `anr_` API tokens, `anu_` upload grants, and GitHub OIDC tokens with `::add-mask::` before it logs. Do not add debug output that prints request headers or credential values.

`anr_` tokens are long-lived publish credentials. Store them in GitHub Actions secrets if you use the token fallback, and revoke them from the package page when they are no longer needed. Prefer OIDC trusted publishing so the workflow does not hold a long-lived registry secret.
