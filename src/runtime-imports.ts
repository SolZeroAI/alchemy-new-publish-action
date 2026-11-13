import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { init, parse, type Import } from "es-module-lexer"
import { transform } from "sucrase"
import { x as extractArchive } from "tar"
import { ActionError } from "./errors.ts"
import { parseJsonc } from "./jsonc.ts"
import type { Logger } from "./log.ts"
import { normalizeRelPath } from "./paths.ts"
import { isRecord, isString, stringField, type JsonObject, type JsonValue } from "./record.ts"

export type RuntimeImportCheck = "error" | "warn" | "off"

export type ListedAs =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies"
  | "overrides"

export interface MissingImport {
  /** Archive-relative file that imports the package. */
  readonly importer: string
  readonly specifier: string
  readonly packageName: string
  /** package.json nearest to the importer. This is where dependencies belong. */
  readonly ownerManifest?: string
  /** package.json that already names the package, when that file is not the owner. */
  readonly listedManifest?: string
  readonly listedAs?: ListedAs
}

interface RuntimeSpecifier {
  specifier: string
  dynamic: boolean
}

interface PatternMatch {
  found: boolean
  target?: string
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const SKIP_SOURCE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/
const CODE_LITERAL = /["'](\.{1,2}\/[^"'\s]+\.[cm]?[jt]sx?)["']/g
const PROBE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

const VITE_CONFIGS = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.tsx",
]

const LISTED_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

/**
 * Valid npm package names. `@/x`, `~/x`, and `#x` are aliases, not packages.
 * A scoped name is `@scope/name`.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

const MISSING_LIMIT = 20

/**
 * Extract the packed archive and check the deploy-time import graph.
 * The archive is what the runner gets, after include and exclude.
 */
export async function assertRuntimeImports(
  archivePath: string,
  entrypoint: string,
  mode: RuntimeImportCheck,
  log: Logger,
): Promise<void> {
  if (mode === "off") return
  const dir = await mkdtemp(join(tmpdir(), "alchemy-new-imports-"))

  try {
    await extractArchive({ file: archivePath, cwd: dir, preservePaths: false, strict: true })
    const { missing, warnings } = await findMissingRuntimeImports(dir, entrypoint)

    for (const warning of warnings) log.warn(warning)

    if (missing.length === 0) return
    const message = formatMissingImports(missing)

    if (mode === "warn") {
      log.warn(message)

      return
    }

    throw new ActionError(message)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Import graph of an extracted package root. Tests call this directly. */
export async function findMissingRuntimeImports(
  rootDir: string,
  entrypoint: string,
): Promise<{ missing: MissingImport[]; warnings: string[] }> {
  await init()
  const root = realpathSync(rootDir)
  const seen = new Set<string>()
  const hardFiles = new Set<string>()
  const vitePackages = new Set<string>()
  const missing: MissingImport[] = []
  const warnings: string[] = []
  const queue: string[] = []

  const push = (file: string | undefined, hard = false) => {
    if (!file || !insideRoot(root, file)) return

    if (hard) hardFiles.add(file)

    if (!seen.has(file)) queue.push(file)
  }

  push(probe(join(root, entrypoint)))

  while (queue.length > 0) {
    const file = queue.pop()

    if (!file || seen.has(file)) continue
    seen.add(file)
    enqueueViteRoot(root, file, vitePackages, push)
    const hard = hardFiles.has(file)
    const label = archiveRelative(root, file)
    const source = readFileSync(file, "utf8")

    for (const item of runtimeImports(file, source, label)) {
      const specifier = stripQuery(item.specifier)

      if (specifier === "" || isForeign(specifier)) continue

      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const target = probe(resolve(dirname(file), specifier))

        if (target && isCodeFile(target)) push(target, hard)
        continue
      }

      const aliased = resolveAlias(root, file, specifier)

      if (aliased !== undefined) {
        if (aliased !== "" && isCodeFile(aliased)) push(aliased, hard)
        continue
      }

      const name = packageNameOf(specifier)

      if (!PACKAGE_NAME.test(name)) continue
      const pkgDir = findPackageDir(root, file, name)

      if (!pkgDir) {
        const record = missingRecord(root, file, specifier, name)

        if (item.dynamic && !hard) warnings.push(formatDynamicWarning(record))
        else missing.push(record)
        continue
      }

      // An installed package is a leaf. Its own dependencies belong to the lockfile.
      if (pkgDir.split(sep).includes("node_modules")) continue
      push(resolveWorkspaceExport(pkgDir, specifier, name), hard)
    }

    for (const literal of bundleEntryLiterals(source)) {
      const target = probe(resolve(dirname(file), literal))

      if (target && isCodeFile(target)) push(target)
    }
  }

  return { missing: dedupe(missing), warnings: dedupeWarnings(warnings) }
}

export function formatMissingImports(missing: readonly MissingImport[]): string {
  const lines = missing.slice(0, MISSING_LIMIT).map((item) => `- ${formatOne(item)}`)

  if (missing.length > MISSING_LIMIT) {
    lines.push(`- … ${missing.length - MISSING_LIMIT} more`)
  }

  const count = missing.length === 1 ? "a package" : `${missing.length} packages`

  return [
    `The archive is missing ${count} that the deploy imports. alchemy.new runs the stack from the archive and does not install dependencies.`,
    ...lines,
    `Move each package to "dependencies" in the package.json named above, update the lockfile, and publish a new version. A devDependency is removed by a production install or prune (nub prune --prod, npm prune --omit=dev, pnpm install --prod, bun install --production). Root "overrides" pin a version but install nothing. An exclude pattern can also drop a package that is already in dependencies. To skip this check, set runtime-import-check: warn.`,
  ].join("\n")
}

/**
 * Type-only imports are erased the way an isolatedModules transpile erases them.
 * `import type` and a binding used only as a type do not have to be installed.
 *
 * oxc-transform is what Alchemy runs at deploy, and it parses TSX and drops
 * those imports. Its Node build is a native addon. Its wasm build depends on
 * two copies of @emnapi/core, which esbuild cannot place in dist/index.cjs.
 * sucrase is pure JavaScript, parses TS and TSX, and applies that same
 * per-file elision, so the action stays one bundled file. Classic JSX emit
 * does not add a react/jsx-runtime import that the source did not write.
 */
function runtimeImports(file: string, source: string, label: string): RuntimeSpecifier[] {
  const javascript = elideTypes(file, source, label)
  let imports: readonly Import[]

  try {
    ;[imports] = parse(javascript, label)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionError(`Could not read imports in ${label}: ${message}`)
  }

  const out: RuntimeSpecifier[] = []

  for (const item of imports) {
    if (item.type === "import-meta") continue

    if (item.type === "dynamic") {
      if (item.probablyTypeOnly || item.specifier === undefined) continue
      out.push({ specifier: item.specifier, dynamic: true })
      continue
    }

    if (item.typeOnly) continue
    out.push({ specifier: item.specifier, dynamic: false })
  }

  for (const match of javascript.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const specifier = match[1]

    if (specifier) out.push({ specifier, dynamic: false })
  }

  return out
}

function elideTypes(file: string, source: string, label: string): string {
  try {
    return transform(source, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      jsxPragma: "React.createElement",
      jsxFragmentPragma: "React.Fragment",
      filePath: file,
      production: true,
      disableESTransforms: true,
    }).code
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionError(
      `Could not read imports in ${label}. The file is not valid TypeScript or JavaScript: ${message}`,
    )
  }
}

