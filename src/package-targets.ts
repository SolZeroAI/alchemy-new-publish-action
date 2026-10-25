import { lstat, readFile, readlink } from "node:fs/promises"
import { join } from "node:path"
import { symlinkArchiveTarget } from "./links.ts"
import { normalizeRelPath } from "./paths.ts"
import { isRecord, stringField } from "./record.ts"

/** How many dropped targets one warning lists before it counts the rest. */
const DROPPED_TARGET_LIMIT = 20

interface DeclaredTarget {
  field: string
  spec: string
}

export interface DroppedPackageTarget {
  packageLabel: string
  fields: string[]
  path: string
}

/**
 * Directory of a packed package.json we should read.
 * The package root, and packages under node_modules (including a scoped name
 * and a package inside a store path). Other package.json files are skipped.
 * Returns `""` for the package root. Returns null when this path is not one
 * of those manifests.
 */
export function packageDirOfPackedManifest(relativePath: string): string | null {
  if (relativePath === "package.json") return ""
  const parts = relativePath.split("/")
  if (parts[parts.length - 1] !== "package.json") return null
  const nodeModulesAt = parts.lastIndexOf("node_modules")
  if (nodeModulesAt < 0) return null
  const nameParts = parts.slice(nodeModulesAt + 1, -1)
  const unscoped = nameParts[0]
  if (nameParts.length === 1 && unscoped && !unscoped.startsWith("@")) {
    return parts.slice(0, -1).join("/")
  }
  const scope = nameParts[0]
  const name = nameParts[1]
  if (nameParts.length === 2 && scope && scope.startsWith("@") && scope.length > 1 && name) {
    return parts.slice(0, -1).join("/")
  }
  return null
}

function appendField(parent: string, key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `${parent}.${key}`
  return `${parent}[${JSON.stringify(key)}]`
}

function walkTarget(field: string, value: unknown, out: DeclaredTarget[]): void {
  if (typeof value === "string") {
    if (value !== "") out.push({ field, spec: value })
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child: unknown = value[index]
      walkTarget(`${field}[${index}]`, child, out)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    walkTarget(appendField(field, key), child, out)
  }
}

/**
 * `exports`, `main`, `module`, and `bin` targets declared by one package.json.
 * A top-level `types` field is not included. `types` inside `exports` is.
 */
export function collectDeclaredTargets(manifest: Record<string, unknown>): DeclaredTarget[] {
  const targets: DeclaredTarget[] = []
  const main = stringField(manifest, "main")
  if (main) targets.push({ field: "main", spec: main })
  const moduleSpec = stringField(manifest, "module")
  if (moduleSpec) targets.push({ field: "module", spec: moduleSpec })
  walkTarget("bin", manifest.bin, targets)
  walkTarget("exports", manifest.exports, targets)
  return targets
}

/**
 * Package-root path named by a manifest target, or null when the text is not
 * a relative file (pattern, URL, package import, absolute path, or a path
 * that escapes the package root).
 */
export function resolvePackageTarget(packageDir: string, spec: string): string | null {
  if (spec.includes("*") || spec.includes("\0") || spec.includes("\n") || spec.includes("\r")) {
    return null
  }
  if (spec.startsWith("#") || spec.includes("://")) return null
  if (spec.endsWith("/")) return null
  let relativeSpec = spec.replace(/\\/g, "/")
  if (relativeSpec.startsWith("./")) relativeSpec = relativeSpec.slice(2)
  if (relativeSpec.startsWith("/") || /^[A-Za-z]:/.test(relativeSpec)) return null
  if (relativeSpec === "" || relativeSpec === ".") return null
  const joined = packageDir === "" ? relativeSpec : `${packageDir}/${relativeSpec}`
  return normalizeRelPath(joined)
}

/** True when exclude rules removed this path or a parent directory. */
export function excludedPathCovers(relativePath: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.has(relativePath)) return true
  let slash = relativePath.lastIndexOf("/")
  while (slash > 0) {
    const parent = relativePath.slice(0, slash)
    if (excluded.has(parent)) return true
    slash = parent.lastIndexOf("/")
  }
  return false
}

function packageLabel(packageDir: string, manifest: Record<string, unknown>): string {
  const dir = packageDir === "" ? "." : packageDir
  const name = stringField(manifest, "name")
  if (name && !/[\r\n]/.test(name)) return `${name} (${dir})`
  return dir
}

function byDroppedPath(left: DroppedPackageTarget, right: DroppedPackageTarget): number {
  if (left.path < right.path) return -1
  if (left.path > right.path) return 1
  if (left.packageLabel < right.packageLabel) return -1
  if (left.packageLabel > right.packageLabel) return 1
  return 0
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text)
  return value
}

/**
 * Packed package.json targets whose file was removed by exclude patterns or
 * the default excludes. Does not follow a symlink that leaves the package root.
 */
export async function droppedPackageTargets(
  root: string,
  packedFiles: readonly string[],
  excluded: ReadonlySet<string>,
): Promise<DroppedPackageTarget[]> {
  if (excluded.size === 0) return []
  const packed = new Set(packedFiles)
  const grouped = new Map<string, DroppedPackageTarget>()
  for (const relativePath of packedFiles) {
    const packageDir = packageDirOfPackedManifest(relativePath)
    if (packageDir === null) continue
    const absolute = join(root, relativePath)
    let text: string
    try {
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute)
        if (symlinkArchiveTarget(root, relativePath, target) === null) continue
      } else if (!info.isFile()) {
        continue
      }
      text = await readFile(absolute, "utf8")
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = parseJson(text)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const label = packageLabel(packageDir, parsed)
    for (const target of collectDeclaredTargets(parsed)) {
      const resolved = resolvePackageTarget(packageDir, target.spec)
      if (resolved === null || packed.has(resolved)) continue
      if (!excludedPathCovers(resolved, excluded)) continue
      const key = `${label}\0${resolved}`
      const existing = grouped.get(key)
      if (existing) {
        if (!existing.fields.includes(target.field)) existing.fields.push(target.field)
        continue
      }
      grouped.set(key, { packageLabel: label, fields: [target.field], path: resolved })
    }
  }
  const items = [...grouped.values()]
  for (const item of items) item.fields.sort()
  items.sort(byDroppedPath)
  return items
}

export function formatDroppedPackageTargets(
  items: readonly DroppedPackageTarget[],
): string | undefined {
  if (items.length === 0) return undefined
  const sorted = [...items].sort(byDroppedPath)
  const shown = sorted.slice(0, DROPPED_TARGET_LIMIT)
  const header =
    sorted.length === 1
      ? "1 package target points at a file that exclude patterns or default excludes removed. The archive omits that file. Packing continues."
      : `${sorted.length} package targets point at files that exclude patterns or default excludes removed. The archive omits those files. Packing continues.`
  const lines = [
    header,
    ...shown.map((item) => `${item.packageLabel} ${item.fields.join(", ")} dropped ${item.path}`),
  ]
  const extra = sorted.length - shown.length
  if (extra > 0) lines.push(`And ${extra} more.`)
  return lines.join("\n")
}
