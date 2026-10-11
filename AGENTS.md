# AGENTS.md

## Voice

Use Simplified Technical English in formal, operational, and other sensible components of the document where you’re establishing specifics.
Use Plain Language in introductory, expository, friendly, and other sensible components of the document where you’re drawing the reader in or keeping them engaged.

## Repository

This repository is the GitHub Action `alchemy-new-publish-action`. It packs a ready archive and publishes it to the alchemy.new package registry. It is a library-style action, not an application.

- Do not add Alchemy, Effect, Cloudflare Workers, TanStack Start, Clerk, PlanetScale, drizzle, or turbo to this package.
- Unit tests use Node's test runner (`node --import tsx --test`). Do not add tester-army/e2e, Vitest, Jest, or Playwright.
- The package is private. Tegami versions it and opens the GitHub release. Do not publish it to npm.
- After a change under `src/`, rebuild `dist/index.cjs` and run `nub run check-dist`.
- Do not print `anr_` tokens, `anu_` grants, or OIDC JWTs.
