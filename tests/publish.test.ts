import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { ActionError } from '../src/errors.ts'
import type { Logger } from '../src/log.ts'
import { publish } from '../src/publish.ts'
import type { RegistryClient, VersionRecord } from '../src/registry.ts'
import { sha256File } from '../src/archive.ts'
import { makePackage, manifestText } from './helpers.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

describe('publish', () => {
  it('dry-runs a directory, reports the archive, and does not call the registry', async () => {
    const pkg = await makePackage()
    const summaries: string[] = []
    try {
      const result = await publish({
        path: pkg.root,
        version: '1.2.3',
        include: [],
        exclude: [],
        defaultExcludes: true,
        registryUrl: 'https://alchemy.new/',
        dryRun: true,
        onImmutable: 'fail',
        gitRef: 'refs/heads/master',
        log: recordingLogger(),
        writeSummary: async (markdown) => {
          summaries.push(markdown)
        },
        fetchImpl: async () => {
          throw new Error('dry-run called the network')
        },
        getIdToken: async () => {
          throw new Error('dry-run requested OIDC')
        },
      })
      assert.equal(result.dryRun, true)
      assert.equal(result.version, '1.2.3')
      assert.equal(result.org, 'example-org')
      assert.equal(result.project, 'example-stack')
      assert.match(result.sha256, /^[0-9a-f]{64}$/)
      assert.ok(result.sizeBytes > 0)
      assert.equal(
        result.url,
        'https://alchemy.new/?package=example-org/example-stack&version=1.2.3',
      )
      const summary = summaries[0] ?? ''
      assert.match(summary, /Dry run/)
      assert.match(summary, /alchemy\.new\.jsonc/)
      assert.match(summary, /node_modules\/alchemy\/bin\/cli\.js/)
      assert.match(summary, /node_modules\/alchemy\/cert\.pem/)
      assert.match(summary, /### Excluded/)
      assert.match(summary, /`\.env`/)
      assert.match(summary, /`\.git`/)
      assert.doesNotMatch(summary.split('### Excluded')[0] ?? '', /`\.env`/)
    } finally {
      await pkg.cleanup()
    }
  })

  it('uses the git tag when version is omitted', async () => {
    const pkg = await makePackage()
    try {
      const result = await publish({
        path: pkg.root,
        include: [],
        exclude: [],
        defaultExcludes: true,
        registryUrl: 'https://alchemy.new',
        dryRun: true,
        onImmutable: 'fail',
        gitRef: 'refs/tags/v2.0.0',
      })
      assert.equal(result.version, '2.0.0')
    } finally {
      await pkg.cleanup()
    }
  })

  it('rejects an anr_ token that is some other credential, without echoing it', async () => {
    const pkg = await makePackage()
    const secret = 'ghp_this-must-not-appear'
    try {
      await assert.rejects(
        () =>
          publish({
            path: pkg.root,
            version: '1.2.3',
            include: [],
            exclude: [],
            defaultExcludes: true,
            registryUrl: 'https://alchemy.new',
            dryRun: false,
            onImmutable: 'fail',
            token: secret,
            mask: () => {},
          }),
        (error: unknown) => {
          assert.ok(error instanceof ActionError)
          assert.match(error.message, /anr_/)
          assert.equal(error.message.includes(secret), false)
          return true
        },
      )
    } finally {
      await pkg.cleanup()
    }
  })

  it('skips a publish when the stored digest matches', async () => {
    const pkg = await makePackage()
    try {
      const dry = await publish({
        path: pkg.root,
        version: '1.2.3',
        include: [],
        exclude: [],
        defaultExcludes: true,
        registryUrl: 'https://alchemy.new',
        dryRun: true,
        onImmutable: 'fail',
      })
      let started = false
      const record: VersionRecord = {
        org: 'example-org',
        project: 'example-stack',
        version: '1.2.3',
        sha256: dry.sha256,
        sizeBytes: dry.sizeBytes,
        yanked: false,
      }
      const client: RegistryClient = {
        setToken() {},
        async exchangeOidc() {
          throw new Error('exchange')
        },
        async getVersion() {
          return record
        },
        async startUpload() {
          started = true
          throw new Error('start')
        },
        async uploadPart() {
          throw new Error('part')
        },
        async completeUpload() {
          throw new Error('complete')
        },
        async abortUpload() {},
      }
      const result = await publish({
        path: pkg.root,
        version: '1.2.3',
        include: [],
        exclude: [],
        defaultExcludes: true,
        registryUrl: 'https://alchemy.new',
        dryRun: false,
        onImmutable: 'skip-if-digest-matches',
        client,
        token: 'anr_test',
        mask: () => {},
      })
      assert.equal(result.skipped, true)
      assert.equal(result.sha256, dry.sha256)
      assert.equal(started, false)
    } finally {
      await pkg.cleanup()
    }
  })

  it('names a digest mismatch instead of uploading', async () => {
    const pkg = await makePackage()
    try {
      const client: RegistryClient = {
        setToken() {},
        async exchangeOidc() {
          throw new Error('exchange')
        },
        async getVersion() {
          return {
            org: 'example-org',
            project: 'example-stack',
            version: '1.2.3',
            sha256: 'a'.repeat(64),
            sizeBytes: 1,
            yanked: false,
          }
        },
        async startUpload() {
          throw new Error('should not start')
        },
        async uploadPart() {
          throw new Error('part')
        },
        async completeUpload() {
          throw new Error('complete')
        },
        async abortUpload() {},
      }
      await assert.rejects(
        () =>
          publish({
            path: pkg.root,
            version: '1.2.3',
            include: [],
            exclude: [],
            defaultExcludes: true,
            registryUrl: 'https://alchemy.new',
            dryRun: false,
            onImmutable: 'skip-if-digest-matches',
            client,
            token: 'anr_test',
            mask: () => {},
          }),
        /does not match this archive/,
      )
    } finally {
      await pkg.cleanup()
    }
  })

  it('fails when the manifest source.version disagrees with the tag', async () => {
    const pkg = await makePackage()
    try {
      await writeFile(join(pkg.root, 'alchemy.new.jsonc'), manifestText({ version: '9.9.9' }))
      await assert.rejects(
        () =>
          publish({
            path: pkg.root,
            include: [],
            exclude: [],
            defaultExcludes: true,
            registryUrl: 'https://alchemy.new',
            dryRun: true,
            onImmutable: 'fail',
            gitRef: 'refs/tags/v1.2.3',
          }),
        /does not match/,
      )
    } finally {
      await pkg.cleanup()
    }
  })
})

describe('sha256File', () => {
  it('hashes the bytes on disk', async () => {
    const pkg = await makePackage()
    try {
      const path = join(pkg.root, 'dist/app.js')
      const expected = createHash('sha256').update(await readFile(path)).digest('hex')
      assert.equal(await sha256File(path), expected)
    } finally {
      await pkg.cleanup()
    }
  })
})
