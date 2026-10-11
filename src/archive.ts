import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { create, extract, list, type ReadEntry } from 'tar'
import { ActionError } from './errors.ts'
import { MANIFEST_FILENAME } from './constants.ts'
import { normalizeRelPath } from './paths.ts'

export interface ArchiveEntry {
  path: string
  type: 'file' | 'symlink' | 'directory' | 'other'
  size: number
  linkTarget?: string
}

function entryType(type: ReadEntry['type']): ArchiveEntry['type'] {
  if (type === 'File' || type === 'OldFile' || type === 'ContiguousFile' || type === 'Link') {
    return 'file'
  }
  if (type === 'SymbolicLink') return 'symlink'
  if (type === 'Directory') return 'directory'
  return 'other'
}

export async function assertGzip(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(2)
    const { bytesRead } = await handle.read(buf, 0, 2, 0)
    if (bytesRead < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
      throw new ActionError(
        'Archive is not gzip. alchemy.new stores a .tar.gz archive with content type application/gzip.',
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
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: Buffer | string) => {
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export async function listArchive(archivePath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  await list({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      const path = normalizeRelPath(entry.path)
      entries.push({
        path: path ?? entry.path,
        type: entryType(entry.type),
        size: entry.size,
        ...(entry.linkpath ? { linkTarget: entry.linkpath } : {}),
      })
    },
  })
  return entries
}

export async function readArchiveText(archivePath: string, member: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alchemy-new-manifest-'))
  try {
    await extract({
      file: archivePath,
      cwd: dir,
      strict: true,
      filter: (path) => normalizeRelPath(path) === member,
    })
    const text = await readFile(join(dir, member), 'utf8')
    if (text.length > 1_000_000) {
      throw new ActionError(`${member} is larger than 1 MiB.`)
    }
    return text
  } catch (error) {
    if (error instanceof ActionError) throw error
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') {
      throw new ActionError(`Archive is missing ${member} at the archive root.`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionError(`Could not read ${member} from the archive: ${message}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function parentPrefixes(files: readonly string[]): Set<string> {
  const prefixes = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : (parts[i] ?? '')
      if (prefix) prefixes.add(prefix)
    }
  }
  return prefixes
}

/** Pack selected files so the package root is the archive root. No wrapping directory. */
export async function packFiles(
  root: string,
  files: readonly string[],
  destination: string,
): Promise<void> {
  if (files.length === 0) {
    throw new ActionError('Nothing to pack. The include and exclude rules removed every file.')
  }
  await mkdir(dirname(destination), { recursive: true })
  const allowed = new Set(files)
  const prefixes = parentPrefixes(files)
  await create(
    {
      gzip: true,
      file: destination,
      cwd: root,
      portable: true,
      strict: true,
      follow: false,
      noDirRecurse: true,
      filter(path) {
        const normalized = normalizeRelPath(path)
        if (normalized === null) return false
        if (normalized === '') return true
        return allowed.has(normalized) || prefixes.has(normalized)
      },
    },
    [...files],
  )
}

export async function tempArchivePath(): Promise<string> {
  const base = process.env.RUNNER_TEMP || tmpdir()
  const dir = await mkdtemp(join(base, 'alchemy-new-'))
  return join(dir, 'alchemy.new.tar.gz')
}

export function memberMap(entries: readonly ArchiveEntry[]): Map<string, ArchiveEntry> {
  const files = new Map<string, ArchiveEntry>()
  for (const entry of entries) {
    if (entry.type === 'file' || entry.type === 'symlink') files.set(entry.path, entry)
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

export { MANIFEST_FILENAME }
