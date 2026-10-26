import { join } from "node:path"
import { CLI_PATH, MANIFEST_FILENAME, MAX_ARCHIVE_BYTES } from "./constants.ts"
import { ActionError } from "./errors.ts"
import type { Manifest } from "./manifest.ts"
import { memberMap, pathExists, type ArchiveEntry } from "./archive.ts"
import { symlinkProblem } from "./links.ts"
import { hardRejectReason } from "./rules.ts"
import { normalizeRelPath, resolvedSymlink, symlinkResolvesInside } from "./paths.ts"
import { formatBytes } from "./bytes.ts"

export function assertArchiveSize(sizeBytes: number, cap = MAX_ARCHIVE_BYTES): void {
  if (sizeBytes <= 0) {
    throw new ActionError("Archive is empty.")
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

    if (normalized === "") continue
    const reason = hardRejectReason(normalized)

    if (reason) problems.push(reason)

    if (entry.type === "symlink" && entry.linkTarget) {
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
    throw new ActionError(`Archive failed safety checks:\n${problems.slice(0, 20).join("\n")}`)
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

/**
 * The registry requires these paths as archive members. A file member counts.
 * A symlink member counts when its target stays inside the package and is not
 * forbidden. A directory symlink does not create the child path.
 */
export function assertReadyArchive(entries: readonly ArchiveEntry[], manifest: Manifest): void {
  assertNoRootManifest(entries)
  const files = memberMap(entries)
  assertArchiveMember(
    files,
    manifest.entrypoint,
    `Archive is missing deployment entrypoint "${manifest.entrypoint}". alchemy.new runs that file and does not build the app.`,
  )
  assertArchiveMember(
    files,
    CLI_PATH,
    `Archive is missing ${CLI_PATH}. Install production dependencies on linux/amd64 before packing. alchemy.new does not install them.`,
  )
}

function assertArchiveMember(
  files: Map<string, ArchiveEntry>,
  path: string,
  missing: string,
): void {
  const entry = files.get(path)

  if (!entry) throw new ActionError(missing)

  if (entry.type === "file") return

  if (entry.type === "symlink" && entry.linkTarget) {
    const problem = symlinkProblem(path, entry.linkTarget)

    if (problem) throw new ActionError(problem)

    return
  }

  throw new ActionError(missing)
}

/**
 * `relativePath` has to be an archive member. An expanded `node_modules/alchemy`
 * link counts when its relative target stays inside the package.
 */
export async function assertPresent(
  root: string,
  relativePath: string,
  selected: ReadonlySet<string>,
  links: ReadonlyMap<string, string>,
  label: string,
): Promise<void> {
  if (selected.has(relativePath)) {
    const target = links.get(relativePath)

    if (target !== undefined) {
      const problem = symlinkProblem(relativePath, target)

      if (problem) throw new ActionError(problem)
    }

    return
  }

  if (await pathExists(join(root, relativePath))) {
    throw new ActionError(
      `${label} (${relativePath}) is in the package directory but the include/exclude rules dropped it.`,
    )
  }

  throw new ActionError(
    `Missing ${label} at ${relativePath}. alchemy.new does not install dependencies or build the app.`,
  )
}
