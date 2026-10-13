import { open } from "node:fs/promises"
import { MAX_ARCHIVE_BYTES, MAX_PART_BYTES, MIN_PART_BYTES } from "./constants.ts"
import { ActionError, RegistryError } from "./errors.ts"
import { formatBytes } from "./bytes.ts"
import type { Logger } from "./log.ts"
import type { RegistryClient, VersionRecord } from "./registry.ts"

export type OnImmutable = "fail" | "skip-if-digest-matches"

export function resolvePartSize(fileSize: number, serverPartSize: number): number {
  if (!Number.isInteger(serverPartSize) || serverPartSize <= 0) {
    throw new ActionError(`Registry returned an invalid partSize (${String(serverPartSize)}).`)
  }
  if (fileSize <= MAX_PART_BYTES) return fileSize
  if (serverPartSize < MIN_PART_BYTES || serverPartSize > MAX_PART_BYTES) {
    throw new ActionError(
      `Registry partSize ${serverPartSize} is outside the 5 MiB to 8 MiB contract range, and the archive needs more than one part.`,
    )
  }
  return serverPartSize
}

/** Byte length of each part. The last part may be smaller than 5 MiB. */
export function planPartLengths(fileSize: number, serverPartSize: number): number[] {
  if (fileSize <= 0) throw new ActionError("Archive is empty.")
  const partSize = resolvePartSize(fileSize, serverPartSize)
  const lengths: number[] = []
  let remaining = fileSize
  while (remaining > 0) {
    const length = Math.min(partSize, remaining)
    const isLast = length === remaining
    if (length > MAX_PART_BYTES) {
      throw new ActionError(`A part would be ${length} bytes, above the 8 MiB maximum.`)
    }
    if (!isLast && length < MIN_PART_BYTES) {
      throw new ActionError(`A non-final part would be ${length} bytes, under the 5 MiB minimum.`)
    }
    lengths.push(length)
    remaining -= length
  }
  return lengths
}

function digest(value: string | undefined): string | undefined {
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) return undefined
  return value.toLowerCase()
}

/**
 * Compare the archive digest, and the manifest digest when the version record exposes one.
 * A record with no manifestSha256 can still match on the archive digest alone.
 */
export function decideImmutable(
  existing: VersionRecord,
  sha256: string,
  manifestSha256: string,
  onImmutable: OnImmutable,
): { record: VersionRecord; skipped: boolean } {
  const yanked = existing.yanked
    ? " The existing version is yanked. Yanked versions stay immutable and cannot deploy."
    : ""
  const recordedArchive = digest(existing.sha256)
  if (!recordedArchive) {
    throw new ActionError(
      `Version ${existing.version} is already published, and the registry record has no sha256 to compare.${yanked} Versions are immutable. Publish a new version.`,
    )
  }
  if (recordedArchive !== sha256.toLowerCase()) {
    throw new ActionError(
      `Version ${existing.version} is already published with sha256 ${recordedArchive}, which does not match this archive (${sha256}). Versions are immutable. Publish a new version.${yanked}`,
    )
  }
  const recordedManifest = digest(existing.manifestSha256)
  if (existing.manifestSha256 !== undefined && !recordedManifest) {
    throw new ActionError(
      `Version ${existing.version} is already published, and its manifestSha256 is not a sha256 digest.${yanked} Versions are immutable. Publish a new version.`,
    )
  }
  if (recordedManifest && recordedManifest !== manifestSha256.toLowerCase()) {
    throw new ActionError(
      `Version ${existing.version} is already published with manifest sha256 ${recordedManifest}, which does not match this manifest (${manifestSha256}). The archive sha256 matches. Versions are immutable. Publish a new version.${yanked}`,
    )
  }
  const sameManifest = recordedManifest
    ? ` and manifest sha256 (${manifestSha256})`
    : ". The version record does not include manifestSha256, so that digest was not compared"
  if (onImmutable === "skip-if-digest-matches") {
    return {
      record: {
        ...existing,
        sha256: recordedArchive,
        ...(recordedManifest ? { manifestSha256: recordedManifest } : {}),
      },
      skipped: true,
    }
  }
  throw new ActionError(
    `Version ${existing.version} is already published with the same archive sha256 (${sha256})${sameManifest}. Versions are immutable, so nothing was uploaded.${yanked} Set on-immutable to skip-if-digest-matches to succeed when the digests match.`,
  )
}

