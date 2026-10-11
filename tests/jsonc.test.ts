import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseJsonc } from '../src/jsonc.ts'

describe('parseJsonc', () => {
  it('keeps comments out of strings and drops trailing commas', () => {
    const value = parseJsonc(`{
      // line comment
      "note": "https://example.com // not a comment",
      "block": "/* still a string */",
      "list": ["a", "b",],
      /* block
         comment */
      "ok": true,
    }`)
    assert.deepEqual(value, {
      note: 'https://example.com // not a comment',
      block: '/* still a string */',
      list: ['a', 'b'],
      ok: true,
    })
  })

  it('rejects an unterminated comment', () => {
    assert.throws(() => parseJsonc('/* nope'), /Unterminated block comment/)
  })
})
