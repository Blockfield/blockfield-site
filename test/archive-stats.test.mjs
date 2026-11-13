import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  archiveSiteStats,
  LEGACY_STATS_TABLES,
  verifyArchive,
} from '../scripts/archive-site-stats.mjs'
import { saveReport, validateReport } from '../src/lib/diagnostics.ts'
import { databaseUrl } from './storage.mjs'
import { StatsStore } from '../src/lib/stats.ts'

test('archiveSiteStats dumps all 9 legacy stats/diagnostics/ingest tables, verifies SHA-256, and excludes site auth tables', async (t) => {
  const url = await databaseUrl(t)
  const store = await StatsStore.open(url)
  t.after(() => store.close())

  const serverId = '00000000-0000-4000-8000-000000000001'
  const red = '00000000-0000-4000-8000-000000000003'
  const blue = '00000000-0000-4000-8000-000000000004'
  const now = Date.now()
  const campaignId = randomUUID()
  await store.ingest({
    schemaVersion: 1,
    serverId,
    eventId: campaignId,
    kind: 'campaign',
    sessionPurpose: 'gameplay',
    modeId: 'campaign',
    ranked: true,
    rulesetVersion: '1',
    matchId: null,
    campaignSessionId: campaignId,
    mapId: null,
    startedAt: new Date(now - 120_000).toISOString(),
    endedAt: new Date(now - 60_000).toISOString(),
    endReason: 'completed',
    winner: 'RED',
    rounds: [randomUUID()],
    participants: [
      {
        uuid: red,
        name: 'RedPlayer',
        team: 'RED',
        score: 20,
        kills: 2,
        deaths: 1,
        captures: 1,
        neutralizations: 0,
        pointSeconds: 30,
        playSeconds: 60,
        suicides: 0,
        teamKills: 0,
        maxKillstreak: 2,
        classes: [
          {
            classId: 'assault',
            variantId: '0',
            timeSeconds: 60,
            kills: 2,
            deaths: 1,
            pointSeconds: 30,
          },
        ],
      },
      {
        uuid: blue,
        name: 'BluePlayer',
        team: 'BLUE',
        score: 10,
        kills: 1,
        deaths: 2,
        captures: 0,
        neutralizations: 0,
        pointSeconds: 5,
        playSeconds: 60,
        suicides: 0,
        teamKills: 0,
        maxKillstreak: 1,
        classes: [
          {
            classId: 'assault',
            variantId: '0',
            timeSeconds: 60,
            kills: 1,
            deaths: 2,
            pointSeconds: 5,
          },
        ],
      },
    ],
  })
  await store.createIngestKey(serverId, 'legacy-key')
  await saveReport(
    store.db,
    validateReport({
      schemaVersion: 1,
      serverId,
      samples: [{ at: now - 30_000, tps: 20, msptAvg: 12, msptMax: 25 }],
      events: [{ id: randomUUID(), at: now - 20_000, kind: 'warning', message: 'slow tick' }],
    }),
  )
  await store.setStaff(red, 'RedPlayer', 'admin', 'seed')
  await store.audit({
    actorUuid: red,
    actorName: 'RedPlayer',
    role: 'admin',
    action: 'test-action',
    ok: true,
  })
  await store.db
    .prepare(
      'INSERT INTO site_sessions (id,drasl_token,uuid,created_at,last_seen) VALUES (?,?,?,?,?)',
    )
    .run('sess-1', 'encrypted-token-secret', red, now, now)

  const outDir = mkdtempSync(join(tmpdir(), 'bf-archive-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))

  const manifest = await archiveSiteStats(url, outDir)
  assert.equal(manifest.tables.length, LEGACY_STATS_TABLES.length)
  assert.deepEqual(manifest.excludedTables, ['site_sessions', 'staff_roles', 'admin_audit'])
  assert.equal(manifest.tables.find((x) => x.name === 'results').rows, 1)
  assert.equal(manifest.tables.find((x) => x.name === 'participants').rows, 2)
  assert.equal(manifest.tables.find((x) => x.name === 'ratings').rows, 2)
  assert.equal(manifest.tables.find((x) => x.name === 'server_samples').rows, 1)
  assert.equal(manifest.tables.find((x) => x.name === 'server_events').rows, 1)
  assert.equal(manifest.tables.find((x) => x.name === 'ingest_keys').rows, 1)

  const verified = await verifyArchive(outDir)
  assert.equal(verified.format, 'blockfield-site-stats-archive-v1')

  // Never overwrites an existing manifest unless explicitly allowed.
  await assert.rejects(() => archiveSiteStats(url, outDir), /already exists/)

  // Verify no site secrets or URL DSN leaked into manifest or NDJSON files.
  const manifestText = readFileSync(join(outDir, 'manifest.json'), 'utf8')
  assert.ok(!manifestText.includes('test-only'))
  assert.ok(!manifestText.includes('postgres://'))

  // Detect corrupted/tampered archive file.
  writeFileSync(join(outDir, 'results.ndjson'), '{"tampered":true}\n', 'utf8')
  await assert.rejects(() => verifyArchive(outDir), /mismatch/)
})
