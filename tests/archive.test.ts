import assert from "node:assert/strict"
import { randomFillSync } from "node:crypto"
import { linkSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { create } from "tar"
import { listArchive, packFiles } from "../src/archive.ts"
import { filesForArchive, publish } from "../src/publish.ts"
import { selectFiles } from "../src/select.ts"
import { makePackage } from "./helpers.ts"

const packedNames = async (archivePath: string): Promise<string[]> => {
  const entries = await listArchive(archivePath)

  return entries
    .filter((entry) => entry.type === "file" || entry.type === "symlink")
    .map((entry) => entry.path)
    .sort()
}

describe("packing", () => {
  it("packs the ready tree and drops git, secrets, tests, and caches", async () => {
    const pkg = await makePackage()
    const out = await mkdtemp(join(tmpdir(), "alchemy-out-"))

    try {
      const selection = await selectFiles(pkg.root, {
        includes: [],
        excludes: [],
        defaultExcludes: true,
      })

      const archive = join(out, "alchemy.new.tar.gz")
      await packFiles(pkg.root, filesForArchive(selection.files, "alchemy.new.jsonc"), archive)
      const names = await packedNames(archive)

      for (const required of [
        "alchemy.run.ts",
        "dist/app.js",
        "README.md",
        ".env.example",
        ".env.sample",
        "node_modules/alchemy/bin/cli.js",
        "node_modules/alchemy/cert.pem",
      ]) {
        assert.ok(names.includes(required), `missing ${required}`)
      }

      assert.equal(names.includes("alchemy.new.jsonc"), false, "packed the root manifest")

      for (const forbidden of [
        ".git/HEAD",
        ".env",
        ".env.local",
        ".npmrc",
        "id_rsa",
        "cert.pem",
        "__tests__/app.test.ts",
        "node_modules/.cache/junk",
        ".alchemy/state.json",
        ".github/workflows/release.yml",
      ]) {
        assert.equal(names.includes(forbidden), false, `packed ${forbidden}`)
      }
    } finally {
      await pkg.cleanup()
      await rm(out, { recursive: true, force: true })
    }
  })

  it("honors an extra exclude and an include list without bypassing default excludes", async () => {
    const pkg = await makePackage()

    try {
      const selection = await selectFiles(pkg.root, {
        includes: ["dist", "README.md", "__tests__"],
        excludes: ["*.md"],
        defaultExcludes: true,
      })

      assert.deepEqual(selection.files, ["dist/app.js"])
      assert.equal(selection.rejected.length, 0)
    } finally {
      await pkg.cleanup()
    }
  })

  it("stores symlinks as symlinks and keeps hardlink targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-links-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-links-out-"))

    try {
      mkdirSync(join(root, "store", "pkg"), { recursive: true })
      mkdirSync(join(root, "node_modules"))
      mkdirSync(join(root, "dup"))
      writeFileSync(join(root, "store", "pkg", "index.js"), "export {}\n")
      symlinkSync("../store/pkg", join(root, "node_modules", "pkg"))
      writeFileSync(join(root, "dup", "a.txt"), "same-bytes")
      linkSync(join(root, "dup", "a.txt"), join(root, "dup", "b.txt"))
      const archive = join(out, "links.tar.gz")
      await packFiles(
        root,
        ["store/pkg/index.js", "node_modules/pkg", "dup/a.txt", "dup/b.txt"],
        archive,
      )
      const entries = await listArchive(archive)
      const link = entries.find((entry) => entry.path === "node_modules/pkg")
      assert.equal(link?.type, "symlink")
      assert.equal(link?.linkTarget, "../store/pkg")
      const names = entries.map((entry) => entry.path)
      assert.equal(names.includes("node_modules/pkg/index.js"), false)
      assert.equal(names.includes("store/pkg/index.js"), true)
      assert.equal(names.includes("dup/a.txt"), true)
      assert.equal(names.includes("dup/b.txt"), true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("packs hundreds of hardlinks without stalling", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-hard-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-hard-out-"))

    try {
      mkdirSync(join(root, "a"))
      mkdirSync(join(root, "b"))
      mkdirSync(join(root, "links"))
      const files: string[] = []

      for (let i = 0; i < 300; i += 1) {
        const name = String(i).padStart(4, "0")
        writeFileSync(join(root, "a", `${name}.bin`), Buffer.alloc(4096, i % 251))
        linkSync(join(root, "a", `${name}.bin`), join(root, "b", `${name}.bin`))
        symlinkSync(`../a/${name}.bin`, join(root, "links", name))
        files.push(`a/${name}.bin`, `b/${name}.bin`, `links/${name}`)
      }

      let timer: NodeJS.Timeout | undefined

      const result = await Promise.race([
        packFiles(root, files, join(out, "hard.tar.gz")).then(
          () => "completed",
          (cause: unknown) => cause,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 20_000)
        }),
      ])

      if (timer) clearTimeout(timer)
      assert.equal(result, "completed")
      const entries = await listArchive(join(out, "hard.tar.gz"))
      const link = entries.find((entry) => entry.path === "links/0000")
      assert.equal(link?.type, "symlink")
      assert.equal(link?.linkTarget, "../a/0000.bin")
      assert.equal(
        entries.some((entry) => entry.path === "b/0000.bin"),
        true,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("rewrites an absolute symlink that stays inside the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-abs-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-abs-out-"))

    try {
      const pkgDir = join(root, "store", "pkg")
      const binDir = join(root, "node_modules", ".bin")
      mkdirSync(pkgDir, { recursive: true })
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(pkgDir, "cli.js"), "#!/usr/bin/env node\n")
      const packageLink = join(root, "node_modules", "pkg")
      const packageTarget = join(root, "store", "pkg")
      symlinkSync(packageTarget, packageLink)
      const binLink = join(binDir, "cli")
      const binTarget = join(pkgDir, "cli.js")
      symlinkSync(binTarget, binLink)
      const normalizedTarget = join(root, "store", "pkg", "..", "pkg", "cli.js")
      const normalizedLink = join(binDir, "normalized")
      symlinkSync(normalizedTarget, normalizedLink)
      const deepName = "p".repeat(90)
      const deepDir = join(root, "store", deepName)
      mkdirSync(deepDir, { recursive: true })
      writeFileSync(join(deepDir, "cli.js"), "#!/usr/bin/env node\n")
      const deepLink = join(binDir, "deep")
      const deepTarget = join(deepDir, "cli.js")
      symlinkSync(deepTarget, deepLink)
      const archive = join(out, "abs.tar.gz")
      await packFiles(
        root,
        [
          "store/pkg/cli.js",
          `store/${deepName}/cli.js`,
          "node_modules/pkg",
          "node_modules/.bin/cli",
          "node_modules/.bin/normalized",
          "node_modules/.bin/deep",
        ],
        archive,
      )
      const entries = await listArchive(archive)
      const packedPackage = entries.find((entry) => entry.path === "node_modules/pkg")
      assert.equal(packedPackage?.type, "symlink")
      assert.equal(packedPackage?.linkTarget, "../store/pkg")
      const packedBin = entries.find((entry) => entry.path === "node_modules/.bin/cli")
      assert.equal(packedBin?.type, "symlink")
      assert.equal(packedBin?.linkTarget, "../../store/pkg/cli.js")

      const packedNormalized = entries.find(
        (entry) => entry.path === "node_modules/.bin/normalized",
      )

      assert.equal(packedNormalized?.type, "symlink")
      assert.equal(packedNormalized?.linkTarget, "../../store/pkg/cli.js")
      const packedDeep = entries.find((entry) => entry.path === "node_modules/.bin/deep")
      const deepLinkTarget = `../../store/${deepName}/cli.js`
      assert.equal(packedDeep?.type, "symlink")
      assert.equal(packedDeep?.linkTarget, deepLinkTarget)
      assert.ok(deepLinkTarget.length > 100)
      assert.equal(
        entries.some((entry) => entry.linkTarget?.startsWith("/")),
        false,
      )
      assert.equal(readlinkSync(packageLink), packageTarget)
      assert.equal(readlinkSync(binLink), binTarget)
      assert.equal(readlinkSync(normalizedLink), normalizedTarget)
      assert.equal(readlinkSync(deepLink), deepTarget)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("rejects an absolute symlink that leaves the package root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "alchemy-abs-out-"))
    const root = join(parent, "pkg")
    const sibling = join(parent, "pkg-secret")
    const out = await mkdtemp(join(tmpdir(), "alchemy-abs-reject-"))

    try {
      mkdirSync(root)
      mkdirSync(join(sibling, "nested"), { recursive: true })
      writeFileSync(join(root, "keep.txt"), "keep")
      writeFileSync(join(sibling, "nested", "secret.txt"), "nope")
      const siblingLink = join(root, "sibling")
      const siblingTarget = join(sibling, "nested", "secret.txt")
      symlinkSync(siblingTarget, siblingLink)
      const dotdotLink = join(root, "dotdot")
      const dotdotTarget = join(root, "..", "pkg-secret", "nested", "secret.txt")
      symlinkSync(dotdotTarget, dotdotLink)
      const driveLink = join(root, "drive")
      symlinkSync("C:/Windows/System32", driveLink)
      await assert.rejects(
        () => packFiles(root, ["keep.txt", "sibling"], join(out, "sibling.tar.gz")),
        /points outside the package root/,
      )
      await assert.rejects(
        () => packFiles(root, ["dotdot"], join(out, "dotdot.tar.gz")),
        /points outside the package root/,
      )
      await assert.rejects(
        () => packFiles(root, ["drive"], join(out, "drive.tar.gz")),
        /points outside the package root/,
      )
      assert.equal(readlinkSync(siblingLink), siblingTarget)
      assert.equal(readlinkSync(dotdotLink), dotdotTarget)
      assert.equal(readlinkSync(driveLink), "C:/Windows/System32")
    } finally {
      await rm(parent, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("rejects an absolute symlink that points at a forbidden path", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-abs-forbid-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-abs-forbid-out-"))

    try {
      writeFileSync(join(root, ".env"), "SECRET=1\n")
      mkdirSync(join(root, ".git"))
      writeFileSync(join(root, ".git", "config"), "[core]\n")
      const envLink = join(root, "leak-env")
      const envTarget = join(root, ".env")
      symlinkSync(envTarget, envLink)
      const gitLink = join(root, "leak-git")
      const gitTarget = join(root, ".git", "config")
      symlinkSync(gitTarget, gitLink)
      await assert.rejects(
        () => packFiles(root, ["leak-env"], join(out, "env.tar.gz")),
        /points at a forbidden path \(\.env\)/,
      )
      await assert.rejects(
        () => packFiles(root, ["leak-git"], join(out, "git.tar.gz")),
        /points at a forbidden path \(\.git\/config\)/,
      )
      assert.equal(readlinkSync(envLink), envTarget)
      assert.equal(readlinkSync(gitLink), gitTarget)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("rejects a symlink that points outside the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-escape-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-escape-out-"))

    try {
      writeFileSync(join(root, "keep.txt"), "keep")
      symlinkSync("../outside", join(root, "escape"))
      symlinkSync("/etc/passwd", join(root, "absolute"))
      await assert.rejects(
        () => packFiles(root, ["keep.txt", "escape"], join(out, "a.tar.gz")),
        /points outside the package root/,
      )
      await assert.rejects(
        () => packFiles(root, ["absolute"], join(out, "b.tar.gz")),
        /points outside the package root/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("stops when the compressed archive exceeds the size cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-cap-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-cap-out-"))

    try {
      const blob = Buffer.alloc(512 * 1024)
      randomFillSync(blob)
      writeFileSync(join(root, "blob.bin"), blob)
      let timer: NodeJS.Timeout | undefined

      const result = await Promise.race([
        packFiles(root, ["blob.bin"], join(out, "big.tar.gz"), { maxBytes: 64 * 1024 }).then(
          () => "completed",
          (cause: unknown) => cause,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 10_000)
        }),
      ])

      if (timer) clearTimeout(timer)
      assert.ok(result instanceof Error, `expected a cap error, got ${String(result)}`)
      assert.match(result.message, /size cap/)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("keeps a nested manifest and still omits the root copy", async () => {
    const pkg = await makePackage()
    const out = await mkdtemp(join(tmpdir(), "alchemy-nested-"))

    try {
      mkdirSync(join(pkg.root, "vendor/example"), { recursive: true })
      writeFileSync(join(pkg.root, "vendor/example/alchemy.new.jsonc"), "{}\n")

      const selection = await selectFiles(pkg.root, {
        includes: [],
        excludes: [],
        defaultExcludes: true,
      })

      const archive = join(out, "nested.tar.gz")
      await packFiles(pkg.root, filesForArchive(selection.files, "alchemy.new.jsonc"), archive)
      const names = await packedNames(archive)
      assert.equal(names.includes("alchemy.new.jsonc"), false)
      assert.ok(names.includes("vendor/example/alchemy.new.jsonc"))
    } finally {
      await pkg.cleanup()
      await rm(out, { recursive: true, force: true })
    }
  })

  it("fails a dry run when a prebuilt archive contains a root manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-root-manifest-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-root-out-"))
    const archive = join(out, "with-manifest.tar.gz")

    try {
      mkdirSync(join(root, "node_modules/alchemy/bin"), { recursive: true })
      writeFileSync(join(root, "alchemy.new.jsonc"), "{}\n")
      writeFileSync(join(root, "alchemy.run.ts"), "export {}\n")
      writeFileSync(join(root, "node_modules/alchemy/bin/cli.js"), 'console.log("alchemy")\n')
      await create({ gzip: true, cwd: root, file: archive, portable: true }, [
        "alchemy.new.jsonc",
        "alchemy.run.ts",
        "node_modules",
      ])
      await assert.rejects(
        () =>
          publish({
            archive,
            version: "1.2.3",
            include: [],
            exclude: [],
            defaultExcludes: true,
            registryUrl: "https://alchemy.new",
            dryRun: true,
            onImmutable: "fail",
            fetchImpl: async () => {
              throw new Error("dry-run called the network")
            },
          }),
        /archive root/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("fails a dry run when a prebuilt archive contains an absolute symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "alchemy-prebuilt-link-"))
    const out = await mkdtemp(join(tmpdir(), "alchemy-prebuilt-link-out-"))
    const archive = join(out, "absolute.tar.gz")

    try {
      writeFileSync(join(root, "keep.txt"), "keep")
      symlinkSync("/etc/passwd", join(root, "absolute"))
      await create({ gzip: true, cwd: root, file: archive, portable: true }, [
        "keep.txt",
        "absolute",
      ])
      await assert.rejects(
        () =>
          publish({
            archive,
            version: "1.2.3",
            include: [],
            exclude: [],
            defaultExcludes: true,
            registryUrl: "https://alchemy.new",
            dryRun: true,
            onImmutable: "fail",
            fetchImpl: async () => {
              throw new Error("dry-run called the network")
            },
          }),
        /points outside the archive/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it("fails a dry run when a prebuilt archive contains .git", async () => {
    const pkg = await makePackage()
    const out = await mkdtemp(join(tmpdir(), "alchemy-bad-"))
    const archive = join(out, "bad.tar.gz")

    try {
      await create({ gzip: true, cwd: pkg.root, file: archive, portable: true }, ["."])
      await assert.rejects(
        () =>
          publish({
            archive,
            version: "1.2.3",
            include: [],
            exclude: [],
            defaultExcludes: true,
            registryUrl: "https://alchemy.new",
            dryRun: true,
            onImmutable: "fail",
            fetchImpl: async () => {
              throw new Error("dry-run called the network")
            },
          }),
        /\.git/,
      )
    } finally {
      await pkg.cleanup()
      await rm(out, { recursive: true, force: true })
    }
  })
})
