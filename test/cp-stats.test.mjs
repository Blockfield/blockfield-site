import test from 'node:test'
import assert from 'node:assert/strict'
import { shadowCompareResults, resolveTestEligibility } from '../src/lib/cp-stats.ts'

const A = '123e4567-e89b-12d3-a456-426614174000'
const B = '123e4567-e89b-12d3-a456-426614174001'

test('shadow compare reconciles IDs without writing (fail-before: no such module)', () => {
  const local = [
    { serverId: A, eventId: B, digest: 'same' },
    { serverId: A, eventId: A, digest: 'local-only' },
    { serverId: B, eventId: B, digest: 'old' },
  ]
  const central = [
    { serverId: A, eventId: B, digest: 'same' },
    { serverId: B, eventId: B, digest: 'new' },
    { serverId: B, eventId: A, digest: 'central-only' },
  ]
  const frozenLocal = structuredClone(local)
  const frozenCentral = structuredClone(central)
  assert.deepEqual(shadowCompareResults(local, central), {
    missingInCentral: [{ serverId: A, eventId: A }],
    missingLocally: [{ serverId: B, eventId: A }],
    digestMismatch: [{ serverId: B, eventId: B }],
  })
  assert.deepEqual(local, frozenLocal)
  assert.deepEqual(central, frozenCentral)
})

test('shadow compare of identical exports is empty', () => {
  const rows = [{ serverId: A, eventId: B, digest: 'same' }]
  assert.deepEqual(shadowCompareResults(rows, structuredClone(rows)), {
    missingInCentral: [],
    missingLocally: [],
    digestMismatch: [],
  })
})

test('CP test flag is authoritative over local rating', () => {
  assert.deepEqual(resolveTestEligibility(true, true), { eligible: false, needsReview: false })
  assert.deepEqual(resolveTestEligibility(true, null), { eligible: false, needsReview: true })
  assert.deepEqual(resolveTestEligibility(true, undefined), { eligible: false, needsReview: true })
  assert.deepEqual(resolveTestEligibility(true, false), { eligible: true, needsReview: false })
  assert.deepEqual(resolveTestEligibility(false, false), { eligible: false, needsReview: false })
  assert.deepEqual(resolveTestEligibility(false, true), { eligible: false, needsReview: false })
})
