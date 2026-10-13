import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  CLI_PATH,
  MANIFEST_FILENAME,
  MAX_MANIFEST_BYTES,
  RECOMMENDED_ARCHIVE_BYTES,
} from "./constants.ts"
import { ActionError } from "./errors.ts"
import { formatBytes } from "./bytes.ts"
import type { Logger } from "./log.ts"
import { silentLogger } from "./log.ts"
import { parseManifest, type Manifest } from "./manifest.ts"
import { resolvePackage } from "./package-ref.ts"
import { normalizeRelPath } from "./paths.ts"
import { resolveVersion } from "./semver.ts"
import { selectFiles } from "./select.ts"
import {
  assertGzip,
  fileSize,
  listArchive,
  memberMap,
  packFiles,
  pathExists,
  sha256File,
  tempArchivePath,
} from "./archive.ts"
import {
  assertArchiveSize,
  assertNoRootManifest,
  assertReadyArchive,
  assertSafeEntries,
} from "./validate.ts"
import { createRegistryClient, normalizeRegistryUrl, type RegistryClient } from "./registry.ts"
import { authorize } from "./auth.ts"
import { uploadArchive, type OnImmutable } from "./upload.ts"
import { deployUrl, renderSummary } from "./summary.ts"
import type { Sleep } from "./retry.ts"

export interface PublishOptions {
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
  gitRef?: string
  workspace?: string
  client?: RegistryClient
  fetchImpl?: typeof fetch
  sleep?: Sleep
  log?: Logger
  mask?: (secret: string) => void
  getIdToken?: (audience: string) => Promise<string>
  writeSummary?: (markdown: string) => Promise<void>
}

export interface PublishResult {
  org: string
  project: string
  version: string
  sha256: string
  manifestSha256: string
  sizeBytes: number
  url: string
  dryRun: boolean
  skipped: boolean
}

interface LoadedManifest {
  bytes: Buffer
  sha256: string
  manifest: Manifest
}

/**
 * Drop the root manifest from the tar. The registry rejects `alchemy.new.jsonc`
 * at the archive root. A manifest file that itself sits at the package root is
 * dropped even when its name differs. Nested copies stay.
 */
export function filesForArchive(
  files: readonly string[],
  manifestRelative: string | undefined,
): string[] {
  return files.filter((file) => !omittedFromArchive(file, manifestRelative))
}

function omittedFromArchive(file: string, manifestRelative: string | undefined): boolean {
  if (file === MANIFEST_FILENAME) return true
  return (
    manifestRelative !== undefined && !manifestRelative.includes("/") && file === manifestRelative
  )
}

export function resolveManifestFile(options: {
  manifest?: string
  path?: string
  archive?: string
  workspace?: string
}): string {
  const packageDirectory = options.archive
    ? undefined
    : resolve(options.path ?? options.workspace ?? process.cwd())
  const base = packageDirectory ?? resolve(options.workspace ?? process.cwd())
  if (!options.manifest) return join(base, MANIFEST_FILENAME)
  return isAbsolute(options.manifest) ? options.manifest : resolve(base, options.manifest)
}

