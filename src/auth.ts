import { OIDC_AUDIENCE } from "./constants.ts"
import { ActionError } from "./errors.ts"
import type { Logger } from "./log.ts"
import type { RegistryClient } from "./registry.ts"

export async function authorize(options: {
  token?: string
  org: string
  project: string
  client: RegistryClient
  getIdToken?: (audience: string) => Promise<string>
  mask: (secret: string) => void
  log: Logger
}): Promise<string> {
  if (options.token) {
    options.mask(options.token)
    if (!options.token.startsWith("anr_")) {
      throw new ActionError(
        "The token input must be an alchemy.new API token starting with anr_. Short-lived anu_ grants are created by the OIDC exchange and cannot be pasted here.",
      )
    }
    options.log.info("Using the anr_ API token. OIDC exchange was skipped.")
    return options.token
  }

  if (!options.getIdToken) {
    throw new ActionError(
      "No API token was provided and OIDC is unavailable. Set permissions: id-token: write, or pass an anr_ token.",
    )
  }

  let jwt: string
  try {
    jwt = await options.getIdToken(OIDC_AUDIENCE)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionError(
      `Could not obtain a GitHub OIDC token for ${OIDC_AUDIENCE}. Set permissions: id-token: write, or pass an anr_ token. ${message}`.trim(),
    )
  }
  options.mask(jwt)
  const grant = await options.client.exchangeOidc({
    token: jwt,
    org: options.org,
    project: options.project,
  })
  options.mask(grant.token)
  if (!grant.token.startsWith("anu_")) {
    throw new ActionError("OIDC exchange returned a credential that is not an anu_ upload grant.")
  }
  options.log.info(
    `OIDC exchange issued a package-scoped upload grant for ${options.org}/${options.project} expiring at ${grant.expiresAt}.`,
  )
  return grant.token
}
