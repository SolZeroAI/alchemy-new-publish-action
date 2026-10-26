import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, type Stats } from "node:fs"
import { lstat, mkdir, mkdtemp, open, readlink, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Gzip } from "minizlib"
import { list, WriteEntry, type ReadEntry } from "tar"
import { formatBytes } from "./bytes.ts"
import { MAX_ARCHIVE_BYTES } from "./constants.ts"
import { ActionError, nodeErrorCode } from "./errors.ts"
import { symlinkArchiveTarget, symlinkProblem } from "./links.ts"
import { normalizeRelPath, resolvedSymlink } from "./paths.ts"
import { hardRejectReason } from "./rules.ts"

export interface ArchiveEntry {
  path: string
  type: "file" | "symlink" | "directory" | "other"
  size: number
  linkTarget?: string
}

function entryType(type: ReadEntry["type"]): ArchiveEntry["type"] {
  if (type === "File" || type === "OldFile" || type === "ContiguousFile" || type === "Link") {
    return "file"
  }

  if (type === "SymbolicLink") return "symlink"

  if (type === "Directory") return "directory"

  return "other"
}

export async function assertGzip(filePath: string): Promise<void> {
  const handle = await open(filePath, "r")

  try {
    const buf = Buffer.alloc(2)
    const { bytesRead } = await handle.read(buf, 0, 2, 0)

    if (bytesRead < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
      throw new ActionError(
        "Archive is not gzip. alchemy.new stores a .tar.gz archive with content type application/gzip.",
      )
    }
  } finally {
    await handle.close()
  }
}

export async function fileSize(filePath: string): Promise<number> {
  const info = await stat(filePath)

  if (!info.isFile()) throw new ActionError(`Archive path is not a file: ${filePath}`)

  return info.size
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on("data", (chunk: Buffer | string) => {
      hash.update(chunk)
    })
    stream.on("error", reject)
    stream.on("end", () => resolve())
  })

  return hash.digest("hex")
}

export async function listArchive(archivePath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  await list({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      const path = normalizeRelPath(entry.path)

      const packed: ArchiveEntry = {
        path: path ?? entry.path,
        type: entryType(entry.type),
        size: entry.size,
      }

      if (entry.linkpath) packed.linkTarget = entry.linkpath
      entries.push(packed)
    },
  })

  return entries
}

/** One file is read at a time, in chunks, so a large tree does not sit in memory. */
const PACK_READ_BYTES = 256 * 1024

/** Two 512-byte blocks of zeros. A tar archive ends with them. */
const TAR_EOF = Buffer.alloc(1024)

interface PackOptions {
  /** Compressed size limit. Packing stops once the gzip exceeds this. */
  maxBytes?: number
  /**
   * Paths stored as these relative symlinks instead of the filesystem node.
   * Used when `node_modules/alchemy` is a directory symlink and each child
   * must be its own archive member.
   */
  links?: ReadonlyMap<string, string>
}

/**
 * Pack selected files so the package root is the archive root.
 *
 * Writes a temporary `.tar.gz`. Entries are read one at a time and compressed
 * into that file. The archive is not buffered in memory. Symlinks are stored
 * as symlinks. An absolute symlink whose target stays inside the package root
 * is stored as the equivalent relative symlink. The link on disk is not
 * changed. A path in `options.links` is stored as that relative symlink even
 * when the filesystem path is a file reached through a directory symlink. A
 * symlink that points outside the package root, or at a forbidden path, fails
 * the pack.
 */
