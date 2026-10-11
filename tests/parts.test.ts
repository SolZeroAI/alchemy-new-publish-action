import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { MAX_PART_BYTES, MIN_PART_BYTES } from "../src/constants.ts"
import { planPartLengths } from "../src/upload.ts"

const MIB = 1024 * 1024

describe("planPartLengths", () => {
  it("uploads a small archive as one part", () => {
    assert.deepEqual(planPartLengths(100, MAX_PART_BYTES), [100])
    assert.deepEqual(planPartLengths(3 * MIB, 4 * MIB), [3 * MIB])
  })

  it("splits on the server part size inside the 5 to 8 MiB range", () => {
    assert.deepEqual(planPartLengths(9 * MIB, MAX_PART_BYTES), [MAX_PART_BYTES, MIB])
    assert.deepEqual(planPartLengths(20 * MIB, MAX_PART_BYTES), [
      MAX_PART_BYTES,
      MAX_PART_BYTES,
      4 * MIB,
    ])
  })

  it("refuses a multi-part upload whose part size is under 5 MiB", () => {
    assert.throws(() => planPartLengths(10 * MIB, MIN_PART_BYTES - 1), /5 MiB to 8 MiB/)
  })
})
