import { CLI_PATH, MANIFEST_FILENAME, MAX_ARCHIVE_BYTES } from './constants.ts'
import { ActionError } from './errors.ts'
import type { Manifest } from './manifest.ts'
import { memberMap, type ArchiveEntry } from './archive.ts'
import { hardRejectReason } from './rules.ts'
import { normalizeRelPath, resolvedSymlink, symlinkResolvesInside } from './paths.ts'
import { formatBytes } from './bytes.ts'

export function assertArchiveSize(sizeBytes: number, cap = MAX_ARCHIVE_BYTES): void {
  if (sizeBytes <= 0) {
    throw new ActionError('Archive is empty.')
  }
  if (sizeBytes > cap) {
    throw new ActionError(
      `Archive is ${formatBytes(sizeBytes)} (${sizeBytes} bytes), above the ${formatBytes(cap)} registry cap.`,
    )
  }
}

/** Reject path traversal, `.git`, and secret files before anything is extracted. */
export function assertSafeEntries(entries: readonly ArchiveEntry[]): void {
  const problems: string[] = []
  for (const entry of entries) {
    const normalized = normalizeRelPath(entry.path)
    if (normalized === null) {
      problems.push(`${entry.path}: path is absolute or escapes the archive root`)
      continue
    }
    if (normalized === '') continue
    const reason = hardRejectReason(normalized)
    if (reason) problems.push(reason)
    if (entry.type === 'symlink' && entry.linkTarget) {
      if (!symlinkResolvesInside(normalized, entry.linkTarget)) {
        problems.push(`symlink ${normalized} points outside the archive (${entry.linkTarget})`)
      } else {
        const target = resolvedSymlink(normalized, entry.linkTarget)
        if (target) {
          const targetReason = hardRejectReason(target)
          if (targetReason) {
            problems.push(`symlink ${normalized} points at a forbidden path (${target})`)
          }
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new ActionError(
      `Archive failed safety checks:\n${problems.slice(0, 20).join('\n')}`,
    )
  }
}

/**
 * The registry rejects a root `alchemy.new.jsonc` with `invalid_archive`.
 * Nested copies are allowed. The manifest is uploaded on its own.
 */
export function assertNoRootManifest(entries: readonly ArchiveEntry[]): void {
  const root = entries.find((entry) => normalizeRelPath(entry.path) === MANIFEST_FILENAME)
  if (!root) return
  throw new ActionError(
    `Archive contains ${MANIFEST_FILENAME} at the archive root. The registry rejects that copy (invalid_archive). Upload it with the manifest input instead. Nested copies of ${MANIFEST_FILENAME} are allowed.`,
  )
}

export function assertReadyArchive(entries: readonly ArchiveEntry[], manifest: Manifest): void {
  assertNoRootManifest(entries)
  const files = memberMap(entries)
  if (!files.has(manifest.entrypoint)) {
    throw new ActionError(
      `Archive is missing deployment entrypoint "${manifest.entrypoint}". alchemy.new runs that file and does not build the app.`,
    )
  }
  if (!files.has(CLI_PATH)) {
    throw new ActionError(
      `Archive is missing ${CLI_PATH}. Install production dependencies on linux/amd64 before packing. alchemy.new does not install them.`,
    )
  }
}
