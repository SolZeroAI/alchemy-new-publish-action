import assert from "node:assert/strict"
import { mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { listArchive, packFiles, type ArchiveEntry } from "../src/archive.ts"
import { CLI_PATH } from "../src/constants.ts"
import type { Manifest } from "../src/manifest.ts"
import { filesForArchive, publish } from "../src/publish.ts"
import { selectFiles } from "../src/select.ts"
import { assertReadyArchive } from "../src/validate.ts"
import { manifestText } from "./helpers.ts"

const manifest: Manifest = {
  schemaVersion: 1,
  id: "example-stack",
  name: "Example Stack",
  description: "A fixture package.",
  publisherName: "Example",
  source: { org: "example-org", project: "example-stack" },
  entrypoint: "alchemy.run.ts",
}

const entry = (path: string, type: ArchiveEntry["type"], linkTarget?: string): ArchiveEntry => {
  const item: ArchiveEntry = {
    path,
    type,
    size: type === "file" ? 1 : 0,
  }

  if (linkTarget !== undefined) item.linkTarget = linkTarget

  return item
}

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "alchemy-link-"))

  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const writeReady = (root: string): void => {
  writeFileSync(join(root, "alchemy.new.jsonc"), manifestText())
  writeFileSync(join(root, "alchemy.run.ts"), "export {}\n")
}

const storeName = `alchemy@2.0.0-beta.81_${"a".repeat(80)}`

const installLinkedAlchemy = (root: string): void => {
  const store = join(root, "node_modules/.store", storeName, "node_modules/alchemy")
  mkdirSync(join(store, "bin"), { recursive: true })
  mkdirSync(join(store, "dist"), { recursive: true })
  mkdirSync(join(root, "node_modules/.store/leftpad"), { recursive: true })
  writeFileSync(join(store, "bin/cli.js"), 'console.log("alchemy")\n')
  writeFileSync(join(store, "dist/run.js"), "export {}\n")
  writeFileSync(join(store, "package.json"), "{}\n")
  writeFileSync(join(store, "cert.pem"), "fixture-cert\n")
  writeFileSync(join(store, ".env"), "TOKEN=secret\n")
  symlinkSync("../dist/run.js", join(store, "bin/run.js"))
  symlinkSync(`.store/${storeName}/node_modules/alchemy`, join(root, "node_modules/alchemy"))
  writeFileSync(join(root, "node_modules/.store/leftpad/index.js"), "exports.pad = true\n")
  symlinkSync(".store/leftpad", join(root, "node_modules/leftpad"))
  writeReady(root)
}

const publishOptions = (root: string) => {
  const include: string[] = []
  const exclude: string[] = []

  return {
    path: root,
    version: "1.2.3",
    include,
    exclude,
    defaultExcludes: true,
    registryUrl: "https://api.alchemy.new",
    dryRun: true,
    onImmutable: "fail" as const,
    fetchImpl: async () => {
      throw new Error("dry-run called the network")
    },
  }
}

