import { ActionError } from "./errors.ts"

/** Exact semver, optional leading v, no build metadata. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/**
 * Returns the canonical version without a leading v.
 * Undefined when the value is not exact semver.
 * Build metadata is rejected by the caller so the error can name it.
 */
function parseSemver(input: string): string | undefined {
  const trimmed = input.trim()
  const bare = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed
  if (!SEMVER.test(bare)) return undefined
  return bare
}

export function canonicalVersion(input: string, label: string): string {
  if (input.includes("+")) {
    throw new ActionError(
      `${label} ${input} includes build metadata. alchemy.new versions are exact semver without build metadata.`,
    )
  }
  const parsed = parseSemver(input)
  if (!parsed) {
    throw new ActionError(
      `${label} ${input} is not exact semver without build metadata. Example: 1.2.3 or 1.2.3-rc.1.`,
    )
  }
  return parsed
}

/** Tag refs only. Branch names are never versions. Non-semver tags are ignored. */
export function versionFromGitRef(ref: string | undefined): string | undefined {
  if (!ref?.startsWith("refs/tags/")) return undefined
  const name = ref.slice("refs/tags/".length)
  if (name.includes("+")) {
    throw new ActionError(
      `Git tag ${name} includes build metadata. alchemy.new versions are exact semver without build metadata.`,
    )
  }
  return parseSemver(name)
}

export function resolveVersion(input: {
  explicit?: string
  gitRef?: string
  manifestVersion?: string
}): string {
  let version: string
  if (input.explicit) {
    version = canonicalVersion(input.explicit, "Version")
  } else {
    const fromTag = versionFromGitRef(input.gitRef)
    if (fromTag) {
      version = fromTag
    } else if (input.manifestVersion) {
      version = canonicalVersion(input.manifestVersion, "source.version")
    } else {
      throw new ActionError(
        "Could not resolve a version. Pass version, run from a semver tag such as v1.2.3, or set source.version in alchemy.new.jsonc.",
      )
    }
  }

  if (input.manifestVersion) {
    const manifest = canonicalVersion(input.manifestVersion, "source.version")
    if (manifest !== version) {
      throw new ActionError(
        `Version ${version} does not match alchemy.new.jsonc source.version ${manifest}. The manifest source must name this package, and a pinned source.version has to be the version being published.`,
      )
    }
  }
  return version
}