/** Relative code-file literals. Alchemy bundles a Worker `main` from one of these. */
function bundleEntryLiterals(source: string): string[] {
  const literals: string[] = []

  for (const match of source.matchAll(CODE_LITERAL)) {
    const literal = match[1]

    if (literal) literals.push(literal)
  }

  return literals
}

/**
 * Website.Vite runs vite during the deploy. The config, including its dynamic
 * imports, and the app source have to resolve. Test, spec, and stories files do not.
 */
function enqueueViteRoot(
  root: string,
  file: string,
  done: Set<string>,
  push: (file: string | undefined, hard?: boolean) => void,
): void {
  const manifest = nearest(root, dirname(file), "package.json")

  if (!manifest) return
  const pkgRoot = dirname(manifest)

  if (done.has(pkgRoot)) return
  done.add(pkgRoot)

  const config = VITE_CONFIGS.map((name) => join(pkgRoot, name)).find((candidate) =>
    isFile(candidate),
  )

  if (!config) return
  push(config, true)

  for (const sourceFile of listFiles(join(pkgRoot, "src"), root)) {
    if (isCodeFile(sourceFile) && !SKIP_SOURCE.test(sourceFile)) push(sourceFile, true)
  }
}

function missingRecord(
  root: string,
  importer: string,
  specifier: string,
  name: string,
): MissingImport {
  const owner = nearest(root, dirname(importer), "package.json")
  const listing = owner ? findListing(root, owner, name) : undefined

  const record: MissingImport = {
    importer: archiveRelative(root, importer),
    specifier,
    packageName: name,
  }

  if (!owner) return record
  const ownerManifest = archiveRelative(root, owner)

  if (!listing) return { ...record, ownerManifest }

  if (listing.manifest === ownerManifest) {
    return { ...record, ownerManifest, listedAs: listing.listedAs }
  }

  return {
    ...record,
    ownerManifest,
    listedManifest: listing.manifest,
    listedAs: listing.listedAs,
  }
}