export async function publish(options: PublishOptions): Promise<PublishResult> {
  const log = options.log ?? silentLogger
  const registryUrl = normalizeRegistryUrl(options.registryUrl)
  if (registryUrl.startsWith("http://")) {
    const host = new URL(registryUrl).hostname
    if (host !== "localhost" && host !== "127.0.0.1") {
      log.warn(`registry-url uses http (${registryUrl}). Production is https://alchemy.new.`)
    }
  }
  if (options.archive && options.path) {
    throw new ActionError("Pass either archive or path, not both.")
  }

  const prepared = options.archive
    ? await preparePrebuilt(resolve(options.archive), log)
    : await prepareDirectory(options, log)

  const sizeBytes = await fileSize(prepared.archivePath)
  assertArchiveSize(sizeBytes)
  if (sizeBytes > RECOMMENDED_ARCHIVE_BYTES) {
    log.warn(
      `Archive is ${formatBytes(sizeBytes)}. The publisher guide says to stay near 80 MiB. The registry rejects archives over 256 MiB.`,
    )
  }
  await assertGzip(prepared.archivePath)
  const entries = await listArchive(prepared.archivePath)
  assertSafeEntries(entries)
  assertNoRootManifest(entries)
  const loaded = prepared.loaded ?? (await loadManifest(resolveManifestFile(options)))
  assertReadyArchive(entries, loaded.manifest)

  const pkg = resolvePackage({
    ...(options.packageInput ? { packageInput: options.packageInput } : {}),
    ...(options.org ? { org: options.org } : {}),
    ...(options.project ? { project: options.project } : {}),
    manifestOrg: loaded.manifest.source.org,
    manifestProject: loaded.manifest.source.project,
  })
  const version = resolveVersion({
    ...(options.version ? { explicit: options.version } : {}),
    ...(options.gitRef ? { gitRef: options.gitRef } : {}),
    ...(loaded.manifest.source.version ? { manifestVersion: loaded.manifest.source.version } : {}),
  })
  const sha256 = await sha256File(prepared.archivePath)
  const files = [...memberMap(entries).keys()].sort()
  const url = deployUrl(pkg.org, pkg.project, version)

  log.info(
    `${options.dryRun ? "Dry run for" : "Publishing"} ${pkg.org}/${pkg.project}@${version} to ${registryUrl} (${formatBytes(sizeBytes)}, sha256 ${sha256}, manifest sha256 ${loaded.sha256}).`,
  )
  log.info(`${MANIFEST_FILENAME} is not in the archive. It is uploaded separately.`)
  for (const file of files.slice(0, 200)) log.info(`pack ${file}`)
  if (files.length > 200) log.info(`pack … ${files.length - 200} more files`)
  for (const file of prepared.excluded.slice(0, 50)) log.info(`exclude ${file}`)
  if (prepared.excludedCount > prepared.excluded.length) {
    log.info(`exclude … ${prepared.excludedCount - prepared.excluded.length} more paths`)
  }

  const markdown = renderSummary({
    org: pkg.org,
    project: pkg.project,
    version,
    sha256,
    manifestSha256: loaded.sha256,
    sizeBytes,
    fileCount: files.length,
    url,
    registryUrl,
    dryRun: options.dryRun,
    skipped: false,
    files,
    excluded: prepared.excluded,
    excludedCount: prepared.excludedCount,
    overRecommended: sizeBytes > RECOMMENDED_ARCHIVE_BYTES,
  })

  if (options.dryRun) {
    await options.writeSummary?.(markdown)
    log.info("Dry run: archive was not uploaded.")
    return {
      org: pkg.org,
      project: pkg.project,
      version,
      sha256,
      manifestSha256: loaded.sha256,
      sizeBytes,
      url,
      dryRun: true,
      skipped: false,
    }
  }

  if (options.token) {
    options.mask?.(options.token)
    if (!options.token.startsWith("anr_")) {
      throw new ActionError(
        "The token input must be an alchemy.new API token starting with anr_. Short-lived anu_ grants are created by the OIDC exchange and cannot be pasted here.",
      )
    }
  }

  const client =
    options.client ??
    createRegistryClient({
      registryUrl,
      log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    })

  const outcome = await uploadArchive({
    client,
    org: pkg.org,
    project: pkg.project,
    version,
    archivePath: prepared.archivePath,
    sha256,
    manifestBytes: loaded.bytes,
    manifestSha256: loaded.sha256,
    sizeBytes,
    onImmutable: options.onImmutable,
    log,
    authorize: () =>
      authorize({
        ...(options.token ? { token: options.token } : {}),
        org: pkg.org,
        project: pkg.project,
        client,
        ...(options.getIdToken ? { getIdToken: options.getIdToken } : {}),
        mask: options.mask ?? (() => {}),
        log,
      }),
  })

  if (outcome.skipped) {
    log.info(
      `Skipped upload. ${pkg.org}/${pkg.project}@${version} is already published with archive sha256 ${sha256}.`,
    )
  } else {
    log.info(`Published ${pkg.org}/${pkg.project}@${version}.`)
  }
  log.info(url)

  const finalMarkdown = renderSummary({
    org: pkg.org,
    project: pkg.project,
    version,
    sha256,
    manifestSha256: loaded.sha256,
    sizeBytes,
    fileCount: files.length,
    url,
    registryUrl,
    dryRun: false,
    skipped: outcome.skipped,
    files,
    excluded: prepared.excluded,
    excludedCount: prepared.excludedCount,
    overRecommended: sizeBytes > RECOMMENDED_ARCHIVE_BYTES,
  })
  await options.writeSummary?.(finalMarkdown)

  return {
    org: pkg.org,
    project: pkg.project,
    version,
    sha256,
    manifestSha256: loaded.sha256,
    sizeBytes,
    url,
    dryRun: false,
    skipped: outcome.skipped,
  }
}

