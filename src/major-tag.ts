/** Package name Tegami uses in `name@version` git tags. */
export const PACKAGE_TAG_NAME = 'alchemy-new-publish-action'

const RELEASE =
  /^(?:(?<name>[A-Za-z0-9._-]+)@|v)(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/**
 * The floating major tag Actions users pin, or undefined when HEAD is not a stable 1.x.y release.
 * Accepts Tegami's `alchemy-new-publish-action@1.2.3` tag and a `v1.2.3` tag.
 * Prereleases and other majors do not move `v1`.
 */
export function floatingTagForRelease(
  tags: readonly string[],
  packageName = PACKAGE_TAG_NAME,
): 'v1' | undefined {
  const stableMajors: number[] = []
  for (const tag of tags) {
    const match = RELEASE.exec(tag)
    if (!match?.groups) continue
    if (match.groups.name !== undefined && match.groups.name !== packageName) continue
    if (match.groups.pre) continue
    stableMajors.push(Number(match.groups.major))
  }
  if (stableMajors.length === 0) return undefined
  if (stableMajors.every((major) => major === 1)) return 'v1'
  return undefined
}
