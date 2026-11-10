import { ActionError } from "./errors.ts"
import { parseJsonc } from "./jsonc.ts"
import { canonicalVersion } from "./semver.ts"
import { isRecord, isString, requiredString, type JsonObject } from "./record.ts"
import { normalizeRelPath } from "./paths.ts"
import { MAX_MANIFEST_BYTES } from "./constants.ts"

const PROVIDERS = new Set(["cloudflare", "aws", "other"])

export interface Manifest {
  schemaVersion: 1
  id: string
  name: string
  description: string
  publisherName: string
  source: {
    org: string
    project: string
    version?: string
  }
  entrypoint: string
}

const MAX_TAGS = 3
const MAX_TAG_LENGTH = 24
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * The registry rejects a release whose `tags` break these limits: at most 3 unique tags,
 * each at most 24 lowercase letters, digits, and single hyphens.
 */
function checkTags(manifest: JsonObject, filename: string) {
  const tags = manifest.tags

  if (tags === undefined) return

  const names = Array.isArray(tags) ? tags.filter(isString) : []

  if (!Array.isArray(tags) || names.length !== tags.length) {
    throw new ActionError(`${filename} tags must be an array of strings.`)
  }

  if (names.length > MAX_TAGS) {
    throw new ActionError(`${filename} tags lists ${names.length} tags. The limit is ${MAX_TAGS}.`)
  }

  const invalid = names.filter((tag) => tag.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(tag))

  if (invalid.length > 0) {
    throw new ActionError(
      `${filename} tags must be at most ${MAX_TAG_LENGTH} lowercase letters, digits, and single hyphens. Invalid: ${invalid.join(", ")}.`,
    )
  }

  if (new Set(names).size !== names.length) {
    throw new ActionError(`${filename} tags must be unique.`)
  }
}

const KNOWN_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "id",
  "name",
  "description",
  "icon",
  "publisher",
  "source",
  "deployment",
  "parameters",
  "tags",
  "website",
])

/**
 * Parse and check the fields the registry and runner require.
 * Schema version is 1. `source.kind` must be `registry`.
 */
export function parseManifest(text: string, filename = "alchemy.new.jsonc"): Manifest {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
    throw new ActionError(
      `${filename} is ${Buffer.byteLength(text)} bytes, above the 256 KB manifest limit (${MAX_MANIFEST_BYTES}). The registry returns manifest_too_large.`,
    )
  }

  let value: unknown

  try {
    value = parseJsonc(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionError(`Could not parse ${filename}: ${message}`)
  }

  if (!isRecord(value)) {
    throw new ActionError(`${filename} must be a JSON object.`)
  }

  const unknown = Object.keys(value).filter((key) => !KNOWN_KEYS.has(key))

  if (unknown.length > 0) {
    throw new ActionError(
      `${filename} has unknown fields: ${unknown.join(", ")}. Schema v1 does not allow additional properties, and a published version cannot be replaced.`,
    )
  }

  if (value.schemaVersion !== 1) {
    throw new ActionError(`${filename} schemaVersion must be 1.`)
  }

  if (value.icon !== undefined && !isString(value.icon)) {
    throw new ActionError(`${filename} icon must be an https:// URL string.`)
  }

  checkTags(value, filename)

  const publisher = value.publisher

  if (!isRecord(publisher)) {
    throw new ActionError(`${filename} publisher must be an object with a name.`)
  }

  const source = value.source

  if (!isRecord(source)) {
    throw new ActionError(`${filename} source must be an object.`)
  }

  if (source.kind !== "registry") {
    throw new ActionError(
      `${filename} source.kind must be "registry". GitHub releases and npm are not deploy sources.`,
    )
  }

  const deployment = value.deployment

  if (!isRecord(deployment)) {
    throw new ActionError(`${filename} deployment must be an object.`)
  }

  if (!Array.isArray(value.parameters)) {
    throw new ActionError(
      `${filename} parameters must be an array. Use [] when the stack needs no project env.`,
    )
  }

  const providers = deployment.providers

  if (
    !Array.isArray(providers) ||
    providers.some((item) => !isString(item) || !PROVIDERS.has(item))
  ) {
    throw new ActionError(
      `${filename} deployment.providers must be an array of "cloudflare", "aws", or "other".`,
    )
  }

  const defaultProvider = deployment.defaultProvider

  if (!isString(defaultProvider) || !PROVIDERS.has(defaultProvider)) {
    throw new ActionError(
      `${filename} deployment.defaultProvider must be "cloudflare", "aws", or "other".`,
    )
  }

  requiredString(deployment, "defaultStage", `${filename} deployment`)

  const entrypointRaw = requiredString(deployment, "entrypoint", `${filename} deployment`)
  const entrypoint = normalizeRelPath(entrypointRaw)

  if (!entrypoint) {
    throw new ActionError(
      `${filename} deployment.entrypoint must be a relative path inside the package. Received ${JSON.stringify(entrypointRaw)}.`,
    )
  }

  let sourceVersion: string | undefined
  const sourceVersionValue = source.version

  if (sourceVersionValue !== undefined) {
    if (!isString(sourceVersionValue) || sourceVersionValue.trim() === "") {
      throw new ActionError(`${filename} source.version must be exact semver when it is set.`)
    }

    sourceVersion = canonicalVersion(sourceVersionValue, "source.version")
  }

  const parsedSource: Manifest["source"] = {
    org: requiredString(source, "org", `${filename} source`),
    project: requiredString(source, "project", `${filename} source`),
  }

  if (sourceVersion) parsedSource.version = sourceVersion

  return {
    schemaVersion: 1,
    id: requiredString(value, "id", filename),
    name: requiredString(value, "name", filename),
    description: requiredString(value, "description", filename),
    publisherName: requiredString(publisher, "name", `${filename} publisher`),
    source: parsedSource,
    entrypoint,
  }
}
