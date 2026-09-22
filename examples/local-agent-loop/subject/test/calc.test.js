import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { add, mul } from '../src/calc.js'

describe('calc', () => {
  it('adds integers', () => {
    assert.equal(add(2, 3), 5)
  })

  it('adds decimals without truncation', () => {
    assert.equal(add(0.1, 0.2), 0.30000000000000004)
  })

  it('multiplies', () => {
    assert.equal(mul(3, 4), 12)
  })
})
