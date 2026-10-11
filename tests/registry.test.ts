import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { authorize } from '../src/auth.ts'
import { OIDC_AUDIENCE } from '../src/constants.ts'
import { createRegistryClient } from '../src/registry.ts'
import { uploadArchive } from '../src/upload.ts'
import { silentLogger } from '../src/log.ts'
import { json, withServer } from './helpers.ts'

describe('registry client', () => {
  it('exchanges an OIDC token without sending it as Authorization', async () => {
    const seen: { authorization?: string; body?: unknown } = {}
    const server = await withServer((req, res, body) => {
      seen.authorization = req.headers.authorization
      seen.body = JSON.parse(body.toString('utf8')) as unknown
      json(res, 200, {
        token: 'anu_grant',
        expiresAt: '2026-01-01T00:15:00.000Z',
        org: 'example-org',
        project: 'example-stack',
      })
    })
    const masked: string[] = []
    try {
      const client = createRegistryClient({
        registryUrl: server.url,
        log: silentLogger,
        sleep: async () => {},
      })
      const token = await authorize({
        org: 'example-org',
        project: 'example-stack',
        client,
        getIdToken: async (audience) => {
          assert.equal(audience, OIDC_AUDIENCE)
          return 'eyJhbGci.eyJzdWIi.signature'
        },
        mask: (secret) => {
          masked.push(secret)
        },
        log: silentLogger,
      })
      assert.equal(token, 'anu_grant')
      assert.equal(seen.authorization, undefined)
      assert.deepEqual(seen.body, {
        token: 'eyJhbGci.eyJzdWIi.signature',
        org: 'example-org',
        project: 'example-stack',
      })
      assert.ok(masked.includes('eyJhbGci.eyJzdWIi.signature'))
      assert.ok(masked.includes('anu_grant'))
    } finally {
      await server.close()
    }
  })

  it('retries a part upload and completes with the sha256 and etags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alchemy-bytes-'))
    const file = join(dir, 'archive.tar.gz')
    const bytes = Buffer.from('gzip-bytes-not-validated-here')
    await writeFile(file, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let puts = 0
    let completed: { sha256?: string; parts?: Array<{ partNumber: number; etag: string }> } = {}
    const server = await withServer((req, res, body) => {
      const url = req.url ?? ''
      if (req.method === 'GET') {
        json(res, 404, { message: 'missing', code: 'not_found' })
        return
      }
      if (req.method === 'POST' && url.endsWith('/uploads')) {
        json(res, 200, {
          uploadId: 'upload-1',
          partSize: 8388608,
          maxBytes: 268435456,
          expiresAt: '2026-01-01T01:00:00.000Z',
          contentType: 'application/gzip',
        })
        return
      }
      if (req.method === 'PUT' && url.includes('/parts/')) {
        puts += 1
        if (puts === 1) {
          json(res, 503, { message: 'unavailable', code: 'unavailable' })
          return
        }
        assert.equal(req.headers.authorization, 'Bearer anr_test')
        assert.equal(req.headers['content-type'], 'application/octet-stream')
        assert.equal(body.toString('utf8'), bytes.toString('utf8'))
        json(res, 200, { partNumber: 1, etag: '"etag-1"', sizeBytes: body.length })
        return
      }
      if (req.method === 'POST' && url.endsWith('/complete')) {
        completed = JSON.parse(body.toString('utf8')) as typeof completed
        json(res, 200, {
          org: 'example-org',
          project: 'example-stack',
          version: '1.2.3',
          sha256,
          sizeBytes: bytes.length,
          contentType: 'application/gzip',
          yanked: false,
          publishedAt: '2026-01-01T00:00:00.000Z',
        })
        return
      }
      json(res, 500, { message: `unexpected ${req.method} ${url}`, code: 'unexpected' })
    })
    const logs: string[] = []
    try {
      const client = createRegistryClient({
        registryUrl: server.url,
        log: {
          info(message) {
            logs.push(message)
          },
          warn(message) {
            logs.push(message)
          },
        },
        sleep: async () => {},
      })
      const result = await uploadArchive({
        client,
        org: 'example-org',
        project: 'example-stack',
        version: '1.2.3',
        archivePath: file,
        sha256,
        sizeBytes: bytes.length,
        onImmutable: 'fail',
        log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
        authorize: async () => 'anr_test',
      })
      assert.equal(result.skipped, false)
      assert.equal(result.record.sha256, sha256)
      assert.equal(puts, 2)
      assert.equal(completed.sha256, sha256)
      assert.deepEqual(completed.parts, [{ partNumber: 1, etag: '"etag-1"' }])
      assert.ok(logs.some((line) => line.startsWith('Retrying upload part')))
    } finally {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('aborts when complete is rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alchemy-bytes-'))
    const file = join(dir, 'archive.tar.gz')
    const bytes = Buffer.from('abcdef')
    await writeFile(file, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let aborted = false
    const server = await withServer((req, res) => {
      const url = req.url ?? ''
      if (req.method === 'GET') {
        json(res, 404, { message: 'missing', code: 'not_found' })
        return
      }
      if (req.method === 'POST' && url.endsWith('/uploads')) {
        json(res, 200, {
          uploadId: 'upload-2',
          partSize: 8388608,
          maxBytes: 268435456,
          contentType: 'application/gzip',
        })
        return
      }
      if (req.method === 'PUT') {
        json(res, 200, { partNumber: 1, etag: '"etag"', sizeBytes: bytes.length })
        return
      }
      if (url.endsWith('/complete')) {
        json(res, 400, { message: 'hash', code: 'digest_mismatch' })
        return
      }
      if (url.endsWith('/abort')) {
        aborted = true
        json(res, 200, { ok: true })
        return
      }
      json(res, 500, { message: 'unexpected', code: 'unexpected' })
    })
    try {
      const client = createRegistryClient({
        registryUrl: server.url,
        log: silentLogger,
        sleep: async () => {},
      })
      await assert.rejects(
        () =>
          uploadArchive({
            client,
            org: 'example-org',
            project: 'example-stack',
            version: '1.2.3',
            archivePath: file,
            sha256,
            sizeBytes: bytes.length,
            onImmutable: 'fail',
            log: silentLogger,
            authorize: async () => 'anr_test',
          }),
        /digest_mismatch|sha256/,
      )
      assert.equal(aborted, true)
    } finally {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
