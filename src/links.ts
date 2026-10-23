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
