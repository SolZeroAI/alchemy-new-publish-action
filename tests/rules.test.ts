import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import ignore from "ignore"
import { hardRejectReason, isDefaultExcluded } from "../src/rules.ts"
import { classifyPath, selectFiles } from "../src/select.ts"

describe("archive rules", () => {
  const cases: Array<[string, boolean]> = [
    [".git/HEAD", true],
    [".alchemy/state.json", true],
    [".env", true],
    [".env.local", true],
    [".envrc", true],
    ["production.env", true],
    [".env.example", false],
    [".env.sample", false],
    [".npmrc", true],
    [".netrc", true],
    ["id_rsa", true],
    ["node_modules/leftpad/id_rsa", true],
    ["id_rsa.pub", false],
    ["cert.pem", true],
    ["node_modules/alchemy/cert.pem", false],
    ["keys/server.key", true],
    ["node_modules/pkg/fixture.key", true],
    ["__tests__/app.test.ts", true],
    ["src/app.test.ts", true],
    ["src/app.spec.ts", true],
    ["src/app.ts", false],
    ["test/fixture.json", true],
    ["node_modules/.cache/junk", true],
    [".github/workflows/release.yml", true],
    ["node_modules/alchemy/bin/cli.js", false],
    ["alchemy.new.jsonc", false],
    ["README.md", false],
    ["docs/guide.md", false],
    ["src/types.d.ts", false],
    ["dist/app.js.map", false],
    ["alchemy.new.tar.gz", true],
    [".agents/skills/SKILL.md", true],
    ["packages/web/.agents/notes.md", true],
    [".cursor/BUGBOT.md", true],
    ["apps/web/.cursor/rules.md", true],
    [".claude/settings.json", true],
    [".tegami/publish-lock.yaml", true],
    ["vendor/pkg/.tegami/note.md", true],
    [".changeset/config.json", true],
    ["packages/ui/.changeset/slow.md", true],
    ["node_modules/leftpad/index.d.ts", true],
    ["node_modules/leftpad/index.ts", false],
    ["node_modules/leftpad/dist/index.js.map", true],
    ["node_modules/leftpad/README.md", true],
    ["node_modules/@types/node/index.d.ts", true],
    ["apps/web/node_modules/react/index.d.ts", true],
    ["node_modules/pkg/index.js", false],
    ["node_modules/pkg/package.json", false],
    ["node_modules/pkg/.env.example", false],
    ["node_modules/pkg/.env", true],
  ]

  for (const [path, excluded] of cases) {
    it(`${excluded ? "excludes" : "keeps"} ${path}`, () => {
      assert.equal(isDefaultExcluded(path), excluded)
    })
  }

  it("rejects secrets that an include list tried to pack", () => {
    const includes = ignore().add([".env", "src"])

    const decision = classifyPath(
      ".env",
      { includes: [".env"], excludes: [], defaultExcludes: true },
      includes,
      {
        ignores: () => false,
      },
    )

    assert.equal(decision.kind, "reject")
  })

  it("drops .git from a normal tree instead of failing", () => {
    const decision = classifyPath(
      ".git",
      { includes: [], excludes: [], defaultExcludes: true },
      undefined,
      {
        ignores: () => false,
      },
    )

    assert.equal(decision.kind, "exclude")
    assert.match(hardRejectReason(".git/HEAD") ?? "", /\.git/)
  })

  it("fails closed when default excludes are off", () => {
    const decision = classifyPath(
      ".env",
      { includes: [], excludes: [], defaultExcludes: false },
      undefined,
      {
        ignores: () => false,
      },
    )

    assert.equal(decision.kind, "reject")
  })

  it("rejects a secret inside an agent directory when include names that path", () => {
    const includes = ignore().add([".cursor"])

    const decision = classifyPath(
      ".cursor/.env",
      { includes: [".cursor"], excludes: [], defaultExcludes: true },
      includes,
      { ignores: () => false },
    )

    assert.equal(decision.kind, "reject")
    assert.match(hardRejectReason(".cursor/.env") ?? "", /secret env file/)
  })

  it("keeps project markdown that an include list names", () => {
    const includes = ignore().add(["README.md", "docs"])

    const decision = classifyPath(
      "docs/guide.md",
      { includes: ["README.md", "docs"], excludes: [], defaultExcludes: true },
      includes,
      { ignores: () => false },
    )

    assert.equal(decision.kind, "include")
  })

  it("lets a user exclude drop markdown that the defaults keep", () => {
    const includes = ignore().add(["docs", "README.md"])
    const excludes = ignore().add(["docs/**/*.md"])

    const decision = classifyPath(
      "docs/guide.md",
      { includes: ["docs", "README.md"], excludes: ["docs/**/*.md"], defaultExcludes: true },
      includes,
      excludes,
    )

    assert.equal(decision.kind, "exclude")
  })

  it("does not let include put a node_modules declaration back while defaults are on", () => {
    const includes = ignore().add(["node_modules"])

    const decision = classifyPath(
      "node_modules/leftpad/index.d.ts",
      { includes: ["node_modules"], excludes: [], defaultExcludes: true },
      includes,
      { ignores: () => false },
    )

    assert.equal(decision.kind, "exclude")
  })

  it("lets include put a node_modules declaration back when defaults are off", () => {
    const includes = ignore().add(["node_modules"])

    const decision = classifyPath(
      "node_modules/leftpad/index.d.ts",
      { includes: ["node_modules"], excludes: [], defaultExcludes: false },
      includes,
      { ignores: () => false },
    )

    assert.equal(decision.kind, "include")
  })
})

