import { type Stats } from "node:fs"
import { readdir, readlink, stat } from "node:fs/promises"
import { join } from "node:path"
import ignore from "ignore"
import { ALCHEMY_PACKAGE_PATH } from "./constants.ts"
import { ActionError } from "./errors.ts"
import {
  packageRelativeTarget,
  relativeArchiveLink,
  symlinkArchiveTarget,
  symlinkProblem,
  type OutsideSymlink,
} from "./links.ts"
import { normalizeRelPath } from "./paths.ts"
import { hardRejectReason, isDefaultExcluded } from "./rules.ts"

interface SelectOptions {
  includes: string[]
  excludes: string[]
  defaultExcludes: boolean
}

interface Selection {
  files: string[]
  /** Relative symlink text for paths expanded from `node_modules/alchemy`. */
  links: Map<string, string>
  excluded: string[]
  excludedCount: number
  /** Every path exclude rules removed, including paths past the summary sample. */
  excludedPaths: Set<string>
  /** Symlinks whose link text leaves the package root. The target was not followed. */
  outsideLinks: OutsideSymlink[]
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

function assertRelativePatterns(label: string, patterns: string[]): void {
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

function fsErrorCode(error: unknown): string {
  if (!(error instanceof Error) || !("code" in error)) return ""
  return String(error.code)
}

/**
 * Walk `root` and choose files to pack.
 * Directory symlinks stay as one entry, except `node_modules/alchemy` when it
 * points at a directory inside the package. An absolute target is accepted
 * when that directory stays inside the package root. The link is expanded into
 * one relative symlink per file so `node_modules/alchemy/bin/cli.js` is a member.
 */
export async function selectFiles(root: string, options: SelectOptions): Promise<Selection> {
  assertRelativePatterns("include", options.includes)
  assertRelativePatterns("exclude", options.excludes)
  const includes = options.includes.length > 0 ? matcher(options.includes, "include") : undefined
  const excludes = matcher(options.excludes, "exclude")
  const files: string[] = []
  const links = new Map<string, string>()
  const excluded: string[] = []
  const excludedPaths = new Set<string>()
  let excludedCount = 0
  const outsideLinks: OutsideSymlink[] = []
  const rejected: Array<{ path: string; reason: string }> = []

  const noteExcluded = (rel: string): void => {
    excludedCount += 1
    excludedPaths.add(rel)
    if (excluded.length < EXCLUDED_SAMPLE) excluded.push(rel)
  }

  const noteOutside = (path: string, target: string): void => {
    outsideLinks.push({ path, target })
  }

  const noteRejected = (path: string, reason: string): void => {
    rejected.push({ path, reason })
  }

  async function walkLinked(realDir: string, logicalDir: string): Promise<void> {
    const entries = await readdir(join(root, realDir), { withFileTypes: true })
    for (const entry of entries) {
      const logical = `${logicalDir}/${entry.name}`
      const real = `${realDir}/${entry.name}`
      const decision = classifyPath(logical, options, includes, excludes)
      if (decision.kind === "exclude") {
        noteExcluded(logical)
        continue
      }
      if (decision.kind === "reject") {
        noteRejected(logical, decision.reason)
        continue
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(join(root, real))
        const resolved = packageRelativeTarget(root, real, target)
        if (resolved === null) {
          noteOutside(logical, target)
          continue
        }
        const reason = hardRejectReason(resolved)
        if (reason) {
          noteRejected(logical, `symlink ${logical} points at a forbidden path (${resolved})`)
          continue
        }
        recordLink(logical, resolved)
        continue
      }
      if (entry.isDirectory()) {
        await walkLinked(real, logical)
        continue
      }
      if (entry.isFile()) {
        recordLink(logical, real)
        continue
      }
      noteExcluded(logical)
    }
  }

  function recordLink(logical: string, real: string): void {
    const target = relativeArchiveLink(logical, real)
    const problem = symlinkProblem(logical, target)
    if (problem) {
      noteRejected(logical, problem)
      return
    }
    files.push(logical)
    links.set(logical, target)
  }

  async function expandAlchemyLink(rel: string): Promise<boolean> {
    const target = await readlink(join(root, rel))
    const resolved = packageRelativeTarget(root, rel, target)
    if (resolved === null) {
      noteOutside(rel, target)
      return true
    }
    if (resolved === rel || resolved.startsWith(`${rel}/`)) {
      noteRejected(rel, `symlink ${rel} points at itself (${target})`)
      return true
    }
    let info: Stats
    try {
      info = await stat(join(root, resolved))
    } catch (error) {
      const code = fsErrorCode(error)
      if (code === "ENOENT") return false
      if (code === "ELOOP") {
        noteRejected(rel, `symlink ${rel} points at itself (${target})`)
        return true
      }
      throw error
    }
    if (!info.isDirectory()) return false
    await walkLinked(resolved, rel)
    return true
  }

  async function walk(relDir: string): Promise<void> {
    const absolute = relDir === "" ? root : join(root, relDir)
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`
      const decision = classifyPath(rel, options, includes, excludes)
      if (decision.kind === "exclude") {
        noteExcluded(rel)
        continue
      }
      if (decision.kind === "reject") {
        noteRejected(rel, decision.reason)
        continue
      }
      if (entry.isSymbolicLink()) {
        if (rel === ALCHEMY_PACKAGE_PATH && (await expandAlchemyLink(rel))) continue
        const target = await readlink(join(root, rel))
        // Link text only. Do not stat or walk a target that leaves the package.
        if (symlinkArchiveTarget(root, rel, target) === null) {
          noteOutside(rel, target)
          continue
        }
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
      noteExcluded(rel)
    }
  }

  await walk("")
  files.sort()
  return { files, links, excluded, excludedCount, excludedPaths, outsideLinks, rejected }
}
