import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { MAX_MANIFEST_BYTES } from "../src/constants.ts"
import { parseManifest } from "../src/manifest.ts"
import { resolvePackage } from "../src/package-ref.ts"
import { manifestText } from "./helpers.ts"

describe("parseManifest", () => {
  it("reads a registry source and a relative entrypoint", () => {
    const manifest = parseManifest(
      manifestText({ version: "1.2.3", entrypoint: "./alchemy.run.ts" }),
    )
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.source.org, "example-org")
    assert.equal(manifest.source.project, "example-stack")
    assert.equal(manifest.source.version, "1.2.3")
    assert.equal(manifest.entrypoint, "alchemy.run.ts")
  })

  it("rejects schema version 2, unknown fields, a non-registry source, and a huge file", () => {
    assert.throws(() => parseManifest('{ "schemaVersion": 2 }'), /schemaVersion must be 1/)
    assert.throws(() => parseManifest("x".repeat(MAX_MANIFEST_BYTES + 1)), /256 KB/)
    assert.throws(
      () => parseManifest(manifestText({ extra: '"deployment.artifact": "nope"' })),
      /unknown fields/,
    )
    const github = manifestText().replace('"kind": "registry"', '"kind": "github"')
    assert.throws(() => parseManifest(github), /source.kind must be "registry"/)
  })
})

describe("resolvePackage", () => {
  const manifest = { manifestOrg: "example-org", manifestProject: "example-stack" }

  it("reads org/project from the manifest", () => {
    assert.deepEqual(resolvePackage(manifest), { org: "example-org", project: "example-stack" })
  })

  it("accepts package when it matches the manifest", () => {
    assert.deepEqual(resolvePackage({ ...manifest, packageInput: "example-org/example-stack" }), {
      org: "example-org",
      project: "example-stack",
    })
  })

  it("rejects a package that names something else", () => {
    assert.throws(
      () => resolvePackage({ ...manifest, packageInput: "other/stack" }),
      /must name the package/,
    )
    assert.throws(() => resolvePackage({ ...manifest, org: "other" }), /must name the package/)
  })
})
