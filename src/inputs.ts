import { DEFAULT_REGISTRY_URL } from "./constants.ts"
import { ActionError } from "./errors.ts"
import { isString } from "./record.ts"
import type { RuntimeImportCheck } from "./runtime-imports.ts"
import type { OnImmutable } from "./upload.ts"

interface ActionInputs {
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
  runtimeImportCheck: RuntimeImportCheck
}

export function parseList(value: string | readonly string[] | undefined): string[] {
  const lines = isString(value) || value === undefined ? (value ?? "").split(/\r?\n/) : value

  return lines.map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"))
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback

  if (value === "true" || value === "True" || value === "TRUE") return true

  if (value === "false" || value === "False" || value === "FALSE") return false
  throw new ActionError(`Input ${name} must be true or false. Received ${JSON.stringify(value)}.`)
}

function parseRuntimeImportCheck(value: string | undefined): RuntimeImportCheck {
  const mode = blank(value) ?? "error"

  if (mode === "error" || mode === "warn" || mode === "off") return mode
  throw new ActionError(
    `Input runtime-import-check must be "error", "warn", or "off". Received ${JSON.stringify(mode)}.`,
  )
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
  runtimeImportCheck?: string
}): ActionInputs {
  const onImmutable = blank(raw.onImmutable) ?? "skip-if-digest-matches"

  if (onImmutable !== "fail" && onImmutable !== "skip-if-digest-matches") {
    throw new ActionError(
      `Input on-immutable must be "fail" or "skip-if-digest-matches". Received ${JSON.stringify(onImmutable)}.`,
    )
  }

  const inputs: ActionInputs = {
    include: parseList(raw.include),
    exclude: parseList(raw.exclude),
    defaultExcludes: parseBoolean("default-excludes", raw.defaultExcludes, true),
    registryUrl: blank(raw.registryUrl) ?? DEFAULT_REGISTRY_URL,
    dryRun: parseBoolean("dry-run", raw.dryRun, false),
    onImmutable,
    runtimeImportCheck: parseRuntimeImportCheck(raw.runtimeImportCheck),
  }

  const packageInput = blank(raw.package)

  if (packageInput) inputs.packageInput = packageInput
  const org = blank(raw.org)

  if (org) inputs.org = org
  const project = blank(raw.project)

  if (project) inputs.project = project
  const version = blank(raw.version)

  if (version) inputs.version = version
  const archive = blank(raw.archive)

  if (archive) inputs.archive = archive
  const path = blank(raw.path)

  if (path) inputs.path = path
  const manifest = blank(raw.manifest)

  if (manifest) inputs.manifest = manifest
  const token = blank(raw.token)

  if (token) inputs.token = token

  return inputs
}
