import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { ActionError } from "../src/errors.ts"
import type { Logger } from "../src/log.ts"
import { publish } from "../src/publish.ts"
import type { JsonObject } from "../src/record.ts"
import { findMissingRuntimeImports, formatMissingImports } from "../src/runtime-imports.ts"
import { makePackage } from "./helpers.ts"

async function tree(files: Record<string, string>, links: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "rti-"))

  for (const [path, body] of Object.entries(files)) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body)
  }

  for (const [path, target] of Object.entries(links)) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await symlink(target, file)
  }

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function pkg(name: string, extra: JsonObject = {}) {
  return JSON.stringify({ name, type: "module", ...extra })
}

const store = {
  "node_modules/.store/cf/node_modules/@alchemy.run/cloudflare/package.json":
    pkg("@alchemy.run/cloudflare"),
  "node_modules/.store/cf/node_modules/@alchemy.run/cloudflare/index.js": "",
}

// SolStatus shape: infra -> workspace @x/api/infra -> @alchemy.run/cloudflare (pruned).
function solstatus(apiDeps: JsonObject, apiLinks: Record<string, string> = {}) {
  return tree(
    {
      "package.json": pkg("root", { workspaces: ["packages/*"] }),
      "packages/infra/package.json": pkg("@x/infra"),
      "packages/infra/src/alchemy.run.ts": `import { api } from "@x/api/infra"\nexport default api\n`,
      "packages/api/package.json": pkg("@x/api", {
        exports: { "./infra": "./infra/index.ts" },
        imports: { "#internal": "./src/internal.ts" },
        ...apiDeps,
      }),
      "packages/api/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
      }),
      "packages/api/src/helper.ts": "export const helper = 1\n",
      "packages/api/src/internal.ts": "export const internal = 1\n",
      "packages/api/infra/index.ts": `
        import * as Cloudflare from "@alchemy.run/cloudflare"
        import type { T } from "@types-only/pkg"
        import { OnlyType } from "@elided/pkg"
        import { readFileSync } from "node:fs"
        import { join } from "node:path"
        import { helper } from "@app/helper"
        import { internal } from "#internal"
        import { button } from "@/components/Button"
        let x: OnlyType
        void readFileSync
        void join
        void helper
        void internal
        void button
        export const api = Cloudflare.Worker("w", { main: "../src/worker.ts" })
      `,
      "packages/api/src/worker.ts": `import { env } from "cloudflare:workers"\nimport "@worker/dep"\nexport default { env }\n`,
      ...store,
    },
    { "packages/infra/node_modules/@x/api": "../../../api", ...apiLinks },
  )
}

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

const cloudflareLink = {
  "packages/api/node_modules/@alchemy.run/cloudflare":
    "../../../../node_modules/.store/cf/node_modules/@alchemy.run/cloudflare",
}

