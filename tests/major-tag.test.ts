import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { floatingTagForRelease } from '../src/major-tag.ts'

describe('floatingTagForRelease', () => {
  it('moves v1 for a stable 1.x Tegami tag or a v1.x tag', () => {
    assert.equal(floatingTagForRelease(['alchemy-new-publish-action@1.0.0']), 'v1')
    assert.equal(floatingTagForRelease(['alchemy-new-publish-action@1.2.3']), 'v1')
    assert.equal(floatingTagForRelease(['v1.4.5']), 'v1')
    assert.equal(
      floatingTagForRelease(['v1', 'alchemy-new-publish-action@1.2.3', 'other@9.9.9']),
      'v1',
    )
  })

  it('leaves v1 in place for prereleases, other majors, and unrelated tags', () => {
    assert.equal(floatingTagForRelease(['alchemy-new-publish-action@1.2.3-rc.1']), undefined)
    assert.equal(floatingTagForRelease(['v1.2.3-rc.1']), undefined)
    assert.equal(floatingTagForRelease(['alchemy-new-publish-action@2.0.0']), undefined)
    assert.equal(floatingTagForRelease(['v2.0.0']), undefined)
    assert.equal(floatingTagForRelease(['v1']), undefined)
    assert.equal(floatingTagForRelease(['1.2.3']), undefined)
    assert.equal(floatingTagForRelease(['alchemy-new-publish-action@1.2.3+build']), undefined)
    assert.equal(
      floatingTagForRelease(['alchemy-new-publish-action@1.2.3', 'v2.0.0']),
      undefined,
    )
    assert.equal(floatingTagForRelease([]), undefined)
  })
})
