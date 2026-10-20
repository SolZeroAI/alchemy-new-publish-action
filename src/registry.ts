import { USER_AGENT } from "./constants.ts"
import { ActionError, RegistryError } from "./errors.ts"
import type { Logger } from "./log.ts"
import { silentLogger, redact } from "./log.ts"
import { isRecord, stringField } from "./record.ts"
import { withRetry, type Sleep, sleep } from "./retry.ts"

export interface VersionRecord {
  org: string
  project: string
  version: string
  sha256: string
  /** Present when the version record exposes the manifest digest. */
  manifestSha256?: string
  sizeBytes: number
  contentType?: string
  yanked: boolean
  publishedAt?: string
}

interface UploadSession {
  uploadId: string
  partSize: number
  maxBytes: number
  expiresAt?: string
  contentType?: string
}

interface PartResult {
  partNumber: number
  etag: string
  sizeBytes: number
}

interface CompletedPart {
  partNumber: number
  etag: string
}

export interface RegistryClient {
  setToken(token: string): void
  exchangeOidc(input: {
    token: string
    org: string
    project: string
  }): Promise<{ token: string; expiresAt: string; org: string; project: string }>
  getVersion(org: string, project: string, version: string): Promise<VersionRecord | undefined>
  startUpload(org: string, project: string, version: string): Promise<UploadSession>
  uploadPart(input: {
    org: string
    project: string
    version: string
    uploadId: string
    partNumber: number
    body: Buffer
  }): Promise<PartResult>
  uploadManifest(input: {
    org: string
    project: string
    version: string
    uploadId: string
    body: Buffer
  }): Promise<{ sha256: string; sizeBytes: number; contentType?: string }>
  completeUpload(input: {
    org: string
    project: string
    version: string
    uploadId: string
    sha256: string
    manifestSha256: string
    parts: CompletedPart[]
  }): Promise<VersionRecord>
  abortUpload(org: string, project: string, version: string, uploadId: string): Promise<void>
}

interface RegistryClientOptions {
  registryUrl: string
  fetchImpl?: typeof fetch
  log?: Logger
  sleep?: Sleep
}

export function normalizeRegistryUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new ActionError(`registry-url ${JSON.stringify(input)} is not an absolute URL.`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ActionError("registry-url must be http or https.")
  }
  if (url.username || url.password) {
    throw new ActionError("registry-url must not include credentials.")
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ActionError(
      "registry-url must be the API origin without a path. The action appends /v1/....",
    )
  }
  if (url.search || url.hash) {
    throw new ActionError("registry-url must not include a query or hash.")
  }
  return url.origin
}

