import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hardRejectReason, isDefaultExcluded } from '../src/rules.ts'
import { classifyPath } from '../src/select.ts'
import ignore from 'ignore'

describe('archive rules', () => {
  const cases: Array<[string, boolean]> = [
    ['.git/HEAD', true],
    ['.alchemy/state.json', true],
    ['.env', true],
    ['.env.local', true],
    ['.envrc', true],
    ['production.env', true],
    ['.env.example', false],
    ['.env.sample', false],
    ['.npmrc', true],
    ['.netrc', true],
    ['id_rsa', true],
    ['node_modules/leftpad/id_rsa', true],
    ['id_rsa.pub', false],
    ['cert.pem', true],
    ['node_modules/alchemy/cert.pem', false],
    ['keys/server.key', true],
    ['node_modules/pkg/fixture.key', true],
    ['__tests__/app.test.ts', true],
    ['src/app.test.ts', true],
    ['src/app.spec.ts', true],
    ['src/app.ts', false],
    ['test/fixture.json', true],
    ['node_modules/.cache/junk', true],
    ['.github/workflows/release.yml', true],
    ['node_modules/alchemy/bin/cli.js', false],
    ['alchemy.new.jsonc', false],
    ['README.md', false],
    ['alchemy.new.tar.gz', true],
  ]

  for (const [path, excluded] of cases) {
    it(`${excluded ? 'excludes' : 'keeps'} ${path}`, () => {
      assert.equal(isDefaultExcluded(path), excluded)
    })
  }

  it('rejects secrets that an include list tried to pack', () => {
    const includes = ignore().add(['.env', 'src'])
    const decision = classifyPath('.env', { includes: ['.env'], excludes: [], defaultExcludes: true }, includes, {
      ignores: () => false,
    })
    assert.equal(decision.kind, 'reject')
  })

  it('drops .git from a normal tree instead of failing', () => {
    const decision = classifyPath('.git', { includes: [], excludes: [], defaultExcludes: true }, undefined, {
      ignores: () => false,
    })
    assert.equal(decision.kind, 'exclude')
    assert.match(hardRejectReason('.git/HEAD') ?? '', /\.git/)
  })

  it('fails closed when default excludes are off', () => {
    const decision = classifyPath('.env', { includes: [], excludes: [], defaultExcludes: false }, undefined, {
      ignores: () => false,
    })
    assert.equal(decision.kind, 'reject')
  })
})
