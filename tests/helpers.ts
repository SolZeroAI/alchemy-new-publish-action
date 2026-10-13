import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"

export function manifestText(options?: {
  org?: string
  project?: string
  version?: string
  entrypoint?: string
  extra?: string
}): string {
  const version = options?.version
    ? `,
    "version": "${options.version}"`
    : ""
  return `{
  // ready for alchemy.new
  "$schema": "https://alchemy.new/schema/v1/project.json",
  "schemaVersion": 1,
  "id": "example-stack",
  "name": "Example Stack",
  "description": "A fixture package.",
  "publisher": { "name": "Example" },
  "source": {
    "kind": "registry",
    "org": "${options?.org ?? "example-org"}",
    "project": "${options?.project ?? "example-stack"}"${version}
  },
  "deployment": {
    "entrypoint": "${options?.entrypoint ?? "alchemy.run.ts"}",
    "providers": ["cloudflare"],
    "defaultProvider": "cloudflare",
    "defaultStage": "prod",
  },
  "parameters": [],
  ${options?.extra ?? ""}
}
`
}

export async function makePackage(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "alchemy-pkg-"))
  await mkdir(join(root, "node_modules/alchemy/bin"), { recursive: true })
  await mkdir(join(root, "dist"), { recursive: true })
  await mkdir(join(root, ".git"), { recursive: true })
  await mkdir(join(root, ".alchemy"), { recursive: true })
  await mkdir(join(root, "__tests__"), { recursive: true })
  await mkdir(join(root, "node_modules/.cache"), { recursive: true })
  await mkdir(join(root, ".github/workflows"), { recursive: true })
  await writeFile(join(root, "alchemy.new.jsonc"), manifestText())
  await writeFile(join(root, "alchemy.run.ts"), "export {}\n")
  await writeFile(join(root, "dist/app.js"), 'console.log("built")\n')
  await writeFile(join(root, "README.md"), "# fixture\n")
  await writeFile(join(root, "node_modules/alchemy/bin/cli.js"), 'console.log("alchemy")\n')
  await writeFile(join(root, "node_modules/alchemy/package.json"), "{}\n")
  await writeFile(join(root, "node_modules/alchemy/cert.pem"), "fixture-cert\n")
  await writeFile(join(root, ".env.example"), "TOKEN=\n")
  await writeFile(join(root, ".env.sample"), "TOKEN=\n")
  await writeFile(join(root, ".env"), "TOKEN=secret\n")
  await writeFile(join(root, ".env.local"), "TOKEN=secret\n")
  await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n")
  await writeFile(join(root, ".alchemy/state.json"), "{}\n")
  await writeFile(join(root, "__tests__/app.test.ts"), "test\n")
  await writeFile(join(root, "node_modules/.cache/junk"), "cache\n")
  await writeFile(join(root, ".npmrc"), "registry=https://example.invalid\n")
  await writeFile(join(root, "id_rsa"), "not-a-real-key\n")
  await writeFile(join(root, "cert.pem"), "not-a-real-pem\n")
  await writeFile(join(root, ".github/workflows/release.yml"), "name: release\n")
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

export async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on("end", () => {
      void Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch((error: unknown) => {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      })
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server has no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(payload)
}