function packageVersionPath(org: string, project: string, version: string): string {
  return `/v1/packages/${encodeURIComponent(org)}/${encodeURIComponent(project)}/versions/${encodeURIComponent(version)}`
}

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? silentLogger
  const sleepFn = options.sleep ?? sleep
  let token = ""

  async function request(
    method: string,
    path: string,
    init: {
      json?: unknown
      body?: Buffer
      contentType?: string
      timeoutMs?: number
      auth?: boolean
    } = {},
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const headers = new Headers()
    headers.set("Accept", "application/json")
    headers.set("User-Agent", USER_AGENT)
    if (init.auth !== false && token) headers.set("Authorization", `Bearer ${token}`)
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.body
    if (init.json !== undefined) {
      headers.set("Content-Type", "application/json")
    } else if (init.contentType) {
      headers.set("Content-Type", init.contentType)
    }
    if (typeof body === "string") headers.set("Content-Length", String(Buffer.byteLength(body)))
    if (Buffer.isBuffer(body)) headers.set("Content-Length", String(body.length))
    let response: Response
    try {
      response = await fetchImpl(`${options.registryUrl}${path}`, {
        method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/redirect/i.test(message)) {
        throw new RegistryError(
          "The registry URL redirected. The action does not follow redirects with credentials.",
          0,
        )
      }
      throw error
    }
    const text = await response.text()
    return { status: response.status, headers: response.headers, text: text.slice(0, 8000) }
  }

  function fail(status: number, text: string, headers: Headers, context: string): never {
    const parsed = parseErrorBody(text)
    const retryAfterMs = parseRetryAfter(headers.get("retry-after"))
    const code = parsed?.code
    const detail = parsed?.message ?? (text.trim() || "empty response")
    throw new RegistryError(
      redact(`${context}: ${explain(status, code, detail)}`),
      status,
      code,
      retryAfterMs,
    )
  }

  return {
    setToken(next: string) {
      token = next
    },
    async exchangeOidc(input) {
      // The contract puts the GitHub JWT in the JSON body. Do not also send it
      // as Authorization: the registry would treat that header as an anr_/anu_ credential.
      const run = () =>
        request("POST", "/v1/oidc/github/exchange", {
          json: { token: input.token, org: input.org, project: input.project },
          auth: false,
        })
      const response = await withRetry(
        "OIDC exchange",
        async () => {
          const result = await run()
          if (result.status !== 200) {
            fail(result.status, result.text, result.headers, "OIDC exchange failed")
          }
          return result
        },
        log,
        sleepFn,
      )
      const body = parseJson(response.text, "OIDC exchange")
      const grant = stringField(body, "token")
      const expiresAt = stringField(body, "expiresAt")
      if (!grant || !expiresAt) {
        throw new RegistryError("OIDC exchange returned no token or expiresAt.", response.status)
      }
      return {
        token: grant,
        expiresAt,
        org: stringField(body, "org") ?? input.org,
        project: stringField(body, "project") ?? input.project,
      }
    },
    async getVersion(org, project, version) {
      const path = packageVersionPath(org, project, version)
      const response = await withRetry(
        `GET ${path}`,
        async () => {
          const result = await request("GET", path, { auth: Boolean(token) })
          if (result.status !== 200 && result.status !== 404) {
            fail(result.status, result.text, result.headers, `GET ${path} failed`)
          }
          return result
        },
        log,
        sleepFn,
      )
      if (response.status === 404) return undefined
      return parseVersionRecord(parseJson(response.text, "version lookup"), org, project, version)
    },
    async startUpload(org, project, version) {
      const path = `${packageVersionPath(org, project, version)}/uploads`
      const response = await withRetry(
        `start upload ${org}/${project}@${version}`,
        async () => {
          const result = await request("POST", path)
          if (result.status !== 200) {
            fail(result.status, result.text, result.headers, "Starting the upload failed")
          }
          return result
        },
        log,
        sleepFn,
      )
      const body = parseJson(response.text, "start upload")
      const uploadId = stringField(body, "uploadId")
      const partSize = body.partSize
      const maxBytes = body.maxBytes
      if (!uploadId || typeof partSize !== "number" || typeof maxBytes !== "number") {
        throw new RegistryError("Start upload returned no uploadId, partSize, or maxBytes.", 200)
      }
      const contentType = stringField(body, "contentType")
      const expiresAt = stringField(body, "expiresAt")
      return {
        uploadId,
        partSize,
        maxBytes,
        ...(expiresAt ? { expiresAt } : {}),
        ...(contentType ? { contentType } : {}),
      }
    },
    async uploadPart(input) {
      const path = `${packageVersionPath(input.org, input.project, input.version)}/uploads/${encodeURIComponent(input.uploadId)}/parts/${input.partNumber}`
      const response = await withRetry(
        `upload part ${input.partNumber}`,
        async () => {
          const result = await request("PUT", path, {
            body: input.body,
            // A part is a slice of the gzip archive, not a gzip member of its own.
            contentType: "application/octet-stream",
            timeoutMs: 120_000,
          })
          if (result.status !== 200) {
            fail(
              result.status,
              result.text,
              result.headers,
              `Uploading part ${input.partNumber} failed`,
            )
          }
          return result
        },
        log,
        sleepFn,
      )
      const body = parseJson(response.text, `part ${input.partNumber}`)
      const etag = stringField(body, "etag")
      if (!etag) {
        throw new RegistryError(`Part ${input.partNumber} returned no etag.`, 200)
      }
      const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : input.body.length
      const partNumber = typeof body.partNumber === "number" ? body.partNumber : input.partNumber
      return { partNumber, etag, sizeBytes }
    },
    async uploadManifest(input) {
      const path = `${packageVersionPath(input.org, input.project, input.version)}/uploads/${encodeURIComponent(input.uploadId)}/manifest`
      const response = await withRetry(
        "upload manifest",
        async () => {
          const result = await request("PUT", path, {
            body: input.body,
            contentType: "application/json",
            timeoutMs: 60_000,
          })
          if (result.status !== 200) {
            fail(result.status, result.text, result.headers, "Uploading the manifest failed")
          }
          return result
        },
        log,
        sleepFn,
      )
      const body = parseJson(response.text, "manifest upload")
      const sha256 = stringField(body, "sha256") ?? ""
      const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : input.body.length
      const contentType = stringField(body, "contentType")
      return {
        sha256,
        sizeBytes,
        ...(contentType ? { contentType } : {}),
      }
    },
    async completeUpload(input) {
      const path = `${packageVersionPath(input.org, input.project, input.version)}/uploads/${encodeURIComponent(input.uploadId)}/complete`
      const response = await withRetry(
        "complete upload",
        async () => {
          const result = await request("POST", path, {
            json: {
              sha256: input.sha256,
              manifestSha256: input.manifestSha256,
              parts: input.parts,
            },
          })
          if (result.status !== 200) {
            fail(result.status, result.text, result.headers, "Completing the upload failed")
          }
          return result
        },
        log,
        sleepFn,
      )
      return parseVersionRecord(
        parseJson(response.text, "complete upload"),
        input.org,
        input.project,
        input.version,
      )
    },
    async abortUpload(org, project, version, uploadId) {
      const path = `${packageVersionPath(org, project, version)}/uploads/${encodeURIComponent(uploadId)}/abort`
      const response = await request("POST", path, { timeoutMs: 30_000 })
      if (response.status !== 200) {
        fail(response.status, response.text, response.headers, "Aborting the upload failed")
      }
    },
  }
}