export async function packFiles(
  root: string,
  files: readonly string[],
  destination: string,
  options: PackOptions = {},
): Promise<void> {
  if (files.length === 0) {
    throw new ActionError("Nothing to pack. The include and exclude rules removed every file.")
  }

  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES
  await mkdir(dirname(destination), { recursive: true })
  let scratch: string | undefined
  let scratchCount = 0

  const materializeLink = async (linkTarget: string): Promise<string> => {
    scratch ??= await mkdtemp(join(dirname(destination), "alchemy-links-"))
    const source = join(scratch, String(scratchCount))
    scratchCount += 1
    await symlink(linkTarget, source)

    return source
  }

  const gzip = new Gzip({ portable: true })
  const output = createWriteStream(destination)
  const linkCache = new Map<`${number}:${number}`, string>()
  const statCache = new Map<string, Stats>()
  let written = 0
  let failed: Error | undefined

  const fail = (cause: unknown): Error => {
    if (!failed) {
      failed = cause instanceof Error ? cause : new Error(String(cause))
      // Destroy on a later turn. gzip.destroy() inside a gzip write callback
      // re-enters zlib and the pack never settles.
      queueMicrotask(() => {
        gzip.destroy()
        output.destroy()
      })
    }

    return failed
  }

  gzip.on("data", (chunk: Buffer) => {
    if (failed) return
    written += chunk.length

    if (written > maxBytes) {
      fail(
        new ActionError(
          `Archive exceeded the ${formatBytes(maxBytes)} size cap while packing (${written} bytes written).`,
        ),
      )

      return
    }

    if (!output.write(chunk)) gzip.pause()
  })
  output.on("drain", () => {
    if (!failed) gzip.resume()
  })
  gzip.on("end", () => {
    output.end()
  })
  gzip.on("error", (cause: unknown) => fail(cause))
  output.on("error", (cause: unknown) => fail(cause))

  // Resolve on close. Errors are stored on `failed` so this promise cannot reject
  // before the pack loop awaits it.
  const closed = new Promise<void>((resolve) => {
    output.once("close", () => resolve())
  })

  try {
    try {
      for (const relativePath of files) {
        if (failed) throw failed
        const linkTarget = options.links?.get(relativePath)

        if (linkTarget !== undefined) {
          const problem = symlinkProblem(relativePath, linkTarget)

          if (problem) throw new ActionError(problem)
          const source = await materializeLink(linkTarget)
          await writePackedEntry(
            gzip,
            root,
            relativePath,
            linkCache,
            statCache,
            () => failed,
            source,
            linkTarget,
          )
          continue
        }

        const archiveLink = await assertSymlinkAllowed(root, relativePath)
        await writePackedEntry(
          gzip,
          root,
          relativePath,
          linkCache,
          statCache,
          () => failed,
          join(root, relativePath),
          archiveLink,
        )
      }

      if (failed) throw failed
      gzip.end(TAR_EOF)
      await closed

      if (failed) throw failed
    } catch (error) {
      const cause = fail(error)
      await closed
      await rm(destination, { force: true })
      throw cause
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Link text to store for a symlink, or `undefined` when the path is not a symlink.
 * An absolute target that stays inside `root` is returned as a relative link.
 * The file on disk is not changed.
 */
async function assertSymlinkAllowed(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  const absolute = join(root, relativePath)
  let info: Stats

  try {
    info = await lstat(absolute)
  } catch (error) {
    const code = nodeErrorCode(error)

    if (code === "ENOENT") {
      throw new ActionError(`Cannot pack ${relativePath}: the file is missing.`)
    }

    throw error
  }

  if (!info.isSymbolicLink()) return undefined
  const target = await readlink(absolute)
  const archiveTarget = symlinkArchiveTarget(root, relativePath, target)

  if (archiveTarget === null) {
    throw new ActionError(`symlink ${relativePath} points outside the package root (${target})`)
  }

  const resolved = resolvedSymlink(relativePath, archiveTarget)

  if (!resolved) return archiveTarget
  const reason = hardRejectReason(resolved)

  if (reason) {
    throw new ActionError(`symlink ${relativePath} points at a forbidden path (${resolved})`)
  }

  return archiveTarget
}

function writePackedEntry(
  gzip: Gzip,
  root: string,
  relativePath: string,
  linkCache: Map<`${number}:${number}`, string>,
  statCache: Map<string, Stats>,
  getFailure: () => Error | undefined,
  sourcePath: string,
  archiveLink?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = getFailure()

    if (existing) {
      reject(existing)

      return
    }

    const entry = new WriteEntry(relativePath, {
      cwd: root,
      absolute: sourcePath,
      portable: true,
      strict: true,
      linkCache,
      statCache,
      maxReadSize: PACK_READ_BYTES,
      onWriteEntry(packed) {
        if (archiveLink !== undefined && packed.type === "SymbolicLink") {
          packed.linkpath = archiveLink
        }
      },
    })

    let settled = false

    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      gzip.off("error", onGzipError)

      if (error) reject(error)
      else resolve()
    }

    const onGzipError = () => {
      const failure = getFailure()
      settle(failure ?? new ActionError(`Stopped packing at ${relativePath}.`))
    }

    gzip.on("error", onGzipError)
    entry.on("error", (cause: unknown) => {
      settle(cause instanceof Error ? cause : new Error(String(cause)))
    })
    entry.on("end", () => settle())
    entry.on("data", (chunk: Buffer) => {
      if (settled) return
      const failure = getFailure()

      if (failure) {
        settle(failure)

        return
      }

      let accepted = true

      try {
        accepted = gzip.write(chunk)
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))

        return
      }

      const blocked = getFailure()

      if (blocked) {
        settle(blocked)

        return
      }

      if (!accepted) {
        entry.pause()
        gzip.once("drain", () => {
          if (settled) return
          const later = getFailure()

          if (later) settle(later)
          else entry.resume()
        })
      }
    })
  })
}

export async function tempArchivePath(): Promise<string> {
  const base = process.env.RUNNER_TEMP || tmpdir()
  const dir = await mkdtemp(join(base, "alchemy-new-"))

  return join(dir, "alchemy.new.tar.gz")
}

export function memberMap(entries: readonly ArchiveEntry[]): Map<string, ArchiveEntry> {
  const files = new Map<string, ArchiveEntry>()

  for (const entry of entries) {
    if (entry.type === "file" || entry.type === "symlink") files.set(entry.path, entry)
  }

  return files
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath)

    return info.isFile() || info.isSymbolicLink()
  } catch {
    return false
  }
}
