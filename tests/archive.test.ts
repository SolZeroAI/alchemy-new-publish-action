import assert from 'node:assert/strict'
import { randomFillSync } from 'node:crypto'
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { create } from 'tar'
import { listArchive, packFiles } from '../src/archive.ts'
import { filesForArchive, publish } from '../src/publish.ts'
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
      await packFiles(pkg.root, filesForArchive(selection.files, 'alchemy.new.jsonc'), archive)
      const names = await packedNames(archive)
      for (const required of [
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
      assert.equal(names.includes('alchemy.new.jsonc'), false, 'packed the root manifest')
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

  it('stores symlinks as symlinks and keeps hardlink targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alchemy-links-'))
    const out = await mkdtemp(join(tmpdir(), 'alchemy-links-out-'))
    try {
      mkdirSync(join(root, 'store', 'pkg'), { recursive: true })
      mkdirSync(join(root, 'node_modules'))
      mkdirSync(join(root, 'dup'))
      writeFileSync(join(root, 'store', 'pkg', 'index.js'), 'export {}\n')
      symlinkSync('../store/pkg', join(root, 'node_modules', 'pkg'))
      writeFileSync(join(root, 'dup', 'a.txt'), 'same-bytes')
      linkSync(join(root, 'dup', 'a.txt'), join(root, 'dup', 'b.txt'))
      const archive = join(out, 'links.tar.gz')
      await packFiles(
        root,
        ['store/pkg/index.js', 'node_modules/pkg', 'dup/a.txt', 'dup/b.txt'],
        archive,
      )
      const entries = await listArchive(archive)
      const link = entries.find((entry) => entry.path === 'node_modules/pkg')
      assert.equal(link?.type, 'symlink')
      assert.equal(link?.linkTarget, '../store/pkg')
      const names = entries.map((entry) => entry.path)
      assert.equal(names.includes('node_modules/pkg/index.js'), false)
      assert.equal(names.includes('store/pkg/index.js'), true)
      assert.equal(names.includes('dup/a.txt'), true)
      assert.equal(names.includes('dup/b.txt'), true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it('packs hundreds of hardlinks without stalling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alchemy-hard-'))
    const out = await mkdtemp(join(tmpdir(), 'alchemy-hard-out-'))
    try {
      mkdirSync(join(root, 'a'))
      mkdirSync(join(root, 'b'))
      mkdirSync(join(root, 'links'))
      const files: string[] = []
      for (let i = 0; i < 300; i += 1) {
        const name = String(i).padStart(4, '0')
        writeFileSync(join(root, 'a', `${name}.bin`), Buffer.alloc(4096, i % 251))
        linkSync(join(root, 'a', `${name}.bin`), join(root, 'b', `${name}.bin`))
        symlinkSync(`../a/${name}.bin`, join(root, 'links', name))
        files.push(`a/${name}.bin`, `b/${name}.bin`, `links/${name}`)
      }
      let timer: NodeJS.Timeout | undefined
      const result = await Promise.race([
        packFiles(root, files, join(out, 'hard.tar.gz')).then(
          () => 'completed',
          (error: unknown) => error,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 20_000)
        }),
      ])
      if (timer) clearTimeout(timer)
      assert.equal(result, 'completed')
      const entries = await listArchive(join(out, 'hard.tar.gz'))
      const link = entries.find((entry) => entry.path === 'links/0000')
      assert.equal(link?.type, 'symlink')
      assert.equal(link?.linkTarget, '../a/0000.bin')
      assert.equal(
        entries.some((entry) => entry.path === 'b/0000.bin'),
        true,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it('rejects a symlink that points outside the package root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alchemy-escape-'))
    const out = await mkdtemp(join(tmpdir(), 'alchemy-escape-out-'))
    try {
      writeFileSync(join(root, 'keep.txt'), 'keep')
      symlinkSync('../outside', join(root, 'escape'))
      symlinkSync('/etc/passwd', join(root, 'absolute'))
      await assert.rejects(
        () => packFiles(root, ['keep.txt', 'escape'], join(out, 'a.tar.gz')),
        /points outside the package root/,
      )
      await assert.rejects(
        () => packFiles(root, ['absolute'], join(out, 'b.tar.gz')),
        /points outside the package root/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it('stops when the compressed archive exceeds the size cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alchemy-cap-'))
    const out = await mkdtemp(join(tmpdir(), 'alchemy-cap-out-'))
    try {
      const blob = Buffer.alloc(512 * 1024)
      randomFillSync(blob)
      writeFileSync(join(root, 'blob.bin'), blob)
      let timer: NodeJS.Timeout | undefined
      const result = await Promise.race([
        packFiles(root, ['blob.bin'], join(out, 'big.tar.gz'), { maxBytes: 64 * 1024 }).then(
          () => 'completed',
          (error: unknown) => error,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 10_000)
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

  it('keeps a nested manifest and still omits the root copy', async () => {
    const pkg = await makePackage()
    const out = await mkdtemp(join(tmpdir(), 'alchemy-nested-'))
    try {
      mkdirSync(join(pkg.root, 'vendor/example'), { recursive: true })
      writeFileSync(join(pkg.root, 'vendor/example/alchemy.new.jsonc'), '{}\n')
      const selection = await selectFiles(pkg.root, {
        includes: [],
        excludes: [],
        defaultExcludes: true,
      })
      const archive = join(out, 'nested.tar.gz')
      await packFiles(
        pkg.root,
        filesForArchive(selection.files, 'alchemy.new.jsonc'),
        archive,
      )
      const names = await packedNames(archive)
      assert.equal(names.includes('alchemy.new.jsonc'), false)
      assert.ok(names.includes('vendor/example/alchemy.new.jsonc'))
    } finally {
      await pkg.cleanup()
      await rm(out, { recursive: true, force: true })
    }
  })

  it('fails a dry run when a prebuilt archive contains a root manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alchemy-root-manifest-'))
    const out = await mkdtemp(join(tmpdir(), 'alchemy-root-out-'))
    const archive = join(out, 'with-manifest.tar.gz')
    try {
      mkdirSync(join(root, 'node_modules/alchemy/bin'), { recursive: true })
      writeFileSync(join(root, 'alchemy.new.jsonc'), '{}\n')
      writeFileSync(join(root, 'alchemy.run.ts'), 'export {}\n')
      writeFileSync(join(root, 'node_modules/alchemy/bin/cli.js'), 'console.log("alchemy")\n')
      await create(
        { gzip: true, cwd: root, file: archive, portable: true },
        ['alchemy.new.jsonc', 'alchemy.run.ts', 'node_modules'],
      )
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
        /archive root/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
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