function parseJson(text: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value)) throw new Error("response was not a JSON object")
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RegistryError(`${label} returned invalid JSON: ${message}`, 200)
  }
}

function parseErrorBody(text: string): { message?: string; code?: string } | undefined {
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value)) return undefined
    const message = stringField(value, "message")
    const code = stringField(value, "code")
    return {
      ...(message ? { message } : {}),
      ...(code ? { code } : {}),
    }
  } catch {
    return undefined
  }
}

function parseVersionRecord(
  body: Record<string, unknown>,
  org: string,
  project: string,
  version: string,
): VersionRecord {
  return {
    org: stringField(body, "org") ?? org,
    project: stringField(body, "project") ?? project,
    version: stringField(body, "version") ?? version,
    sha256: stringField(body, "sha256") ?? "",
    ...(stringField(body, "manifestSha256")
      ? { manifestSha256: stringField(body, "manifestSha256") }
      : {}),
    sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : 0,
    ...(stringField(body, "contentType") ? { contentType: stringField(body, "contentType") } : {}),
    yanked: body.yanked === true,
    ...(stringField(body, "publishedAt") ? { publishedAt: stringField(body, "publishedAt") } : {}),
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

export function explain(status: number, code: string | undefined, detail: string): string {
  switch (code) {
    case "publisher_not_allowed":
      return `This GitHub repository is not allowlisted for the package. On https://alchemy.new/packages, add a trusted publisher for the repository and workflow. ${detail}`
    case "oidc_invalid":
      return `The registry rejected the GitHub OIDC token. Check the audience, id-token: write, and any workflow, environment, or ref allowlist. ${detail}`
    case "unauthorized":
      return `The registry did not accept the credential. ${detail}`
    case "token_expired":
      return `The registry credential has expired. OIDC grants last 15 minutes; mint a new anr_ token if you passed one. ${detail}`
    case "token_revoked":
      return `The API token was revoked. ${detail}`
    case "forbidden":
      return `The credential cannot publish this package. ${detail}`
    case "not_found":
      return `Org, package, version, or upload was not found. Create the org and package at https://alchemy.new/packages. ${detail}`
    case "immutable_version":
      return `That version is already published and versions are immutable. ${detail}`
    case "invalid_version":
      return `The version is not exact semver without build metadata. ${detail}`
    case "invalid_archive":
      return `The registry rejected the archive. It must be a gzip tar of the package root with the entrypoint and node_modules/alchemy/bin/cli.js, and without a root alchemy.new.jsonc, .git, or secret files. The manifest is uploaded separately. ${detail}`
    case "invalid_manifest":
      return `The registry rejected the manifest. Check schema version 1, source.kind "registry", and that org, project, and source.version match this publish. ${detail}`
    case "manifest_required":
      return `Complete ran before the manifest was uploaded. Upload alchemy.new.jsonc to the manifest endpoint, then complete. ${detail}`
    case "manifest_too_large":
      return `The manifest is over the 256 KB limit. ${detail}`
    case "invalid_content_type":
      return `The registry rejected the content type. Archive parts must be application/octet-stream or application/gzip. The manifest must be application/json or application/octet-stream. ${detail}`
    case "archive_too_large":
      return `The archive or a part exceeds the registry cap (256 MiB archive, 8 MiB part). ${detail}`
    case "digest_mismatch":
      return `The registry digest does not match the uploaded archive or the uploaded manifest. ${detail}`
    case "upload_expired":
      return `The upload window elapsed before completion. Re-run the job. ${detail}`
    case "rate_limited":
      return `The registry rate limit was hit. ${detail}`
    default:
      return `HTTP ${status}${code ? ` ${code}` : ""}. ${detail}`
  }
}
