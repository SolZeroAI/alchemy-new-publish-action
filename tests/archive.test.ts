import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { create } from 'tar'
import { listArchive, packFiles } from '../src/archive.ts'
import { publish } from '../src/publish.ts'
import { selectFiles } from '../src/select.ts'
import { makePackage } from './helpers.ts'

const packedNames = async (archivePath: string): Promise<string[]> => {
  const entries = await listArchive(archivePath)
  return entries.filter((entry) => entry.type === 'file' || entry.type === 'symlink').map((entry) => entry.path).sort()
}

describe('packing', () => {
  it('packs the ready tree and drops git, secrets, tests, and caches', async () => {
    const pkg = await makePackage()
    const out = await mkdtemp(join(tmpdir(), 'alchemy-out-'))
    try {
      const selection = await selectFiles(pkg.root, {
        includes: [],
        excludes: [],
        defaultExcludes: true,
      })
      const archive = join(out, 'alchemy.new.tar.gz')
      await packFiles(pkg.root, selection.files, archive)
      const names = await packedNames(archive)
      for (const required of [
        'alchemy.new.jsonc',
        'alchemy.run.ts',
        'dist/app.js',
        'README.md',
        '.env.example',
        '.env.sample',
        'node_modules/alchemy/bin/cli.js',
        'node_modules/alchemy/cert.pem',
      ]) {
        assert.ok(names.includes(required), `missing ${required}`)
      }
      for (const forbidden of [
        '.git/HEAD',
        '.env',
        '.env.local',
        '.npmrc',
        'id_rsa',
        'cert.pem',
        '__tests__/app.test.ts',
        'node_modules/.cache/junk',
        '.alchemy/state.json',
        '.github/workflows/release.yml',
      ]) {
        assert.equal(names.includes(forbidden), false, `packed ${forbidden}`)
      }
    } finally {
      await pkg.cleanup()
      await rm(out, { recursive: true, force: true })
    }
  })

  it('honors an extra exclude and an include list without bypassing default excludes', async () => {
    const pkg = await makePackage()
    try {
      const selection = await selectFiles(pkg.root, {
        includes: ['dist', 'README.md', '__tests__'],
        excludes: ['*.md'],
        defaultExcludes: true,
      })
      assert.deepEqual(selection.files, ['dist/app.js'])
      assert.equal(selection.rejected.length, 0)
    } finally {
      await pkg.cleanup()
    }
  })

  it('fails a dry run when a prebuilt archive contains .git', async () => {
    const pkg = await makePackage()
    const out = await mkdtemp(join(tmpdir(), 'alchemy-bad-'))
    const archive = join(out, 'bad.tar.gz')
    try {
      await create({ gzip: true, cwd: pkg.root, file: archive, portable: true }, ['.'])
      await assert.rejects(
        () =>
          publish({
            archive,
            version: '1.2.3',
            include: [],
            exclude: [],
            defaultExcludes: true,
            registryUrl: 'https://alchemy.new',
            dryRun: true,
            onImmutable: 'fail',
            fetchImpl: async () => {
              throw new Error('dry-run called the network')
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