const TREE = [
  "README.md",
  "docs/guide.md",
  "src/app.js",
  "src/types.d.ts",
  "dist/app.js.map",
  "packages/ui/index.js",
  "packages/ui/.changeset/change.md",
  ".cursor/rules.md",
  ".cursor/.env",
  ".agents/skills/SKILL.md",
  ".claude/settings.json",
  ".tegami/note.md",
  ".changeset/config.json",
  "node_modules/pkg/index.js",
  "node_modules/pkg/index.d.ts",
  "node_modules/pkg/index.js.map",
  "node_modules/pkg/README.md",
  "node_modules/pkg/package.json",
  ".env",
]

async function writeTree(root: string): Promise<void> {
  for (const rel of TREE) {
    const absolute = join(root, rel)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, rel.endsWith(".env") ? "TOKEN=secret\n" : "x\n")
  }
}

describe("default excludes with include and exclude", () => {
  it("drops agent directories and node_modules metadata, and keeps project markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-rules-"))

    try {
      await writeTree(root)

      const selection = await selectFiles(root, {
        includes: [],
        excludes: [],
        defaultExcludes: true,
      })

      assert.deepEqual(selection.files, [
        "README.md",
        "dist/app.js.map",
        "docs/guide.md",
        "node_modules/pkg/index.js",
        "node_modules/pkg/package.json",
        "packages/ui/index.js",
        "src/app.js",
        "src/types.d.ts",
      ])
      assert.deepEqual(selection.rejected, [])
      assert.equal(selection.files.includes("node_modules/pkg/README.md"), false)
      assert.equal(selection.files.includes(".cursor/.env"), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("applies a user exclude and still drops the new defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-rules-"))

    try {
      await writeTree(root)

      const selection = await selectFiles(root, {
        includes: ["src", "docs", "dist", "README.md", "node_modules", ".cursor", "packages"],
        excludes: ["dist/**/*.map", "docs/guide.md"],
        defaultExcludes: true,
      })

      assert.deepEqual(selection.files, [
        "README.md",
        "node_modules/pkg/index.js",
        "node_modules/pkg/package.json",
        "packages/ui/index.js",
        "src/app.js",
        "src/types.d.ts",
      ])
      assert.deepEqual(selection.rejected, [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("re-adds a soft-excluded path only when default excludes are off", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-rules-"))

    try {
      await writeTree(root)

      const selection = await selectFiles(root, {
        includes: [
          "src",
          "node_modules",
          ".cursor",
          ".env",
          "README.md",
          "docs",
          "packages",
          "dist",
        ],
        excludes: ["README.md"],
        defaultExcludes: false,
      })

      assert.deepEqual(selection.files, [
        ".cursor/rules.md",
        "dist/app.js.map",
        "docs/guide.md",
        "node_modules/pkg/index.d.ts",
        "node_modules/pkg/index.js",
        "node_modules/pkg/index.js.map",
        "node_modules/pkg/package.json",
        "packages/ui/.changeset/change.md",
        "packages/ui/index.js",
        "src/app.js",
        "src/types.d.ts",
      ])
      assert.deepEqual(selection.rejected.map((item) => item.path).sort(), [".cursor/.env", ".env"])

      for (const item of selection.rejected) {
        assert.match(item.reason, /secret env file/)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