export async function uploadArchive(options: {
  client: RegistryClient
  org: string
  project: string
  version: string
  archivePath: string
  sha256: string
  manifestBytes: Buffer
  manifestSha256: string
  sizeBytes: number
  onImmutable: OnImmutable
  authorize: () => Promise<string>
  log: Logger
}): Promise<{ record: VersionRecord; skipped: boolean }> {
  if (!/^[0-9a-f]{64}$/.test(options.sha256)) {
    throw new ActionError("Internal error: sha256 is not 64 lowercase hex characters.")
  }
  if (!/^[0-9a-f]{64}$/.test(options.manifestSha256)) {
    throw new ActionError("Internal error: manifestSha256 is not 64 lowercase hex characters.")
  }

  let authed = false
  const ensureAuth = async (): Promise<void> => {
    if (authed) return
    options.client.setToken(await options.authorize())
    authed = true
  }

  let existing: VersionRecord | undefined
  try {
    existing = await options.client.getVersion(options.org, options.project, options.version)
  } catch (error) {
    if (error instanceof RegistryError && (error.status === 401 || error.status === 403)) {
      options.log.info("Version lookup required credentials. Authenticating and retrying it.")
      await ensureAuth()
      existing = await options.client.getVersion(options.org, options.project, options.version)
    } else {
      throw error
    }
  }
  if (existing) {
    const decision = decideImmutable(
      existing,
      options.sha256,
      options.manifestSha256,
      options.onImmutable,
    )
    if (decision.skipped && !digest(existing.manifestSha256)) {
      options.log.warn(
        `Version ${options.version} matches this archive sha256. The version record does not include manifestSha256, so that digest was not compared.`,
      )
    }
    if (decision.skipped && existing.yanked) {
      options.log.warn(
        `Version ${options.version} matches this archive but is yanked. Deploys skip yanked versions.`,
      )
    }
    return decision
  }

  await ensureAuth()
  let session: Awaited<ReturnType<RegistryClient["startUpload"]>>
  try {
    session = await options.client.startUpload(options.org, options.project, options.version)
  } catch (error) {
    return rethrowOrSkip(error, options, ensureAuth)
  }

  const cap = Math.min(MAX_ARCHIVE_BYTES, session.maxBytes)
  if (options.sizeBytes > cap) {
    await safeAbort(options, session.uploadId)
    throw new ActionError(
      `Archive is ${formatBytes(options.sizeBytes)} (${options.sizeBytes} bytes), above the upload cap of ${formatBytes(cap)}.`,
    )
  }
  if (session.contentType && session.contentType !== "application/gzip") {
    options.log.warn(
      `Registry content type is ${session.contentType}. The contract stores application/gzip.`,
    )
  }
  options.log.info(
    `Upload ${session.uploadId} started. Part size ${session.partSize} bytes. Expires ${session.expiresAt ?? "unspecified"}.`,
  )

  try {
    const lengths = planPartLengths(options.sizeBytes, session.partSize)
    await sendManifest(options, session.uploadId)
    const parts = await sendParts(options, session.uploadId, lengths)
    const record = await options.client.completeUpload({
      org: options.org,
      project: options.project,
      version: options.version,
      uploadId: session.uploadId,
      sha256: options.sha256,
      manifestSha256: options.manifestSha256,
      parts: parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
    })
    if (record.sha256.toLowerCase() !== options.sha256) {
      throw new ActionError(
        `Registry recorded sha256 ${record.sha256 || "(missing)"}, which does not match ${options.sha256}.`,
      )
    }
    const recordedManifest = digest(record.manifestSha256)
    if (recordedManifest !== options.manifestSha256) {
      throw new ActionError(
        `Registry recorded manifest sha256 ${record.manifestSha256 || "(missing)"}, which does not match ${options.manifestSha256}.`,
      )
    }
    return {
      record: { ...record, sha256: options.sha256, manifestSha256: options.manifestSha256 },
      skipped: false,
    }
  } catch (error) {
    if (error instanceof RegistryError && error.code === "immutable_version") {
      await safeAbort(options, session.uploadId)
      return rethrowOrSkip(error, options, ensureAuth)
    }
    await safeAbort(options, session.uploadId)
    throw error
  }
}

async function rethrowOrSkip(
  error: unknown,
  options: {
    client: RegistryClient
    org: string
    project: string
    version: string
    sha256: string
    manifestSha256: string
    onImmutable: OnImmutable
    log: Logger
  },
  ensureAuth: () => Promise<void>,
): Promise<{ record: VersionRecord; skipped: boolean }> {
  if (!(error instanceof RegistryError) || error.code !== "immutable_version") {
    throw error
  }
  await ensureAuth()
  const again = await options.client.getVersion(options.org, options.project, options.version)
  if (!again) throw error
  return decideImmutable(again, options.sha256, options.manifestSha256, options.onImmutable)
}

async function sendManifest(
  options: {
    client: RegistryClient
    org: string
    project: string
    version: string
    manifestBytes: Buffer
    manifestSha256: string
    log: Logger
  },
  uploadId: string,
): Promise<void> {
  const result = await options.client.uploadManifest({
    org: options.org,
    project: options.project,
    version: options.version,
    uploadId,
    body: options.manifestBytes,
  })
  if (digest(result.sha256) !== options.manifestSha256) {
    throw new ActionError(
      `Registry recorded manifest sha256 ${result.sha256 || "(missing)"}, which does not match ${options.manifestSha256}.`,
    )
  }
  options.log.info(
    `Uploaded manifest (${options.manifestBytes.length} bytes, sha256 ${options.manifestSha256}).`,
  )
}

async function sendParts(
  options: {
    client: RegistryClient
    org: string
    project: string
    version: string
    archivePath: string
    log: Logger
  },
  uploadId: string,
  lengths: readonly number[],
): Promise<Array<{ partNumber: number; etag: string }>> {
  const handle = await open(options.archivePath, "r")
  try {
    const parts: Array<{ partNumber: number; etag: string }> = []
    let offset = 0
    for (let index = 0; index < lengths.length; index += 1) {
      const length = lengths[index] ?? 0
      const partNumber = index + 1
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead !== length) {
        throw new ActionError(`Short read while packing part ${partNumber}.`)
      }
      const result = await options.client.uploadPart({
        org: options.org,
        project: options.project,
        version: options.version,
        uploadId,
        partNumber,
        body: buffer,
      })
      if (!result.etag) throw new ActionError(`Part ${partNumber} returned an empty etag.`)
      parts.push({ partNumber: result.partNumber, etag: result.etag })
      options.log.info(`Uploaded part ${partNumber} of ${lengths.length} (${length} bytes).`)
      offset += length
    }
    return parts
  } finally {
    await handle.close()
  }
}

async function safeAbort(
  options: {
    client: RegistryClient
    org: string
    project: string
    version: string
    log: Logger
  },
  uploadId: string,
): Promise<void> {
  try {
    await options.client.abortUpload(options.org, options.project, options.version, uploadId)
    options.log.info(`Aborted upload ${uploadId}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.log.warn(`Could not abort upload ${uploadId}: ${message}`)
  }
}
