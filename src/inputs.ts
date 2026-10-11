import { DEFAULT_REGISTRY_URL } from "./constants.ts"
import { ActionError } from "./errors.ts"
import type { OnImmutable } from "./upload.ts"

export interface ActionInputs {
  packageInput?: string
  org?: string
  project?: string
  version?: string
  archive?: string
  path?: string
  manifest?: string
  include: string[]
  exclude: string[]
  defaultExcludes: boolean
  registryUrl: string
  token?: string
  dryRun: boolean
  onImmutable: OnImmutable
}

export function parseList(value: string | readonly string[] | undefined): string[] {
  const lines =
    typeof value === "string" || value === undefined ? (value ?? "").split(/\r?\n/) : value
  return lines.map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"))
}

export function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback
  if (value === "true" || value === "True" || value === "TRUE") return true
  if (value === "false" || value === "False" || value === "FALSE") return false
  throw new ActionError(`Input ${name} must be true or false. Received ${JSON.stringify(value)}.`)
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

export function parseActionInputs(raw: {
  package?: string
  org?: string
  project?: string
  version?: string
  archive?: string
  path?: string
  manifest?: string
  include?: string | readonly string[]
  exclude?: string | readonly string[]
  defaultExcludes?: string
  registryUrl?: string
  token?: string
  dryRun?: string
  onImmutable?: string
}): ActionInputs {
  const onImmutable = blank(raw.onImmutable) ?? "fail"
  if (onImmutable !== "fail" && onImmutable !== "skip-if-digest-matches") {
    throw new ActionError(
      `Input on-immutable must be "fail" or "skip-if-digest-matches". Received ${JSON.stringify(onImmutable)}.`,
    )
  }
  return {
    ...(blank(raw.package) ? { packageInput: blank(raw.package) } : {}),
    ...(blank(raw.org) ? { org: blank(raw.org) } : {}),
    ...(blank(raw.project) ? { project: blank(raw.project) } : {}),
    ...(blank(raw.version) ? { version: blank(raw.version) } : {}),
    ...(blank(raw.archive) ? { archive: blank(raw.archive) } : {}),
    ...(blank(raw.path) ? { path: blank(raw.path) } : {}),
    ...(blank(raw.manifest) ? { manifest: blank(raw.manifest) } : {}),
    include: parseList(raw.include),
    exclude: parseList(raw.exclude),
    defaultExcludes: parseBoolean("default-excludes", raw.defaultExcludes, true),
    registryUrl: blank(raw.registryUrl) ?? DEFAULT_REGISTRY_URL,
    ...(blank(raw.token) ? { token: blank(raw.token) } : {}),
    dryRun: parseBoolean("dry-run", raw.dryRun, false),
    onImmutable,
  }
}
