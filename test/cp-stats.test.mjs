import test from 'node:test'
import assert from 'node:assert/strict'
import {
  shadowCompareResults,
  resolveTestEligibility,
  reconcileSeasonCounts,
  formatSeasonDrift,
} from '../src/lib/cp-stats.ts'

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

test('season reconcile counts site vs CP and logs drift', () => {
  const season = { id: 's2', startsAt: '2026-09-26T00:00:00.000Z' }
  const site = [
    { serverId: A, eventId: A, digest: 'same' },
    { serverId: A, eventId: B, digest: 'local-only' },
  ]
  const cp = [{ serverId: A, eventId: A, digest: 'same' }]
  const frozenSite = structuredClone(site)
  const frozenCp = structuredClone(cp)
  const drift = reconcileSeasonCounts(season, site, cp)
  assert.equal(drift.season, 's2')
  assert.equal(drift.siteCount, 2)
  assert.equal(drift.cpCount, 1)
  assert.equal(drift.drift, 1)
  assert.deepEqual(drift.missingInCentral, [{ serverId: A, eventId: B }])
  assert.deepEqual(drift.missingLocally, [])
  assert.deepEqual(drift.digestMismatch, [])
  assert.deepEqual(site, frozenSite)
  assert.deepEqual(cp, frozenCp)
  const clean = reconcileSeasonCounts(season, site, site)
  assert.equal(clean.drift, 0)
  assert.equal(
    formatSeasonDrift(clean),
    'cp-stats reconcile s2 since 2026-09-26T00:00:00.000Z: site=2 cp=2 drift=0',
  )
  const logged = formatSeasonDrift(drift)
  assert.match(logged, /drift=1/)
  assert.match(logged, new RegExp(`missing in CP: ${A}/${B}`))
})
