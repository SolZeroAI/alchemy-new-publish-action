import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ActionError } from "../src/errors.ts"
import { resolveVersion, versionFromGitRef } from "../src/semver.ts"

describe("resolveVersion", () => {
  it("prefers an explicit version and strips one leading v", () => {
    assert.equal(resolveVersion({ explicit: "v1.2.3", gitRef: "refs/tags/v9.9.9" }), "1.2.3")
  })

  it("reads a semver tag and ignores branch names", () => {
    assert.equal(versionFromGitRef("refs/tags/v1.2.3-rc.1"), "1.2.3-rc.1")
    assert.equal(versionFromGitRef("refs/heads/v1.2.3"), undefined)
    assert.equal(versionFromGitRef("refs/tags/nightly"), undefined)
    assert.equal(resolveVersion({ gitRef: "refs/tags/v1.2.3" }), "1.2.3")
  })

  it("falls through to source.version when the ref is not a semver tag", () => {
    assert.equal(resolveVersion({ gitRef: "refs/heads/master", manifestVersion: "1.4.0" }), "1.4.0")
  })

  it("rejects build metadata and mismatched manifest versions", () => {
    assert.throws(
      () => resolveVersion({ explicit: "1.2.3+build.1" }),
      (cause: unknown) => cause instanceof ActionError && /build metadata/.test(cause.message),
    )
    assert.throws(() => resolveVersion({ gitRef: "refs/tags/v1.2.3+sha.1" }), /build metadata/)
    assert.throws(
      () => resolveVersion({ explicit: "1.2.3", manifestVersion: "1.2.4" }),
      /does not match/,
    )
  })

  it("fails when nothing names a version", () => {
    assert.throws(
      () => resolveVersion({ gitRef: "refs/heads/master" }),
      /Could not resolve a version/,
    )
  })
})
