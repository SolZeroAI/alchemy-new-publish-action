import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { packFiles } from "../src/archive.ts"
import { ActionError } from "../src/errors.ts"
import type { Logger } from "../src/log.ts"
import {
  collectDeclaredTargets,
  excludedPathCovers,
  packageDirOfPackedManifest,
  resolvePackageTarget,
} from "../src/package-targets.ts"
import { publish } from "../src/publish.ts"
import type { RegistryClient, VersionRecord } from "../src/registry.ts"
import { makePackage, manifestText } from "./helpers.ts"

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info(message) {
      lines.push(message)
    },
    warn(message) {
      lines.push(message)
    },
  }
}

const publishBase = {
  version: "1.2.3",
  include: [] as string[],
  exclude: [] as string[],
  defaultExcludes: true,
  registryUrl: "https://api.alchemy.new",
  dryRun: true,
  onImmutable: "fail" as const,
  fetchImpl: async () => {
    throw new Error("dry-run called the network")
  },
}

describe("outside-root symlinks", () => {
  it("names every link and its raw target in one failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-outside-pack-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-outside-pack-out-"))
    const destination = join(out, "outside.tar.gz")
    try {
      writeFileSync(join(root, "keep.txt"), "keep")
      symlinkSync("../global-store/foo/../pkg", join(root, "rel-link"))
      symlinkSync("/tmp/alchemy-global-store/missing", join(root, "abs-link"))
      await assert.rejects(
        () => packFiles(root, ["keep.txt", "rel-link", "abs-link"], destination),
        (error: unknown) => {
          assert.ok(error instanceof ActionError)
          const message = error.message
          assert.match(message, /2 symlinks point outside the package root/)
          assert.match(message, /NPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false/)
          assert.match(
            message,
            /symlink abs-link points outside the package root \(\/tmp\/alchemy-global-store\/missing\)/,
          )
          assert.match(
            message,
            /symlink rel-link points outside the package root \(\.\.\/global-store\/foo\/\.\.\/pkg\)/,
          )
          assert.equal(message.includes("keep.txt"), false)
          return true
        },
      )
      assert.equal(existsSync(destination), false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("reports outside links from a directory pack without following them", async () => {
    const parent = await mkdtemp(join(tmpdir(), "alchemy-outside-pub-"))
    const root = join(parent, "pkg")
    const outside = join(parent, "global-store")
    try {
      mkdirSync(root)
      mkdirSync(join(outside, "pkg"), { recursive: true })
      writeFileSync(join(outside, "pkg", "global-store-secret.txt"), "secret-bytes")
      writeFileSync(join(root, "alchemy.new.jsonc"), manifestText())
      writeFileSync(join(root, "alchemy.run.ts"), "export {}\n")
      mkdirSync(join(root, "node_modules"), { recursive: true })
      for (let index = 0; index < 25; index += 1) {
        const name = String(index).padStart(2, "0")
        symlinkSync(
          `../../global-store/link-${name}/foo/../pkg`,
          join(root, "node_modules", `link-${name}`),
        )
      }
      await assert.rejects(
        () => publish({ ...publishBase, path: root }),
        (error: unknown) => {
          assert.ok(error instanceof ActionError)
          const message = error.message
          assert.match(message, /25 symlinks point outside the package root/)
          assert.match(message, /does not follow the link/)
          assert.match(message, /NPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false/)
          assert.match(
            message,
            /symlink node_modules\/link-00 points outside the package root \(\.\.\/\.\.\/global-store\/link-00\/foo\/\.\.\/pkg\)/,
          )
          assert.match(
            message,
            /symlink node_modules\/link-19 points outside the package root \(\.\.\/\.\.\/global-store\/link-19\/foo\/\.\.\/pkg\)/,
          )
          assert.match(message, /And 5 more\./)
          assert.equal(message.includes("link-20"), false)
          assert.equal(message.includes("link-24"), false)
          assert.equal(message.includes("global-store-secret"), false)
          assert.equal(message.includes(outside), false)
          return true
        },
      )
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe("excluded package targets", () => {
  it("resolves manifest paths for root and node_modules packages", () => {
    assert.equal(packageDirOfPackedManifest("package.json"), "")
    assert.equal(packageDirOfPackedManifest("node_modules/foo/package.json"), "node_modules/foo")
    assert.equal(
      packageDirOfPackedManifest("node_modules/@scope/pkg/package.json"),
      "node_modules/@scope/pkg",
    )
    assert.equal(
      packageDirOfPackedManifest("node_modules/.pnpm/foo@1.0.0/node_modules/foo/package.json"),
      "node_modules/.pnpm/foo@1.0.0/node_modules/foo",
    )
    assert.equal(packageDirOfPackedManifest("vendor/package.json"), null)
    assert.equal(packageDirOfPackedManifest("node_modules/foo/dist/package.json"), null)
    assert.equal(packageDirOfPackedManifest("node_modules/@scope/package.json"), null)
    assert.equal(
      resolvePackageTarget("node_modules/foo", "./index.d.ts"),
      "node_modules/foo/index.d.ts",
    )
    assert.equal(resolvePackageTarget("", "./docs/guide.md"), "docs/guide.md")
    assert.equal(resolvePackageTarget("node_modules/foo", "./*"), null)
    assert.equal(resolvePackageTarget("", "../outside.js"), null)
    assert.equal(resolvePackageTarget("node_modules/foo", "/etc/passwd"), null)
    assert.equal(resolvePackageTarget("node_modules/foo", "#internal"), null)
    const targets = collectDeclaredTargets({
      main: "./index.js",
      module: "./index.mjs",
      bin: { cli: "./bin/cli.js" },
      types: "./index.d.ts",
      exports: {
        ".": { types: "./index.d.ts", import: "./index.js" },
        "./*": "./*",
      },
    })
    assert.deepEqual(
      targets.map((item) => item.field),
      ["main", "module", "bin.cli", 'exports["."].types', 'exports["."].import', 'exports["./*"]'],
    )
    const excluded = new Set(["docs", "node_modules/typed/index.d.ts"])
    assert.equal(excludedPathCovers("docs/guide.md", excluded), true)
    assert.equal(excludedPathCovers("docs", excluded), true)
    assert.equal(excludedPathCovers("docs-extra/guide.md", excluded), false)
    assert.equal(excludedPathCovers("node_modules/typed/index.d.ts", excluded), true)
    assert.equal(excludedPathCovers("node_modules/typed/index.js", excluded), false)
  })

  it("warns once for excluded exports, main, module, and bin targets", async () => {
    const pkg = await makePackage()
    const log = recordingLogger()
    const summaries: string[] = []
    try {
      const root = pkg.root
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "example-stack",
          main: "./dist/app.js",
          module: "./docs/guide.md",
          bin: "./tools/run.js",
          exports: { ".": "./missing.js" },
        }),
      )
      await mkdir(join(root, "docs"), { recursive: true })
      await mkdir(join(root, "tools"), { recursive: true })
      await writeFile(join(root, "docs/guide.md"), "# guide\n")
      await writeFile(join(root, "tools/run.js"), "console.log('run')\n")
      await mkdir(join(root, "node_modules/typed"), { recursive: true })
      await writeFile(
        join(root, "node_modules/typed/package.json"),
        JSON.stringify({
          name: "typed",
          main: "./index.js",
          exports: {
            ".": {
              types: "./index.d.ts",
              import: "./index.js",
              default: "./readme.md",
            },
          },
          bin: { typed: "./cli.js" },
        }),
      )
      await writeFile(join(root, "node_modules/typed/index.d.ts"), "export {}\n")
      await writeFile(join(root, "node_modules/typed/index.js"), "export {}\n")
      await writeFile(join(root, "node_modules/typed/readme.md"), "# typed\n")
      await writeFile(join(root, "node_modules/typed/cli.js"), "#!/usr/bin/env node\n")
      await mkdir(join(root, "node_modules/@scope/pkg"), { recursive: true })
      await writeFile(
        join(root, "node_modules/@scope/pkg/package.json"),
        JSON.stringify({
          name: "@scope/pkg",
          exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        }),
      )
      await writeFile(join(root, "node_modules/@scope/pkg/index.d.ts"), "export {}\n")
      await writeFile(join(root, "node_modules/@scope/pkg/index.js"), "export {}\n")
      await mkdir(join(root, "vendor/extra"), { recursive: true })
      await writeFile(
        join(root, "vendor/extra/package.json"),
        JSON.stringify({
          name: "vendor-only-should-not-warn",
          main: "./gone.js",
        }),
      )
      await writeFile(join(root, "vendor/extra/gone.js"), "console.log('gone')\n")

      const result = await publish({
        ...publishBase,
        path: root,
        exclude: ["docs/guide.md", "tools/run.js", "vendor/extra/gone.js"],
        log,
        writeSummary: async (markdown) => {
          summaries.push(markdown)
        },
      })
      assert.equal(result.dryRun, true)
      const warnings = log.lines.filter((line) =>
        line.includes("exclude patterns or default excludes"),
      )
      assert.equal(warnings.length, 1)
      const warning = warnings[0] ?? ""
      assert.match(warning, /5 package targets point at files/)
      assert.match(warning, /Packing continues/)
      assert.match(warning, /example-stack \(\.\) module dropped docs\/guide\.md/)
      assert.match(warning, /example-stack \(\.\) bin dropped tools\/run\.js/)
      assert.match(
        warning,
        /typed \(node_modules\/typed\) exports\["\."\]\.types dropped node_modules\/typed\/index\.d\.ts/,
      )
      assert.match(
        warning,
        /typed \(node_modules\/typed\) exports\["\."\]\.default dropped node_modules\/typed\/readme\.md/,
      )
      assert.match(
        warning,
        /@scope\/pkg \(node_modules\/@scope\/pkg\) exports\["\."\]\.types dropped node_modules\/@scope\/pkg\/index\.d\.ts/,
      )
      assert.equal(warning.includes("missing.js"), false)
      assert.equal(warning.includes("vendor-only-should-not-warn"), false)
      assert.equal(warning.includes("index.js"), false)
      assert.equal(warning.includes("cli.js"), false)
      const summary = summaries[0] ?? ""
      assert.match(summary, /### Excluded package targets/)
      assert.match(summary, /docs\/guide\.md/)
      assert.match(summary, /node_modules\/typed\/index\.js/)
    } finally {
      await pkg.cleanup()
    }
  })

  it("keeps one grouped warning when many targets were excluded", async () => {
    const pkg = await makePackage()
    const log = recordingLogger()
    try {
      for (let index = 0; index < 25; index += 1) {
        const name = `pkg-${String(index).padStart(2, "0")}`
        const dir = join(pkg.root, "node_modules", name)
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({
            name,
            exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
          }),
        )
        await writeFile(join(dir, "index.d.ts"), "export {}\n")
        await writeFile(join(dir, "index.js"), "export {}\n")
      }
      await publish({ ...publishBase, path: pkg.root, log })
      const warnings = log.lines.filter((line) =>
        line.includes("exclude patterns or default excludes"),
      )
      assert.equal(warnings.length, 1)
      const warning = warnings[0] ?? ""
      assert.match(warning, /25 package targets point at files/)
      assert.match(warning, /pkg-00 \(node_modules\/pkg-00\)/)
      assert.match(warning, /pkg-19 \(node_modules\/pkg-19\)/)
      assert.match(warning, /And 5 more\./)
      assert.equal(warning.includes("pkg-20"), false)
      assert.equal(warning.includes("pkg-24"), false)
    } finally {
      await pkg.cleanup()
    }
  })
})

describe("archive outputs", () => {
  it("sets file-count and size-bytes from the archive built in the run", async () => {
    const pkg = await makePackage()
    const summaries: string[] = []
    try {
      const dry = await publish({
        ...publishBase,
        path: pkg.root,
        writeSummary: async (markdown) => {
          summaries.push(markdown)
        },
      })
      assert.ok(dry.fileCount > 0)
      assert.ok(dry.sizeBytes > 1)
      const drySummary = summaries[0] ?? ""
      assert.match(drySummary, new RegExp(`\\| file-count \\| ${dry.fileCount} \\|`))
      assert.match(drySummary, new RegExp(`\\| size-bytes \\| ${dry.sizeBytes} \\|`))

      const record: VersionRecord = {
        org: "example-org",
        project: "example-stack",
        version: "1.2.3",
        sha256: dry.sha256,
        manifestSha256: dry.manifestSha256,
        sizeBytes: 1,
        yanked: false,
      }
      const uploadClient = (): RegistryClient => ({
        setToken() {},
        async exchangeOidc() {
          throw new Error("exchange")
        },
        async getVersion() {
          return undefined
        },
        async startUpload() {
          return {
            uploadId: "upl_test",
            partSize: 8 * 1024 * 1024,
            maxBytes: 256 * 1024 * 1024,
          }
        },
        async uploadPart(input) {
          return { partNumber: input.partNumber, etag: "etag-1", sizeBytes: 1 }
        },
        async uploadManifest(input) {
          return {
            sha256: createHash("sha256").update(input.body).digest("hex"),
            sizeBytes: 1,
          }
        },
        async completeUpload() {
          return { ...record, sizeBytes: 1 }
        },
        async abortUpload() {},
      })

      summaries.length = 0
      const published = await publish({
        ...publishBase,
        path: pkg.root,
        dryRun: false,
        token: "anr_test",
        mask: () => {},
        client: uploadClient(),
        writeSummary: async (markdown) => {
          summaries.push(markdown)
        },
      })
      assert.equal(published.skipped, false)
      assert.equal(published.fileCount, dry.fileCount)
      assert.equal(published.sizeBytes, dry.sizeBytes)
      const publishedSummary = summaries[0] ?? ""
      assert.match(publishedSummary, /\| Result \| Published\./)
      assert.match(publishedSummary, new RegExp(`\\| file-count \\| ${dry.fileCount} \\|`))
      assert.match(publishedSummary, new RegExp(`\\| size-bytes \\| ${dry.sizeBytes} \\|`))

      summaries.length = 0
      const skipped = await publish({
        ...publishBase,
        path: pkg.root,
        dryRun: false,
        onImmutable: "skip-if-digest-matches",
        token: "anr_test",
        mask: () => {},
        client: {
          ...uploadClient(),
          async getVersion() {
            return record
          },
          async startUpload() {
            throw new Error("should not start")
          },
        },
        writeSummary: async (markdown) => {
          summaries.push(markdown)
        },
      })
      assert.equal(skipped.skipped, true)
      assert.equal(skipped.fileCount, dry.fileCount)
      assert.equal(skipped.sizeBytes, dry.sizeBytes)
      const skippedSummary = summaries[0] ?? ""
      assert.match(skippedSummary, /The publish was skipped/)
      assert.match(skippedSummary, new RegExp(`\\| file-count \\| ${dry.fileCount} \\|`))
      assert.match(skippedSummary, new RegExp(`\\| size-bytes \\| ${dry.sizeBytes} \\|`))
      assert.equal(skippedSummary.includes("| size-bytes | 1 |"), false)
    } finally {
      await pkg.cleanup()
    }
  })
})
