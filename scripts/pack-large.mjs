/**
 * Regression for the pack hang on a large symlink-heavy tree.
 *
 * Builds a synthetic package well over 256 MiB uncompressed, with tens of
 * thousands of files, symlinks, and hardlinks, plus enough incompressible
 * bytes that the gzip lands around 150–200 MiB. Packs it, checks the sha256,
 * then packs the same list with a small cap and expects that to fail.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listArchive, packFiles, sha256File } from '../src/archive.ts'

const COMPRESSIBLE_FILES = 20_000
const COMPRESSIBLE_BYTES = 16 * 1024
const COMPRESSIBLE_DIRS = 200
const RANDOM_FILES = 155
const RANDOM_BYTES = 1024 * 1024
const SYMLINKS = 10_000
const HARDLINKS = 1_000
const PACK_TIMEOUT_MS = 240_000
const CAP_TIMEOUT_MS = 30_000
const CAP_BYTES = 8 * 1024 * 1024
const MIN_GZIP_BYTES = 150 * 1024 * 1024
const MAX_GZIP_BYTES = 200 * 1024 * 1024
const MIN_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const MAX_RSS_BYTES = 400 * 1024 * 1024

const root = await mkdtemp(join(tmpdir(), 'alchemy-pack-large-'))
const archive = join(root, 'archive.tar.gz')
const capped = join(root, 'capped.tar.gz')

let peakRss = process.memoryUsage().rss
let sampling = true
const sampleRss = setInterval(() => {
  if (sampling) peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 200)
sampleRss.unref()

try {
  const { files, uncompressed } = buildTree(root)
  if (uncompressed <= MIN_UNCOMPRESSED_BYTES) {
    throw new Error(
      `synthetic tree is ${uncompressed} bytes, expected more than ${MIN_UNCOMPRESSED_BYTES}`,
    )
  }
  console.log(
    `tree files=${files.length} uncompressedMiB=${mib(uncompressed)} symlinks=${SYMLINKS} hardlinks=${HARDLINKS}`,
  )

  const packed = await withTimeout(PACK_TIMEOUT_MS, 'pack', () => packFiles(root, files, archive))
  const info = await stat(archive)
  sampling = false
  const packRss = peakRss
  console.log(
    `packed bytes=${info.size} miB=${mib(info.size)} seconds=${(packed / 1000).toFixed(1)} packRssMiB=${mib(packRss)}`,
  )
  if (packRss > MAX_RSS_BYTES) {
    throw new Error(`pack peak RSS ${packRss} exceeds ${MAX_RSS_BYTES}`)
  }
  if (info.size < MIN_GZIP_BYTES || info.size > MAX_GZIP_BYTES) {
    throw new Error(
      `gzip is ${info.size} bytes, expected ${MIN_GZIP_BYTES} to ${MAX_GZIP_BYTES}`,
    )
  }

  const [fromAction, fromStream, fromCli] = await Promise.all([
    sha256File(archive),
    hashStream(archive),
    Promise.resolve(execFileSync('sha256sum', [archive], { encoding: 'utf8' }).slice(0, 64)),
  ])
  if (fromAction !== fromStream || fromAction !== fromCli) {
    throw new Error(`sha256 mismatch action=${fromAction} stream=${fromStream} cli=${fromCli}`)
  }
  console.log(`sha256 ${fromAction}`)

  const entries = await listArchive(archive)
  const link = entries.find((entry) => entry.path === 'links/s0')
  if (!link || link.type !== 'symlink' || link.linkTarget !== '../tree/0/f0.txt') {
    throw new Error(`symlink was not preserved: ${JSON.stringify(link)}`)
  }
  if (!entries.some((entry) => entry.path === 'hard/b/0000.txt')) {
    throw new Error('hardlink target missing from the archive')
  }
  const escaped = entries.find(
    (entry) => entry.type === 'symlink' && entry.linkTarget && entry.linkTarget.startsWith('/'),
  )
  if (escaped) throw new Error(`absolute symlink was packed: ${escaped.path}`)

  const capStarted = Date.now()
  let capError = null
  try {
    await withTimeout(CAP_TIMEOUT_MS, 'over-cap pack', () =>
      packFiles(root, files, capped, { maxBytes: CAP_BYTES }),
    )
  } catch (error) {
    capError = error
  }
  if (!(capError instanceof Error) || !/size cap/.test(capError.message)) {
    throw new Error(`over-cap pack should fail the size cap, got ${String(capError)}`)
  }
  console.log(`over-cap rejected in ${((Date.now() - capStarted) / 1000).toFixed(1)}s`)
  console.log('pack-large ok')
} finally {
  clearInterval(sampleRss)
  await rm(root, { recursive: true, force: true })
}

function buildTree(directory) {
  const files = []
  let uncompressed = 0
  for (let dir = 0; dir < COMPRESSIBLE_DIRS; dir += 1) {
    mkdirSync(join(directory, 'tree', String(dir)), { recursive: true })
  }
  const block = Buffer.alloc(COMPRESSIBLE_BYTES, 0x61)
  for (let i = 0; i < COMPRESSIBLE_FILES; i += 1) {
    const rel = `tree/${i % COMPRESSIBLE_DIRS}/f${i}.txt`
    writeFileSync(join(directory, rel), block)
    files.push(rel)
    uncompressed += COMPRESSIBLE_BYTES
  }

  mkdirSync(join(directory, 'rand'))
  const random = openSync('/dev/urandom', 'r')
  const chunk = Buffer.alloc(RANDOM_BYTES)
  try {
    for (let i = 0; i < RANDOM_FILES; i += 1) {
      const read = readSync(random, chunk, 0, chunk.length, null)
      if (read !== chunk.length) throw new Error(`short read from /dev/urandom (${read})`)
      const rel = `rand/b${String(i).padStart(3, '0')}.bin`
      writeFileSync(join(directory, rel), chunk)
      files.push(rel)
      uncompressed += RANDOM_BYTES
    }
  } finally {
    closeSync(random)
  }

  mkdirSync(join(directory, 'links'))
  for (let i = 0; i < SYMLINKS; i += 1) {
    const rel = `links/s${i}`
    const target = `../tree/${i % COMPRESSIBLE_DIRS}/f${i % COMPRESSIBLE_FILES}.txt`
    symlinkSync(target, join(directory, rel))
    files.push(rel)
  }

  mkdirSync(join(directory, 'hard', 'a'), { recursive: true })
  mkdirSync(join(directory, 'hard', 'b'))
  for (let i = 0; i < HARDLINKS; i += 1) {
    const name = String(i).padStart(4, '0')
    const src = `hard/a/${name}.txt`
    const body = `hardlink-${name}\n`
    writeFileSync(join(directory, src), body)
    linkSync(join(directory, src), join(directory, 'hard', 'b', `${name}.txt`))
    files.push(src, `hard/b/${name}.txt`)
    uncompressed += body.length * 2
  }
  return { files, uncompressed }
}

async function withTimeout(ms, label, fn) {
  const started = Date.now()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
  })
  try {
    await Promise.race([fn(), timeout])
    return Date.now() - started
  } finally {
    clearTimeout(timer)
  }
}

function hashStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function mib(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1)
}
