import { readdir } from "node:fs/promises"
import { join } from "node:path"
import ignore from "ignore"
import { ActionError } from "./errors.ts"
import { hardRejectReason, isDefaultExcluded } from "./rules.ts"
import { normalizeRelPath } from "./paths.ts"

export interface SelectOptions {
  includes: string[]
  excludes: string[]
  defaultExcludes: boolean
}

export interface Selection {
  files: string[]
  excluded: string[]
  excludedCount: number
  rejected: Array<{ path: string; reason: string }>
}

interface PatternMatcher {
  ignores(pathname: string): boolean
}

function matcher(patterns: string[], label: string): PatternMatcher {
  if (patterns.length === 0) return { ignores: () => false }
  try {
    return ignore().add(patterns)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionError(`${label} patterns are invalid: ${message}`)
  }
}

export function assertRelativePatterns(label: string, patterns: string[]): void {
  for (const pattern of patterns) {
    const body = pattern.startsWith("!") ? pattern.slice(1) : pattern
    if (body.startsWith("/") || body.split("/").includes("..")) {
      throw new ActionError(
        `${label} pattern ${JSON.stringify(pattern)} must stay relative to the package root.`,
      )
    }
  }
}

type Decision = { kind: "include" } | { kind: "exclude" } | { kind: "reject"; reason: string }

export function classifyPath(
  relativePath: string,
  options: SelectOptions,
  includes: PatternMatcher | undefined,
  excludes: PatternMatcher,
): Decision {
  const normalized = normalizeRelPath(relativePath)
  if (normalized === null || normalized === "") {
    return { kind: "reject", reason: "path is absolute or escapes the package root" }
  }
  if (excludes.ignores(normalized)) return { kind: "exclude" }
  const explicitlyIncluded = includes ? includes.ignores(normalized) : false
  if (includes && !explicitlyIncluded) return { kind: "exclude" }
  const reason = hardRejectReason(normalized)
  // An include list that names a secret fails. A normal tree still drops .git and .env.
  if (reason && (explicitlyIncluded || !options.defaultExcludes)) {
    return { kind: "reject", reason }
  }
  if (options.defaultExcludes && isDefaultExcluded(normalized)) return { kind: "exclude" }
  if (reason) return { kind: "reject", reason }
  return { kind: "include" }
}

const EXCLUDED_SAMPLE = 200

/** Walk `root` and choose files to pack. Does not follow directory symlinks. */
export async function selectFiles(root: string, options: SelectOptions): Promise<Selection> {
  assertRelativePatterns("include", options.includes)
  assertRelativePatterns("exclude", options.excludes)
  const includes = options.includes.length > 0 ? matcher(options.includes, "include") : undefined
  const excludes = matcher(options.excludes, "exclude")
  const files: string[] = []
  const excluded: string[] = []
  let excludedCount = 0
  const rejected: Array<{ path: string; reason: string }> = []

  async function walk(relDir: string): Promise<void> {
    const absolute = relDir === "" ? root : join(root, relDir)
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`
      const decision = classifyPath(rel, options, includes, excludes)
      if (decision.kind === "exclude") {
        excludedCount += 1
        if (excluded.length < EXCLUDED_SAMPLE) excluded.push(rel)
        continue
      }
      if (decision.kind === "reject") {
        rejected.push({ path: rel, reason: decision.reason })
        continue
      }
      if (entry.isSymbolicLink()) {
        files.push(rel)
        continue
      }
      if (entry.isDirectory()) {
        await walk(rel)
        continue
      }
      if (entry.isFile()) {
        files.push(rel)
        continue
      }
      excludedCount += 1
      if (excluded.length < EXCLUDED_SAMPLE) excluded.push(rel)
    }
  }

  await walk("")
  files.sort()
  return { files, excluded, excludedCount, rejected }
}
