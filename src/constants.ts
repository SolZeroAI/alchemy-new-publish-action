/** OIDC audience. The registry rejects any other value. */
export const OIDC_AUDIENCE = 'https://alchemy.new/registry/publish'

/**
 * Production API origin.
 * The publish contract says the base URL is the alchemy.new API origin and
 * does not name a host. https://alchemy.new serves the website and rejects
 * `/v1` calls. The live web app calls this Worker. Override with `registry-url`.
 */
export const DEFAULT_REGISTRY_URL = 'https://alchemy-new-api-prod.jonbeckman.workers.dev'

/** Public deploy site. Distinct from the API origin. */
export const DEPLOY_SITE = 'https://alchemy.new'

export const MANIFEST_FILENAME = 'alchemy.new.jsonc'
export const CLI_PATH = 'node_modules/alchemy/bin/cli.js'

/** Raw `alchemy.new.jsonc` upload cap. The registry returns `manifest_too_large` above this. */
export const MAX_MANIFEST_BYTES = 256 * 1024

const MIB = 1024 * 1024

/** Contract cap. The start-upload response echoes this as maxBytes. */
export const MAX_ARCHIVE_BYTES = 256 * MIB

/** Every part is at most this size. */
export const MAX_PART_BYTES = 8 * MIB

/** Every part except the last is at least this size. */
export const MIN_PART_BYTES = 5 * MIB

/** Publisher guide target. Over this we warn; over 256 MiB we fail. */
export const RECOMMENDED_ARCHIVE_BYTES = 80 * MIB

export const USER_AGENT = 'alchemy-new-publish-action'