function findListing(
  root: string,
  ownerFile: string,
  name: string,
): { listedAs: ListedAs; manifest: string } | undefined {
  let dir = dirname(ownerFile)

  while (insideRoot(root, dir)) {
    const manifest = join(dir, "package.json")
    const record = isFile(manifest) ? readJson(manifest) : undefined
    const listedAs = record ? listedField(record, name) : undefined

    if (listedAs) return { listedAs, manifest: archiveRelative(root, manifest) }

    if (dir === root) break
    dir = dirname(dir)
  }

  return undefined
}

function listedField(record: JsonObject, name: string): ListedAs | undefined {
  for (const field of LISTED_FIELDS) {
    const map = record[field]

    if (isRecord(map) && map[name] !== undefined) return field
  }

  if (overrideLists(record.overrides, name)) return "overrides"

  return undefined
}

function overrideLists(value: JsonValue | undefined, name: string): boolean {
  if (!isRecord(value)) return false
  const direct = value[name]

  if (isString(direct)) return true

  for (const nested of Object.values(value)) {
    if (isRecord(nested) && isString(nested[name])) return true
  }

  return false
}

function formatOne(item: MissingImport): string {
  const owner = item.ownerManifest
  const listedManifest = item.listedManifest ?? owner

  if (item.listedAs === "dependencies" && listedManifest) {
    return `${item.importer} imports "${item.specifier}", but package "${item.packageName}" is not in the archive where Node looks for it (listed in dependencies of ${listedManifest}). The files were removed while packing.`
  }

  const listed =
    item.listedAs && listedManifest ? ` (listed in ${item.listedAs} of ${listedManifest}).` : "."

  const where = owner ? ` Add it to dependencies in ${owner}.` : ""

  return `${item.importer} imports "${item.specifier}", but package "${item.packageName}" is not in the archive where Node looks for it${listed}${where}`
}

function formatDynamicWarning(item: MissingImport): string {
  return `Dynamic import may be missing at deploy time. ${formatOne(item)} A dynamic import outside a Vite config or app source is a warning.`
}

function findPackageDir(root: string, from: string, name: string): string | undefined {
  let dir = dirname(from)

  while (insideRoot(root, dir)) {
    const manifest = join(dir, "node_modules", name, "package.json")

    if (isFile(manifest)) {
      try {
        const pkgDir = realpathSync(dirname(manifest))

        if (!insideRoot(root, pkgDir)) return undefined

        return pkgDir
      } catch {
        return undefined
      }
    }

    if (dir === root) break
    dir = dirname(dir)
  }

  return undefined
}

function resolveWorkspaceExport(pkgDir: string, spec: string, name: string): string | undefined {
  const record = readJson(join(pkgDir, "package.json"))

  if (!record) return undefined
  const sub = spec === name ? "." : `.${spec.slice(name.length)}`
  const exported = exportsMap(record)

  if (exported) {
    const match = matchPattern(exported, sub)

    if (!match.found || !match.target) return undefined

    return probe(resolve(pkgDir, match.target))
  }

  const target =
    sub === "." ? (stringField(record, "module") ?? stringField(record, "main") ?? "index") : sub

  return probe(resolve(pkgDir, target))
}

/**
 * package.json "imports" and tsconfig "paths", following a relative "extends".
 * undefined means the specifier is not an alias. "" means it is an alias and
 * does not point at a code file (or it points at another package name).
 */
function resolveAlias(root: string, from: string, spec: string): string | undefined {
  const manifest = nearest(root, dirname(from), "package.json")

  if (manifest) {
    const record = readJson(manifest)
    const imports = record && isRecord(record.imports) ? record.imports : undefined
    const match = matchPattern(imports, spec)

    if (match.found) return fileFromImports(dirname(manifest), match.target)
  }

  const seen = new Set<string>()
  let config = nearest(root, dirname(from), "tsconfig.json")

  while (config && !seen.has(config)) {
    seen.add(config)
    const record = readJson(config)

    if (!record) break
    const compilerOptions = isRecord(record.compilerOptions) ? record.compilerOptions : undefined

    const paths =
      compilerOptions && isRecord(compilerOptions.paths) ? compilerOptions.paths : undefined

    const match = matchPattern(paths, spec)

    if (match.found) {
      const base = compilerOptions ? stringField(compilerOptions, "baseUrl") : undefined

      return fileFromPaths(resolve(dirname(config), base ?? "."), match.target)
    }

    const extended = stringField(record, "extends")

    if (!extended?.startsWith(".")) break
    const file = extended.endsWith(".json") ? extended : `${extended}.json`
    const next = resolve(dirname(config), file)

    if (!insideRoot(root, next) || !isFile(next)) break
    config = next
  }

  return undefined
}

