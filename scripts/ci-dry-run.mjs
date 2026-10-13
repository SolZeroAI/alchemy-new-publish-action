import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const work = join(tmpdir(), `alchemy-e2e-${process.pid}`)
rmSync(work, { recursive: true, force: true })

function stage(includeCli) {
  const root = join(work, includeCli ? "ready" : "missing-cli")
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  cpSync("fixtures/ready-package", root, { recursive: true })
  mkdirSync(join(root, "node_modules/alchemy/bin"), { recursive: true })
  mkdirSync(join(root, "node_modules/.cache"), { recursive: true })
  mkdirSync(join(root, ".git"), { recursive: true })
  mkdirSync(join(root, ".alchemy"), { recursive: true })
  mkdirSync(join(root, "__tests__"), { recursive: true })
  mkdirSync(join(root, ".github/workflows"), { recursive: true })
  writeFileSync(join(root, "node_modules/alchemy/package.json"), "{}\n")
  writeFileSync(join(root, "node_modules/alchemy/cert.pem"), "fixture-cert\n")
  if (includeCli) {
    writeFileSync(join(root, "node_modules/alchemy/bin/cli.js"), 'console.log("alchemy")\n')
  }
  writeFileSync(join(root, "node_modules/.cache/junk"), "cache\n")
  writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(root, ".alchemy/state.json"), "{}\n")
  writeFileSync(join(root, "__tests__/app.test.ts"), "test\n")
  writeFileSync(join(root, ".env"), "TOKEN=secret\n")
  writeFileSync(join(root, ".env.local"), "TOKEN=secret\n")
  writeFileSync(join(root, ".npmrc"), "registry=https://example.invalid\n")
  writeFileSync(join(root, "id_rsa"), "not-a-real-key\n")
  writeFileSync(join(root, "cert.pem"), "not-a-real-pem\n")
  writeFileSync(join(root, ".github/workflows/release.yml"), "name: release\n")
  return root
}

function runAction(inputs) {
  const summaryPath = join(work, "summary.md")
  const outputPath = join(work, "output.txt")
  writeFileSync(summaryPath, "")
  writeFileSync(outputPath, "")
  const env = {
    ...process.env,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
  }
  for (const [key, value] of Object.entries(inputs)) {
    env[`INPUT_${key.replace(/ /g, "_").toUpperCase()}`] = value
  }
  const result = spawnSync(process.execPath, ["dist/index.cjs"], {
    env,
    encoding: "utf8",
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    summary: readFileSync(summaryPath, "utf8"),
    output: readFileSync(outputPath, "utf8"),
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(message)
    process.exit(1)
  }
}

const ready = stage(true)
const dry = runAction({
  path: ready,
  "dry-run": "true",
  version: "1.2.3",
  package: "example-org/example-stack",
})
if (dry.status !== 0) {
  console.error(dry.stdout)
  console.error(dry.stderr)
  process.exit(dry.status ?? 1)
}
const packed = dry.summary.split("### Packed files")[1]?.split("### Excluded")[0] ?? ""
for (const required of [
  "alchemy.run.ts",
  "dist/app.js",
  ".env.example",
  "node_modules/alchemy/bin/cli.js",
  "node_modules/alchemy/cert.pem",
]) {
  assert(packed.includes(`\`${required}\``), `dry run did not pack ${required}`)
}
assert(!packed.includes("alchemy.new.jsonc"), "dry run packed the root manifest")
assert(dry.summary.includes("not in the archive"), "summary did not say the manifest is excluded")
assert(dry.summary.includes("Manifest sha256"), "summary did not include the manifest digest")
for (const forbidden of [
  ".env",
  ".git",
  ".npmrc",
  "id_rsa",
  "cert.pem",
  "__tests__/app.test.ts",
  ".alchemy/state.json",
  "node_modules/.cache/junk",
]) {
  assert(!packed.includes(`\`${forbidden}\``), `dry run packed ${forbidden}`)
}
assert(dry.output.includes("1.2.3"), "version output missing")
assert(/sha256<<[\s\S]*[0-9a-f]{64}/.test(dry.output), "sha256 output missing")
assert(/manifest-sha256<<[\s\S]*[0-9a-f]{64}/.test(dry.output), "manifest-sha256 output missing")
assert(dry.summary.includes("Dry run"), "summary did not say dry run")
assert(
  dry.stdout.includes("Dry run: archive was not uploaded."),
  "log did not say the archive was not uploaded",
)
console.log("dry-run fixture ok")

const missingCli = stage(false)
const missing = runAction({
  path: missingCli,
  "dry-run": "true",
  version: "1.2.3",
  package: "example-org/example-stack",
})
assert(missing.status !== 0, "missing cli.js should fail")
assert(
  `${missing.stdout}\n${missing.stderr}`.includes("node_modules/alchemy/bin/cli.js"),
  "missing cli.js error did not name the file",
)
console.log("missing cli.js rejected")

const badDir = stage(true)
const badArchive = join(work, "bad.tar.gz")
execFileSync("tar", ["-czf", badArchive, "-C", badDir, "."])
const bad = runAction({
  archive: badArchive,
  "dry-run": "true",
  version: "1.2.3",
  package: "example-org/example-stack",
})
assert(bad.status !== 0, "prebuilt archive containing .git should fail")
assert(`${bad.stdout}\n${bad.stderr}`.includes(".git"), "bad archive error did not mention .git")
console.log("prebuilt .git archive rejected")

const manifestArchive = join(work, "root-manifest.tar.gz")
execFileSync("tar", [
  "-czf",
  manifestArchive,
  "-C",
  ready,
  "alchemy.new.jsonc",
  "alchemy.run.ts",
  "dist",
  "README.md",
  ".env.example",
  "node_modules/alchemy/bin/cli.js",
  "node_modules/alchemy/package.json",
  "node_modules/alchemy/cert.pem",
])
const rooted = runAction({
  archive: manifestArchive,
  manifest: join(ready, "alchemy.new.jsonc"),
  "dry-run": "true",
  version: "1.2.3",
  package: "example-org/example-stack",
})
assert(rooted.status !== 0, "prebuilt archive with a root manifest should fail")
const rootedLog = `${rooted.stdout}\n${rooted.stderr}`
assert(rootedLog.includes("alchemy.new.jsonc"), "root manifest error did not name the file")
assert(
  rootedLog.includes("archive root") || rootedLog.includes("invalid_archive"),
  "root manifest error did not say the archive root copy is rejected",
)
console.log("prebuilt root manifest rejected")
