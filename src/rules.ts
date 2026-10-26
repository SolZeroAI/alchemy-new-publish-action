import { normalizeRelPath } from "./paths.ts"

const ENV_ALLOW = new Set([".env.example", ".env.sample"])
const PRIVATE_KEY_BASENAMES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
const VCS_OR_STATE = new Set([".git", ".alchemy", ".hg", ".svn"])

const EDITOR_OR_CI = new Set([
  ".github",
  ".circleci",
  ".gitlab",
  ".buildkite",
  ".husky",
  ".vscode",
  ".idea",
])

const AGENT_OR_RELEASE = new Set([".agents", ".cursor", ".claude", ".tegami", ".changeset"])

const TEST_DIRS = new Set([
  "__tests__",
  "__mocks__",
  "coverage",
  ".nyc_output",
  ".pytest_cache",
  "test",
  "tests",
])

const TEST_FILE = /\.(?:test|spec)\.[^.]+$/

function isSecretEnvFile(base: string): boolean {
  if (base === ".env") return true

  if (base === ".envrc") return true

  if (base.startsWith(".env.") && !ENV_ALLOW.has(base)) return true

  if (base !== ".env" && base.endsWith(".env")) return true

  return false
}

function isPrivateKeyName(base: string): boolean {
  const lower = base.toLowerCase()

  if (lower.endsWith(".pub")) return false

  return PRIVATE_KEY_BASENAMES.some((name) => lower === name || lower.startsWith(`${name}.`))
}

function inNodeModules(parts: string[]): boolean {
  return parts.includes("node_modules")
}

/**
 * Files the registry rejects, plus private-key filenames the contract names
 * without an exhaustive list. Returning a reason means the archive must not
 * contain this path.
 */
export function hardRejectReason(input: string): string | undefined {
  const normalized = normalizeRelPath(input)

  if (normalized === null) return "path is absolute or escapes the archive root"

  if (normalized === "") return undefined
  const parts = normalized.split("/")
  const base = parts[parts.length - 1] ?? normalized

  if (parts.some((part) => VCS_OR_STATE.has(part))) {
    const hit = parts.find((part) => VCS_OR_STATE.has(part))

    return `${hit} is not allowed (${normalized})`
  }

  if (base === ".npmrc") return `.npmrc is not allowed (${normalized})`

  if (base === ".netrc") return `.netrc is not allowed (${normalized})`

  if (isSecretEnvFile(base)) return `secret env file is not allowed (${normalized})`

  if (isPrivateKeyName(base)) return `private key is not allowed (${normalized})`

  if (base.endsWith(".pem") && !inNodeModules(parts)) {
    return `.pem outside node_modules is not allowed (${normalized})`
  }

  if (
    base.endsWith(".key") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    base.endsWith(".p8")
  ) {
    return `private key file is not allowed (${normalized})`
  }

  return undefined
}

/**
 * Default pack filter. Hard-reject paths are included so a normal checkout
 * drops `.git` and `.env` instead of failing. `.env.example` and
 * `.env.sample` stay. `.pem` inside node_modules stays. Agent and release
 * directories are dropped at any depth. Under `node_modules` only, `*.d.ts`,
 * `*.map`, and `*.md` are dropped.
 */
export function isDefaultExcluded(input: string): boolean {
  const normalized = normalizeRelPath(input)

  if (normalized === null || normalized === "") return false

  if (hardRejectReason(normalized)) return true
  const parts = normalized.split("/")
  const base = parts[parts.length - 1] ?? normalized

  if (parts.some((part) => EDITOR_OR_CI.has(part))) return true

  if (parts.some((part) => AGENT_OR_RELEASE.has(part))) return true

  if (parts.some((part) => TEST_DIRS.has(part))) return true

  if (TEST_FILE.test(base)) return true

  if (parts.includes(".cache") || parts.includes(".turbo") || parts.includes(".parcel-cache")) {
    return true
  }

  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === ".next" && parts[i + 1] === "cache") return true
  }

  if (parts.includes(".aws")) return true

  if (base === ".DS_Store" || base === "Thumbs.db") return true

  if (base === ".eslintcache" || base === ".stylelintcache") return true

  if (base.endsWith(".log") || base.endsWith(".tsbuildinfo")) return true

  if (base.endsWith(".tar.gz") || base.endsWith(".tgz")) return true

  if (base === ".gitmodules") return true

  // A build or a runtime may import markdown outside node_modules.
  if (
    inNodeModules(parts) &&
    (base.endsWith(".d.ts") || base.endsWith(".map") || base.endsWith(".md"))
  ) {
    return true
  }

  return false
}
