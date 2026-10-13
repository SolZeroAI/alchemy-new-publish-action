import { ActionError } from "./errors.ts"

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface PackageRef {
  org: string
  project: string
}

export function parsePackage(input: string): PackageRef {
  const trimmed = input.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || trimmed.indexOf("/", slash + 1) !== -1) {
    throw new ActionError(`Package must be org/project. Received ${JSON.stringify(trimmed)}.`)
  }
  return {
    org: assertSegment(trimmed.slice(0, slash), "org"),
    project: assertSegment(trimmed.slice(slash + 1), "project"),
  }
}

export function assertSegment(value: string, label: string): string {
  if (!SEGMENT.test(value)) {
    throw new ActionError(
      `Package ${label} must be 1-64 characters of letters, numbers, ".", "_", or "-", and start with a letter or number. Received ${JSON.stringify(value)}.`,
    )
  }
  return value
}

/**
 * `package` wins when set. `org` and `project` fill gaps or must agree with it.
 * The manifest source has to name the same package.
 */
export function resolvePackage(input: {
  packageInput?: string
  org?: string
  project?: string
  manifestOrg: string
  manifestProject: string
}): PackageRef {
  const manifestOrg = assertSegment(input.manifestOrg, "org")
  const manifestProject = assertSegment(input.manifestProject, "project")
  let org = manifestOrg
  let project = manifestProject

  if (input.packageInput) {
    const parsed = parsePackage(input.packageInput)
    org = parsed.org
    project = parsed.project
  }
  if (input.org) {
    const explicit = assertSegment(input.org, "org")
    if (input.packageInput && explicit !== org) {
      throw new ActionError(`Input org (${explicit}) does not match package (${org}/${project}).`)
    }
    org = explicit
  }
  if (input.project) {
    const explicit = assertSegment(input.project, "project")
    if (input.packageInput && explicit !== project) {
      throw new ActionError(
        `Input project (${explicit}) does not match package (${org}/${project}).`,
      )
    }
    project = explicit
  }

  if (org !== manifestOrg || project !== manifestProject) {
    throw new ActionError(
      `alchemy.new.jsonc source is ${manifestOrg}/${manifestProject}, but the action resolved ${org}/${project}. The manifest source must name the package being published.`,
    )
  }
  return { org, project }
}
