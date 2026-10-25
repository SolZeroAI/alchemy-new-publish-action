import { isAbsolute, relative, resolve, sep } from "node:path"
import { relative as posixRelative } from "node:path/posix"
import { normalizeRelPath, resolvedSymlink, symlinkResolvesInside } from "./paths.ts"
import { hardRejectReason } from "./rules.ts"

/** Link text stored in the archive for a file that lives at `toFile`. */
export function relativeArchiveLink(fromFile: string, toFile: string): string {
  const slash = fromFile.lastIndexOf("/")
  const fromDir = slash === -1 ? "." : fromFile.slice(0, slash)
  const target = posixRelative(fromDir, toFile)
  return target.length === 0 ? "." : target
}

function isAbsoluteLinkTarget(target: string): boolean {
  return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target) || isAbsolute(target)
}

/**
 * Package-relative path named by `target`, or null when it leaves `root`.
 * A relative target is resolved from `fromPath`. An absolute target is resolved
 * from `root` and is not followed on disk.
 */
export function packageRelativeTarget(
  root: string,
  fromPath: string,
  target: string,
): string | null {
  if (!isAbsoluteLinkTarget(target)) return resolvedSymlink(fromPath, target)
  // `resolve` on a POSIX host joins a drive-letter target onto the working
  // directory. That target cannot name a path inside this package.
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(target)) return null
  const fromRoot = relative(resolve(root), resolve(target))
  if (fromRoot !== "" && isAbsolute(fromRoot)) return null
  return normalizeRelPath(fromRoot.split(sep).join("/"))
}

/**
 * Relative archive link for `target`. The original string is kept when it is
 * already relative and stays inside the package. Null when the target leaves
 * the package root.
 */
export function symlinkArchiveTarget(
  root: string,
  relativePath: string,
  target: string,
): string | null {
  if (!isAbsoluteLinkTarget(target)) {
    return symlinkResolvesInside(relativePath, target) ? target : null
  }
  return absoluteSymlinkArchiveTarget(root, relativePath, target)
}

/**
 * Nub and pnpm store links are often absolute and still point inside the
 * package. Return the equivalent relative link. Null when the resolved target
 * leaves the package root. This does not read or write the filesystem.
 */
function absoluteSymlinkArchiveTarget(
  root: string,
  relativePath: string,
  target: string,
): string | null {
  const packageRelative = packageRelativeTarget(root, relativePath, target)
  if (packageRelative === null) return null
  const slash = relativePath.lastIndexOf("/")
  const dir = slash === -1 ? "." : relativePath.slice(0, slash)
  const link = posixRelative(dir, packageRelative === "" ? "." : packageRelative)
  const archiveTarget = link === "" ? "." : link
  if (!symlinkResolvesInside(relativePath, archiveTarget)) return null
  const resolved = resolvedSymlink(relativePath, archiveTarget)
  if (packageRelative === "") {
    if (resolved !== "") return null
  } else if (resolved !== packageRelative) {
    return null
  }
  return archiveTarget
}

/** How many outside-root links one failure lists before it counts the rest. */
export const OUTSIDE_SYMLINK_LIST_LIMIT = 20

export interface OutsideSymlink {
  path: string
  target: string
}

function byPath(left: { path: string }, right: { path: string }): number {
  if (left.path < right.path) return -1
  if (left.path > right.path) return 1
  return 0
}

/**
 * One failure for every symlink whose target leaves the package root.
 * `target` is the link text. It is not resolved, and the link is not followed.
 * nub's global virtual store is a common source of these links.
 */
export function formatOutsideSymlinkFailure(links: readonly OutsideSymlink[]): string {
  const unique = new Map<string, OutsideSymlink>()
  for (const link of links) {
    if (!unique.has(link.path)) unique.set(link.path, link)
  }
  const sorted = [...unique.values()].sort(byPath)
  const shown = sorted.slice(0, OUTSIDE_SYMLINK_LIST_LIMIT)
  const noun = sorted.length === 1 ? "symlink points" : "symlinks point"
  const lines = [
    `${sorted.length} ${noun} outside the package root. The archive stores the link text and does not follow the link. nub's global virtual store can create such links. Set NPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false on install to keep the store inside the project.`,
    ...shown.map((link) => `symlink ${link.path} points outside the package root (${link.target})`),
  ]
  const extra = sorted.length - shown.length
  if (extra > 0) lines.push(`And ${extra} more.`)
  return lines.join("\n")
}

/**
 * Why this symlink must not be packed. Undefined when the target stays inside
 * the package root and is not a forbidden path. An absolute link text fails:
 * a prebuilt archive must already store a relative target.
 */
export function symlinkProblem(fromPath: string, target: string): string | undefined {
  if (!symlinkResolvesInside(fromPath, target)) {
    return `symlink ${fromPath} points outside the package root (${target})`
  }
  const resolved = resolvedSymlink(fromPath, target)
  if (!resolved) {
    return `symlink ${fromPath} points outside the package root (${target})`
  }
  const reason = hardRejectReason(resolved)
  if (reason) return `symlink ${fromPath} points at a forbidden path (${resolved})`
  return undefined
}
