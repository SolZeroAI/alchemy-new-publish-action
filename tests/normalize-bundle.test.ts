import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeBundle, stableModulePath } from "../scripts/normalize-bundle.mts"

const stable = "node_modules/minipass/index.js"
const local =
  "../home/ubuntu/.cache/nub/pm/store/v1/minipass@7.1.3-cb4055c977da96c6/node_modules/minipass/index.js"
const ci = "node_modules/.store/minipass@7.1.3/node_modules/minipass/index.js"

test("maps both nub store layouts to the package path", () => {
  assert.equal(stableModulePath(local), stable)
  assert.equal(stableModulePath(ci), stable)
  assert.equal(
    stableModulePath(
      "node_modules/.store/@actions/core@3.0.1/node_modules/@actions/core/lib/core.js",
    ),
    "node_modules/@actions/core/lib/core.js",
  )
  assert.equal(stableModulePath("src/errors.ts"), "src/errors.ts")
})

test("rewrites comments and module keys to the same text", () => {
  const bundle = (modulePath: string) =>
    `// ${modulePath}\nvar require_minipass = __commonJS({\n  "${modulePath}"(exports2) {\n    return 1\n  }\n});\n// src/index.ts\n`

  const normalized = normalizeBundle(bundle(local))
  assert.equal(normalized, normalizeBundle(bundle(ci)))
  assert.match(normalized, /\/\/ node_modules\/minipass\/index\.js/)
  assert.match(normalized, /"node_modules\/minipass\/index\.js"\(exports2\)/)
  assert.equal(normalized.includes(".cache/nub"), false)
  assert.equal(normalized.includes("node_modules/.store"), false)
  assert.match(normalized, /\/\/ src\/index\.ts/)
})
