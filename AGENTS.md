# AGENTS.md

## Voice

Use Simplified Technical English in formal, operational, and other sensible components of the document where you’re establishing specifics.
Use Plain Language in introductory, expository, friendly, and other sensible components of the document where you’re drawing the reader in or keeping them engaged.

## Repository

This repository is the GitHub Action `alchemy-new-publish-action`. It packs a ready archive and publishes it to the alchemy.new package registry. It is a library-style action, not an application.

- Do not add Alchemy, Effect, Cloudflare Workers, TanStack Start, Clerk, PlanetScale, drizzle, or turbo to this package.
- Prefer nub over node, tsx, npm, npx, pnpm, and yarn. Run a file with `nub <file>` and a script with `nub run`.
- Unit tests use Node's test runner through `nub run test`. Do not add tester-army/e2e, Vitest, Jest, or Playwright.
- The package is private. Tegami versions it and opens the GitHub release. Do not publish it to npm.
- After a change under `src/`, rebuild `dist/index.cjs` and run `nub run check-dist`.
- Do not print `anr_` tokens, `anu_` grants, or OIDC JWTs.
- Lint uses the shared `oxlint-plugin-solzero` config in `oxlint.config.ts`. Fix a violation instead of turning its rule off.
- Renovate opens dependency updates with the shared `SolZeroAI/renovate-config` preset. Do not add Dependabot version updates.
- Skills live in `.agents/skills`. `.claude/skills` links to them, and `skills-lock.json` records their sources.

## Pull requests

- Open a pull request as a draft. Keep the pull request in draft while you work.
- GitHub Actions does not run on a draft pull request. A draft reports the checks as skipped.
- Before each push, run lint, typecheck, and tests on your machine with `nub run check`. Run `actionlint` when it is available.
- When the work is done, mark the pull request ready for review. Do not leave a finished pull request in draft. Full CI runs when the pull request is ready.
