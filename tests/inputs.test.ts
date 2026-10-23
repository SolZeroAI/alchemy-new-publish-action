import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseActionInputs, parseList } from "../src/inputs.ts"
import { DEFAULT_REGISTRY_URL } from "../src/constants.ts"

describe("parseActionInputs", () => {
  it("applies defaults", () => {
    const inputs = parseActionInputs({})
    assert.equal(DEFAULT_REGISTRY_URL, "https://api.alchemy.new")
    assert.equal(inputs.registryUrl, "https://api.alchemy.new")
    assert.equal(inputs.dryRun, false)
    assert.equal(inputs.defaultExcludes, true)
    assert.equal(inputs.onImmutable, "fail")
    assert.equal(inputs.token, undefined)
  })

  it("falls back to production when registry-url is blank", () => {
    const inputs = parseActionInputs({ registryUrl: "  " })
    assert.equal(inputs.registryUrl, "https://api.alchemy.new")
  })

  it("keeps an explicit registry-url", () => {
    const inputs = parseActionInputs({ registryUrl: " https://api-pre.alchemy.new " })
    assert.equal(inputs.registryUrl, "https://api-pre.alchemy.new")
  })

  it("parses lists and booleans", () => {
    assert.deepEqual(parseList("dist\n# comment\n\nnode_modules\n"), ["dist", "node_modules"])
    const inputs = parseActionInputs({
      package: " example-org/example-stack ",
      dryRun: "true",
      onImmutable: "skip-if-digest-matches",
      include: ["alchemy.new.jsonc", "dist"],
    } as Parameters<typeof parseActionInputs>[0])
    assert.equal(inputs.packageInput, "example-org/example-stack")
    assert.equal(inputs.dryRun, true)
    assert.equal(inputs.onImmutable, "skip-if-digest-matches")
    assert.deepEqual(inputs.include, ["alchemy.new.jsonc", "dist"])
  })

  it("rejects a bad on-immutable value", () => {
    assert.throws(() => parseActionInputs({ onImmutable: "replace" }), /on-immutable/)
  })
})
