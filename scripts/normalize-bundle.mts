import { readFileSync, writeFileSync } from "node:fs"

// esbuild records each module's resolved path in a comment and in the
// __commonJS key. nub's global store and CI's project store differ, and the
// global store adds a content hash. Keep the package path after the last
// node_modules segment so dist/index.cjs matches on every machine.
export function stableModulePath(modulePath: string): string {
  const parts = modulePath.split("/node_modules/")

  if (parts.length === 1) return modulePath

  return `node_modules/${parts[parts.length - 1]}`
}

export function normalizeBundle(source: string): string {
  const paths = new Set<string>()

  for (const match of source.matchAll(/^(?:\/\/ | {2}")([^\n"]+)/gm)) {
    const found = match[1]

    if (found?.includes("/node_modules/") || found?.startsWith("node_modules/.store/")) {
      paths.add(found)
    }
  }

  let next = source

  for (const original of [...paths].sort((a, b) => b.length - a.length)) {
    const stable = stableModulePath(original)

    if (stable === original) continue
    next = next.split(original).join(stable)
  }

  return next
}

if (process.argv[1]?.endsWith("normalize-bundle.mts")) {
  const file = new URL("../dist/index.cjs", import.meta.url)
  const source = readFileSync(file, "utf8")
  const normalized = normalizeBundle(source)

  if (normalized !== source) writeFileSync(file, normalized)
}
