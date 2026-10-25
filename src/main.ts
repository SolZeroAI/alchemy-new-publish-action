import * as core from "@actions/core"
import { ActionError } from "./errors.ts"
import { parseActionInputs } from "./inputs.ts"
import { redact, redactingLogger } from "./log.ts"
import { publish } from "./publish.ts"

export async function run(): Promise<void> {
  try {
    const token = core.getInput("token")
    if (token) core.setSecret(token)
    const inputs = parseActionInputs({
      package: core.getInput("package"),
      org: core.getInput("org"),
      project: core.getInput("project"),
      version: core.getInput("version"),
      archive: core.getInput("archive"),
      path: core.getInput("path"),
      manifest: core.getInput("manifest"),
      include: core.getMultilineInput("include"),
      exclude: core.getMultilineInput("exclude"),
      defaultExcludes: core.getInput("default-excludes"),
      registryUrl: core.getInput("registry-url"),
      token,
      dryRun: core.getInput("dry-run"),
      onImmutable: core.getInput("on-immutable"),
    })
    const result = await publish({
      ...inputs,
      ...(process.env.GITHUB_REF ? { gitRef: process.env.GITHUB_REF } : {}),
      ...(process.env.GITHUB_WORKSPACE ? { workspace: process.env.GITHUB_WORKSPACE } : {}),
      getIdToken: (audience) => core.getIDToken(audience),
      mask: (secret) => {
        core.setSecret(secret)
      },
      log: redactingLogger({
        info: (message) => {
          core.info(message)
        },
        warn: (message) => {
          core.warning(message)
        },
      }),
      writeSummary: async (markdown) => {
        try {
          core.summary.addRaw(markdown)
          await core.summary.write({ overwrite: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          core.info(redact(markdown))
          core.info(`Could not write the job summary: ${message}`)
        }
      },
    })
    core.setOutput("version", result.version)
    core.setOutput("sha256", result.sha256)
    core.setOutput("manifest-sha256", result.manifestSha256)
    core.setOutput("size", String(result.sizeBytes))
    core.setOutput("size-bytes", String(result.sizeBytes))
    core.setOutput("file-count", String(result.fileCount))
    core.setOutput("url", result.url)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof Error && !(error instanceof ActionError) && error.stack) {
      core.info(redact(error.stack))
    }
    core.setFailed(redact(message))
  }
}