describe("runtime import check", () => {
  it("fails when a workspace infra module imports a pruned devDependency", async () => {
    const fixture = await solstatus({ devDependencies: { "@alchemy.run/cloudflare": "2.0.0" } })

    try {
      const { missing } = await findMissingRuntimeImports(
        fixture.root,
        "packages/infra/src/alchemy.run.ts",
      )

      const cloudflare = missing.find((item) => item.packageName === "@alchemy.run/cloudflare")
      assert.equal(cloudflare?.importer, "packages/api/infra/index.ts")
      assert.equal(cloudflare?.listedAs, "devDependencies")
      assert.equal(cloudflare?.ownerManifest, "packages/api/package.json")
      assert.match(
        formatMissingImports(missing),
        /Move each package to "dependencies" in the package.json/,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("passes when the package is in dependencies and linked where Node looks", async () => {
    const fixture = await solstatus(
      { dependencies: { "@alchemy.run/cloudflare": "2.0.0" } },
      cloudflareLink,
    )

    try {
      const { missing } = await findMissingRuntimeImports(
        fixture.root,
        "packages/infra/src/alchemy.run.ts",
      )

      assert.deepEqual(
        missing.map((item) => item.packageName),
        ["@worker/dep"],
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("ignores import type, type-only bindings, builtins, schemes, and aliases", async () => {
    const fixture = await solstatus(
      { dependencies: { "@alchemy.run/cloudflare": "2.0.0" } },
      cloudflareLink,
    )

    try {
      const names = (
        await findMissingRuntimeImports(fixture.root, "packages/infra/src/alchemy.run.ts")
      ).missing.map((item) => item.packageName)

      assert.equal(names.includes("@types-only/pkg"), false)
      assert.equal(names.includes("@elided/pkg"), false)
      assert.equal(names.includes("cloudflare:workers"), false)
      assert.equal(names.includes("node:fs"), false)
      assert.equal(names.includes("node:path"), false)
      assert.equal(names.includes("@app/helper"), false)
      assert.equal(names.includes("#internal"), false)
      assert.equal(names.includes("@/components/Button"), false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("names a root override when that is the only listing", async () => {
    const fixture = await tree(
      {
        "package.json": pkg("root", { overrides: { "@alchemy.run/cloudflare": "2.0.0" } }),
        "packages/api/package.json": pkg("@x/api", { exports: { ".": "./infra/index.ts" } }),
        "packages/api/infra/index.ts": `import * as Cloudflare from "@alchemy.run/cloudflare"\nexport const api = Cloudflare\n`,
        "alchemy.run.ts": `import { api } from "@x/api"\nexport default api\n`,
      },
      { "node_modules/@x/api": "../../packages/api" },
    )

    try {
      const { missing } = await findMissingRuntimeImports(fixture.root, "alchemy.run.ts")
      const cloudflare = missing.find((item) => item.packageName === "@alchemy.run/cloudflare")
      assert.equal(cloudflare?.importer, "packages/api/infra/index.ts")
      assert.equal(cloudflare?.ownerManifest, "packages/api/package.json")
      assert.equal(cloudflare?.listedManifest, "package.json")
      assert.equal(cloudflare?.listedAs, "overrides")
      assert.match(formatMissingImports(missing), /listed in overrides of package\.json/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("treats dynamic imports in vite.config as required and elsewhere as warnings", async () => {
    const fixture = await tree({
      "package.json": pkg("app"),
      "alchemy.run.ts": `import { site } from "./infra/site"\nexport default site\n`,
      "infra/site.ts": `export const site = { root: "." }\nvoid import("@optional/pkg")\n`,
      "vite.config.ts": `export default async () => ({ plugins: [(await import("@vitejs/plugin-react")).default()] })\n`,
      "src/main.tsx": `import { App } from "./App"\nexport const main = <App />\n`,
      "src/App.tsx": "export function App() { return null }\n",
      "src/App.test.tsx": `import "@testing-library/react"\n`,
      "src/Button.stories.tsx": `import "@storybook/react"\n`,
      "src/Widget.spec.tsx": `import "@spec/helper"\n`,
    })

    try {
      const { missing, warnings } = await findMissingRuntimeImports(fixture.root, "alchemy.run.ts")
      const reactPlugin = missing.find((item) => item.packageName === "@vitejs/plugin-react")
      assert.equal(reactPlugin?.importer, "vite.config.ts")
      assert.equal(
        missing.some((item) => item.packageName === "@testing-library/react"),
        false,
      )
      assert.equal(
        missing.some((item) => item.packageName === "@storybook/react"),
        false,
      )
      assert.equal(
        missing.some((item) => item.packageName === "@spec/helper"),
        false,
      )
      assert.equal(
        missing.some((item) => item.packageName === "@optional/pkg"),
        false,
      )
      assert.equal(
        warnings.some((warning) => warning.includes("@optional/pkg")),
        true,
      )
      assert.equal(
        missing.some((item) => item.packageName === "react"),
        false,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("runs on the extracted archive, so an exclude that drops a dependency fails", async () => {
    const packed = await makePackage()
    const cloudflareDir = join(packed.root, "node_modules/@alchemy.run/cloudflare")

    try {
      await writeFile(
        join(packed.root, "package.json"),
        pkg("example", { dependencies: { "@alchemy.run/cloudflare": "2.0.0" } }),
      )
      await writeFile(
        join(packed.root, "alchemy.run.ts"),
        `import "@alchemy.run/cloudflare"\nexport {}\n`,
      )
      await mkdir(cloudflareDir, { recursive: true })
      await writeFile(join(cloudflareDir, "package.json"), pkg("@alchemy.run/cloudflare"))
      await writeFile(join(cloudflareDir, "index.js"), "export {}\n")

      const present = await publish({
        path: packed.root,
        version: "1.2.3",
        include: [],
        exclude: [],
        defaultExcludes: true,
        registryUrl: "https://alchemy.new",
        dryRun: true,
        onImmutable: "fail",
      })

      assert.equal(present.dryRun, true)

      const log = recordingLogger()
      await assert.rejects(
        () =>
          publish({
            path: packed.root,
            version: "1.2.3",
            include: [],
            exclude: ["node_modules/**/cloudflare/**"],
            defaultExcludes: true,
            registryUrl: "https://alchemy.new",
            dryRun: true,
            onImmutable: "fail",
            log,
          }),
        (cause: unknown) => {
          assert.ok(cause instanceof ActionError)
          assert.match(cause.message, /alchemy\.run\.ts/)
          assert.match(cause.message, /@alchemy\.run\/cloudflare/)
          assert.match(cause.message, /listed in dependencies of package\.json/)
          assert.match(cause.message, /publish a new version/)

          return true
        },
      )

      await publish({
        path: packed.root,
        version: "1.2.3",
        include: [],
        exclude: ["node_modules/**/cloudflare/**"],
        defaultExcludes: true,
        registryUrl: "https://alchemy.new",
        dryRun: true,
        onImmutable: "fail",
        runtimeImportCheck: "warn",
        log,
      })
      assert.equal(
        log.lines.some((line) => line.includes("@alchemy.run/cloudflare")),
        true,
      )

      await publish({
        path: packed.root,
        version: "1.2.3",
        include: [],
        exclude: ["node_modules/**/cloudflare/**"],
        defaultExcludes: true,
        registryUrl: "https://alchemy.new",
        dryRun: true,
        onImmutable: "fail",
        runtimeImportCheck: "off",
      })
    } finally {
      await packed.cleanup()
    }
  })
})