function fileFromImports(baseDir: string, target: string | undefined): string {
  if (!target || (!target.startsWith(".") && !target.startsWith("/"))) return ""

  return probe(resolve(baseDir, target)) ?? ""
}

function fileFromPaths(baseDir: string, target: string | undefined): string {
  if (!target) return ""

  return probe(resolve(baseDir, target)) ?? ""
}

function matchPattern(map: JsonObject | undefined, key: string): PatternMatch {
  if (!map) return { found: false }

  if (Object.hasOwn(map, key)) return { found: true, target: pickTarget(map[key]) }

  for (const [pattern, value] of Object.entries(map)) {
    if (!pattern.endsWith("*")) continue
    const prefix = pattern.slice(0, -1)

    if (!key.startsWith(prefix)) continue
    const target = pickTarget(value)

    if (target === undefined) continue

    return { found: true, target: target.replace("*", key.slice(prefix.length)) }
  }

  return { found: false }
}

function pickTarget(value: JsonValue | undefined): string | undefined {
  if (isString(value)) return value

  if (Array.isArray(value)) return pickTarget(value[0])

  if (!isRecord(value)) return undefined

  return (
    pickTarget(value.workerd) ??
    pickTarget(value.import) ??
    pickTarget(value.node) ??
    pickTarget(value.module) ??
    pickTarget(value.default) ??
    pickTarget(value.require)
  )
}

function exportsMap(record: JsonObject): JsonObject | undefined {
  const value = record.exports

  if (isString(value)) return { ".": value }

  if (isRecord(value)) return value

  return undefined
}

function probe(base: string): string | undefined {
  if (isFile(base)) return base
  const bare = base.replace(/\.[cm]?js$/, "")

  for (const extension of PROBE_EXTENSIONS) {
    const file = bare + extension

    if (isFile(file)) return file
  }

  for (const extension of PROBE_EXTENSIONS) {
    const file = join(base, `index${extension}`)

    if (isFile(file)) return file
  }

  return undefined
}

function listFiles(dir: string, root: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const walk = (current: string) => {
    let real: string

    try {
      real = realpathSync(current)
    } catch {
      return
    }

    if (!insideRoot(root, real) || seen.has(real)) return
    seen.add(real)
    let entries

    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name === "node_modules") continue
      const path = join(current, entry.name)

      if (entry.isDirectory()) {
        walk(path)
        continue
      }

      if (entry.isSymbolicLink()) {
        let info

        try {
          info = statSync(path)
        } catch {
          continue
        }

        if (info.isDirectory()) walk(path)
        else if (info.isFile()) out.push(path)
        continue
      }

      if (entry.isFile()) out.push(path)
    }
  }

  if (isFile(dir)) return out
  walk(dir)

  return out
}

function nearest(root: string, dir: string, name: string): string | undefined {
  let current = dir

  while (insideRoot(root, current)) {
    const candidate = join(current, name)

    if (isFile(candidate)) return candidate

    if (current === root) break
    current = dirname(current)
  }

  return undefined
}

function readJson(file: string): JsonObject | undefined {
  try {
    const value = parseJsonc(readFileSync(file, "utf8"))

    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function insideRoot(root: string, file: string): boolean {
  const rel = relative(root, file)

  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

function isForeign(specifier: string): boolean {
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier)) return true
  const rootName = specifier.split("/")[0] ?? specifier

  return builtinModules.includes(specifier) || builtinModules.includes(rootName)
}

function packageNameOf(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? specifier
  const [scope, name] = specifier.split("/")

  if (!scope || !name) return specifier

  return `${scope}/${name}`
}

function isCodeFile(file: string): boolean {
  return CODE_FILE.test(file) && !DECLARATION_FILE.test(file)
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function stripQuery(specifier: string): string {
  return specifier.replace(/[?#].*$/, "")
}

function archiveRelative(root: string, file: string): string {
  return normalizeRelPath(relative(root, file)) ?? relative(root, file)
}

function dedupe(list: readonly MissingImport[]): MissingImport[] {
  const seen = new Set<string>()
  const out: MissingImport[] = []

  for (const item of list) {
    const key = `${item.importer}\0${item.packageName}`

    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }

  return out
}

function dedupeWarnings(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const warning of list) {
    if (seen.has(warning)) continue
    seen.add(warning)
    out.push(warning)
  }

  return out
}