describe("node_modules/alchemy directory symlink", () => {
  it("packs each file as a relative symlink into the in-package store", async () => {
    await withRoot(async (root) => {
      installLinkedAlchemy(root)
      const out = await mkdtemp(join(tmpdir(), "alchemy-link-out-"))

      try {
        const selection = await selectFiles(root, {
          includes: [],
          excludes: [],
          defaultExcludes: true,
        })

        assert.equal(selection.rejected.length, 0)
        assert.equal(selection.files.includes("node_modules/alchemy"), false)
        assert.equal(selection.files.includes("node_modules/leftpad"), true)
        assert.equal(selection.files.includes("node_modules/leftpad/index.js"), false)
        const cliLink = selection.links.get(CLI_PATH)
        assert.equal(cliLink, `../../.store/${storeName}/node_modules/alchemy/bin/cli.js`)
        assert.equal(
          selection.links.get("node_modules/alchemy/bin/run.js"),
          `../../.store/${storeName}/node_modules/alchemy/dist/run.js`,
        )
        assert.equal(selection.files.includes("node_modules/alchemy/.env"), false)
        const archive = join(out, "alchemy.new.tar.gz")
        const files = filesForArchive(selection.files, "alchemy.new.jsonc")
        const links = new Map<string, string>()

        for (const file of files) {
          const target = selection.links.get(file)

          if (target !== undefined) links.set(file, target)
        }

        await packFiles(root, files, archive, { links })
        const entries = await listArchive(archive)
        const cli = entries.find((item) => item.path === CLI_PATH)
        assert.equal(cli?.type, "symlink")
        assert.equal(cli?.linkTarget, cliLink)

        const stored = entries.find(
          (item) =>
            item.path === `node_modules/.store/${storeName}/node_modules/alchemy/bin/cli.js`,
        )

        assert.equal(stored?.type, "file")
        const run = entries.find((item) => item.path === "node_modules/alchemy/bin/run.js")
        assert.equal(run?.type, "symlink")
        assert.equal(run?.linkTarget, `../../.store/${storeName}/node_modules/alchemy/dist/run.js`)
        const cert = entries.find((item) => item.path === "node_modules/alchemy/cert.pem")
        assert.equal(cert?.type, "symlink")
        assert.equal(
          entries.some((item) => item.path === "node_modules/alchemy"),
          false,
        )
        assert.equal(
          entries.some((item) => item.path === "node_modules/alchemy/.env"),
          false,
        )
        assert.equal(
          entries.some((item) => item.path.endsWith("/alchemy/.env")),
          false,
        )
        const leftpad = entries.find((item) => item.path === "node_modules/leftpad")
        assert.equal(leftpad?.type, "symlink")
        assert.equal(leftpad?.linkTarget, ".store/leftpad")
        assert.equal(
          entries.some((item) => item.path === "node_modules/leftpad/index.js"),
          false,
        )
        assertReadyArchive(entries, manifest)
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    })
  })

  it("expands an absolute alchemy directory symlink that stays inside the package", async () => {
    await withRoot(async (root) => {
      const store = join(root, "node_modules/.store/alchemy/node_modules/alchemy")
      mkdirSync(join(store, "bin"), { recursive: true })
      mkdirSync(join(store, "dist"), { recursive: true })
      writeFileSync(join(store, "bin/cli.js"), 'console.log("alchemy")\n')
      writeFileSync(join(store, "dist/run.js"), "export {}\n")
      const tool = join(store, "bin/tool.js")
      const toolTarget = join(store, "dist/run.js")
      symlinkSync(toolTarget, tool)
      const packageLink = join(root, "node_modules/alchemy")
      symlinkSync(store, packageLink)
      writeReady(root)
      const out = await mkdtemp(join(tmpdir(), "alchemy-link-abs-"))

      try {
        const selection = await selectFiles(root, {
          includes: [],
          excludes: [],
          defaultExcludes: true,
        })

        assert.equal(selection.rejected.length, 0)
        assert.equal(
          selection.links.get(CLI_PATH),
          "../../.store/alchemy/node_modules/alchemy/bin/cli.js",
        )
        assert.equal(
          selection.links.get("node_modules/alchemy/bin/tool.js"),
          "../../.store/alchemy/node_modules/alchemy/dist/run.js",
        )
        const archive = join(out, "alchemy.new.tar.gz")
        const files = filesForArchive(selection.files, "alchemy.new.jsonc")
        const links = new Map<string, string>()

        for (const file of files) {
          const target = selection.links.get(file)

          if (target !== undefined) links.set(file, target)
        }

        await packFiles(root, files, archive, { links })
        const entries = await listArchive(archive)
        const cli = entries.find((item) => item.path === CLI_PATH)
        assert.equal(cli?.type, "symlink")
        assert.equal(cli?.linkTarget, "../../.store/alchemy/node_modules/alchemy/bin/cli.js")
        const packedTool = entries.find((item) => item.path === "node_modules/alchemy/bin/tool.js")
        assert.equal(packedTool?.type, "symlink")
        assert.equal(
          packedTool?.linkTarget,
          "../../.store/alchemy/node_modules/alchemy/dist/run.js",
        )

        const storedTool = entries.find(
          (item) => item.path === "node_modules/.store/alchemy/node_modules/alchemy/bin/tool.js",
        )

        assert.equal(storedTool?.type, "symlink")
        assert.equal(storedTool?.linkTarget, "../dist/run.js")
        assert.equal(
          entries.some((item) => item.linkTarget?.startsWith("/")),
          false,
        )
        assert.equal(readlinkSync(packageLink), store)
        assert.equal(readlinkSync(tool), toolTarget)
        assertReadyArchive(entries, manifest)
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    })
  })

  it("dry-runs a package whose alchemy install is a directory symlink", async () => {
    await withRoot(async (root) => {
      installLinkedAlchemy(root)
      const summaries: string[] = []

      const result = await publish({
        ...publishOptions(root),
        writeSummary: async (markdown) => {
          summaries.push(markdown)
        },
      })

      assert.equal(result.dryRun, true)
      assert.match(result.sha256, /^[0-9a-f]{64}$/)
      assert.match(summaries[0] ?? "", /node_modules\/alchemy\/bin\/cli\.js/)
    })
  })

  it("rejects an alchemy directory symlink that leaves the package root", async () => {
    await withRoot(async (root) => {
      mkdirSync(join(root, "node_modules"), { recursive: true })
      writeReady(root)
      symlinkSync("../../outside-alchemy", join(root, "node_modules/alchemy"))
      await assert.rejects(() => publish(publishOptions(root)), /points outside the package root/)
      await rm(join(root, "node_modules/alchemy"))
      symlinkSync("/etc/alchemy", join(root, "node_modules/alchemy"))
      await assert.rejects(() => publish(publishOptions(root)), /points outside the package root/)
    })
  })

  it("rejects an alchemy directory symlink that points at a forbidden path", async () => {
    await withRoot(async (root) => {
      mkdirSync(join(root, ".git"), { recursive: true })
      mkdirSync(join(root, "node_modules"), { recursive: true })
      writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n")
      writeReady(root)
      symlinkSync("../.git", join(root, "node_modules/alchemy"))
      await assert.rejects(() => publish(publishOptions(root)), /forbidden path/)
    })
  })

  it("rejects an alchemy directory symlink that points at itself", async () => {
    await withRoot(async (root) => {
      mkdirSync(join(root, "node_modules"), { recursive: true })
      writeReady(root)
      symlinkSync("alchemy", join(root, "node_modules/alchemy"))
      await assert.rejects(() => publish(publishOptions(root)), /points at itself/)
    })
  })

  it("rejects a file inside the linked package whose target escapes or is forbidden", async () => {
    await withRoot(async (root) => {
      const store = join(root, "node_modules/.store/alchemy/node_modules/alchemy/bin")
      mkdirSync(store, { recursive: true })
      writeFileSync(join(store, "cli.js"), 'console.log("alchemy")\n')
      symlinkSync("/etc/passwd", join(store, "escape.js"))
      symlinkSync(".store/alchemy/node_modules/alchemy", join(root, "node_modules/alchemy"))
      writeReady(root)
      await assert.rejects(
        () => publish(publishOptions(root)),
        /node_modules\/alchemy\/bin\/escape\.js: symlink node_modules\/alchemy\/bin\/escape\.js points outside the package root/,
      )
    })
    await withRoot(async (root) => {
      const store = join(root, "node_modules/.store/alchemy/node_modules/alchemy/bin")
      mkdirSync(store, { recursive: true })
      writeFileSync(join(store, "cli.js"), 'console.log("alchemy")\n')
      writeFileSync(join(root, ".env"), "TOKEN=secret\n")
      symlinkSync("../../../../../../.env", join(store, "hook.js"))
      symlinkSync(".store/alchemy/node_modules/alchemy", join(root, "node_modules/alchemy"))
      writeReady(root)
      await assert.rejects(() => publish(publishOptions(root)), /forbidden path/)
    })
  })

  it("does not expand a file symlink at node_modules/alchemy", async () => {
    await withRoot(async (root) => {
      mkdirSync(join(root, "node_modules"), { recursive: true })
      writeFileSync(join(root, "node_modules/cli.js"), 'console.log("alchemy")\n')
      symlinkSync("cli.js", join(root, "node_modules/alchemy"))
      writeReady(root)
      await assert.rejects(
        () => publish(publishOptions(root)),
        /Missing node_modules\/alchemy\/bin\/cli\.js/,
      )
    })
  })

  it("reports an excluded cli.js as dropped when the directory symlink still exposes it", async () => {
    await withRoot(async (root) => {
      installLinkedAlchemy(root)
      await assert.rejects(
        () =>
          publish({
            ...publishOptions(root),
            exclude: ["node_modules/alchemy/bin/cli.js"],
          }),
        /include\/exclude rules dropped it/,
      )
    })
  })

  it("fails a linked package when default excludes are off and a secret is inside it", async () => {
    await withRoot(async (root) => {
      installLinkedAlchemy(root)
      await assert.rejects(
        () =>
          publish({
            ...publishOptions(root),
            defaultExcludes: false,
            exclude: [".git"],
          }),
        /secret env file/,
      )
    })
  })
})

describe("assertReadyArchive cli member", () => {
  const entrypoint = entry("alchemy.run.ts", "file")

  it("accepts a file and a relative symlink member", () => {
    assertReadyArchive([entrypoint, entry(CLI_PATH, "file")], manifest)
    assertReadyArchive(
      [
        entrypoint,
        entry(CLI_PATH, "symlink", "../../.store/alchemy/node_modules/alchemy/bin/cli.js"),
      ],
      manifest,
    )
  })

  it("rejects a directory symlink that does not name the cli file", () => {
    assert.throws(
      () =>
        assertReadyArchive(
          [
            entrypoint,
            entry("node_modules/alchemy", "symlink", ".store/alchemy/node_modules/alchemy"),
            entry("node_modules/.store/alchemy/node_modules/alchemy/bin/cli.js", "file"),
          ],
          manifest,
        ),
      /missing node_modules\/alchemy\/bin\/cli\.js/,
    )
  })

  it("rejects a cli symlink that escapes or points at a forbidden path", () => {
    assert.throws(
      () => assertReadyArchive([entrypoint, entry(CLI_PATH, "symlink", "/etc/passwd")], manifest),
      /points outside the package root/,
    )
    assert.throws(
      () => assertReadyArchive([entrypoint, entry(CLI_PATH, "symlink", "../../../.env")], manifest),
      /forbidden path/,
    )
  })
})
