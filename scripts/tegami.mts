import { tegami } from "tegami"
import { runCli } from "tegami/cli"
import { github } from "tegami/plugins/github"
import { actionRelease } from "./action-release.mts"

const repository = process.env.GITHUB_REPOSITORY?.trim() || "SolZeroAI/alchemy-new-publish-action"

const release = tegami({
  conventionalCommits: false,
  npm: {
    client: "nub",
    updateLockFile: false,
  },
  plugins: [
    // github() opens the version pull request. The package is private, so Tegami
    // does not publish it to npm. release: false keeps this plugin from
    // registering a release task. actionRelease() creates the GitHub release
    // and the name@version tag from the publish lock.
    github({
      repo: repository,
      release: false,
      versionPr: {
        base: "master",
        branch: "tegami/version-packages",
      },
    }),
    actionRelease(),
  ],
})

await runCli(release)
