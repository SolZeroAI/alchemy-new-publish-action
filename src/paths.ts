/** Normalize an archive or package-relative path. Null when it escapes the root. */
export function normalizeRelPath(input: string): string | null {
  if (input.includes("\0") || input.includes("\n") || input.includes("\r")) return null
  let path = input.replace(/\\/g, "/")

  if (/^[A-Za-z]:/.test(path)) return null
  path = path.replace(/^\.\/+/, "")

  if (path.startsWith("/")) return null
  path = path.replace(/\/+$/, "")

  if (path === "" || path === ".") return ""
  const parts: string[] = []

  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue

    if (part === "..") {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }

    parts.push(part)
  }

  return parts.join("/")
}

/** Resolved package-relative target, or null when `target` is absolute or escapes the root. */
function linkInsidePackage(fromPath: string, target: string): string | null {
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) return null
  const slash = fromPath.lastIndexOf("/")
  const dir = slash === -1 ? "" : fromPath.slice(0, slash)
  const joined = dir ? `${dir}/${target.replace(/\\/g, "/")}` : target.replace(/\\/g, "/")

  return normalizeRelPath(joined)
}

export function symlinkResolvesInside(fromPath: string, target: string): boolean {
  return linkInsidePackage(fromPath, target) !== null
}

export function resolvedSymlink(fromPath: string, target: string): string | null {
  return linkInsidePackage(fromPath, target)
}