interface PreparedArchive {
  archivePath: string
  excluded: string[]
  excludedCount: number
  /** Set when the directory packer already read the manifest. Prebuilt archives load it after safety checks. */
  loaded?: LoadedManifest
}

async function preparePrebuilt(archivePath: string, log: Logger): Promise<PreparedArchive> {
  log.info(`Using prebuilt archive ${archivePath}.`)
  return { archivePath, excluded: [], excludedCount: 0 }
}

async function prepareDirectory(options: PublishOptions, log: Logger): Promise<PreparedArchive> {
  const directory = resolve(options.path ?? options.workspace ?? process.cwd())
  log.info(`Packing ${directory}.`)
  const manifestFile = resolveManifestFile(options)
  const loaded = await loadManifest(manifestFile)
  const manifestRelative = relativeInside(directory, manifestFile)
  const selection = await selectFiles(directory, {
    includes: options.include,
    excludes: options.exclude,
    defaultExcludes: options.defaultExcludes,
  })
  if (selection.rejected.length > 0) {
    const lines = selection.rejected.slice(0, 20).map((item) => `${item.path}: ${item.reason}`)
    throw new ActionError(`Refusing to pack forbidden files:\n${lines.join("\n")}`)
  }
  const files = filesForArchive(selection.files, manifestRelative)
  const selected = new Set(files)
  await assertPresent(directory, loaded.manifest.entrypoint, selected, "deployment entrypoint")
  await assertPresent(directory, CLI_PATH, selected, CLI_PATH)
  const archivePath = await tempArchivePath()
  await packFiles(directory, files, archivePath)
  log.info(`Wrote ${archivePath}.`)
  const omitted = selection.files.filter((file) => omittedFromArchive(file, manifestRelative))
  return {
    archivePath,
    excluded: [...selection.excluded, ...omitted],
    excludedCount: selection.excludedCount + omitted.length,
    loaded,
  }
}

async function loadManifest(manifestPath: string): Promise<LoadedManifest> {
  let bytes: Buffer
  try {
    bytes = await readFile(manifestPath)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code === "ENOENT") {
      throw new ActionError(
        `Missing manifest at ${manifestPath}. Pass manifest, or place ${MANIFEST_FILENAME} at the package root. The manifest is uploaded separately and is not read from the archive.`,
      )
    }
    throw error
  }
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new ActionError(
      `Manifest at ${manifestPath} is ${bytes.length} bytes, above the 256 KB limit (${MAX_MANIFEST_BYTES}). The registry returns manifest_too_large.`,
    )
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    manifest: parseManifest(bytes.toString("utf8"), manifestPath),
  }
}

function relativeInside(directory: string, filePath: string): string | undefined {
  const rel = relative(directory, filePath)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined
  const normalized = normalizeRelPath(rel)
  if (!normalized) return undefined
  return normalized
}

async function assertPresent(
  root: string,
  relativePath: string,
  selected: Set<string>,
  label: string,
): Promise<void> {
  if (selected.has(relativePath)) return
  if (await pathExists(join(root, relativePath))) {
    throw new ActionError(
      `${label} (${relativePath}) is in the package directory but the include/exclude rules dropped it.`,
    )
  }
  throw new ActionError(
    `Missing ${label} at ${relativePath}. alchemy.new does not install dependencies or build the app.`,
  )
}

export { normalizeRegistryUrl }
