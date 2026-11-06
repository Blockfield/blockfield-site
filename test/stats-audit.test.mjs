import test from 'node:test'
import assert from 'node:assert/strict'
import { database } from './storage.mjs'

const actor = {
  actorUuid: '00000000-0000-4000-8000-000000000003',
  actorName: 'Owner',
  role: 'owner',
}

async function write(store, n, base = {}) {
  for (let i = 0; i < n; i++)
    await store.audit({ ...actor, action: `probe:${i}`, ok: true, ...base })
}

test('audit rows record via/client/correlation and read back through auditLog', async (t) => {
  const store = await database(t)
  await store.audit({
    ...actor,
    action: 'kick',
    target: 'griefer',
    ok: true,
    via: 'discord',
    client: 'bot:1',
    correlation: 'req-123',
  })
  const [row] = await store.auditLog(1)
  assert.equal(row.via, 'discord')
  assert.equal(row.client, 'bot:1')
  assert.equal(row.correlation, 'req-123')
  // Site writes without an explicit transport are the web UI.
  await store.audit({ ...actor, action: 'ban', ok: true })
  const [latest] = await store.auditLog(1)
  assert.equal(latest.via, 'ui')
})

test('unknown via is rejected', async (t) => {
  const store = await database(t)
  await assert.rejects(store.audit({ ...actor, action: 'x', ok: true, via: 'spoofed' }), /via/)
})

test('no count-based pruning: rows survive past 10 000 (fail-before: old code keeps 10 000)', async (t) => {
  const store = await database(t)
  await write(store, 10_005)
  assert.equal((await store.auditLog(20_000)).length, 10_005)
})

test('retention deletion requires a verified export; pending rows survive', async (t) => {
  const store = await database(t)
  await write(store, 2)
  const pendingId = await store.auditPending({ ...actor, action: 'pending-op', ok: true })
  await write(store, 1)
  // Invented manifest: no such export.
  await assert.rejects(
    store.deleteAuditExported({
      version: 1,
      exportedAt: Date.now(),
      firstId: 1,
      lastId: 4,
      count: 3,
      sha256: '0'.repeat(64),
    }),
    /verified export/,
  )
  const { manifest } = await store.exportAudit()
  assert.equal(manifest.count, 3)
  assert.equal(manifest.version, 1)
  // Tampered manifest: count no longer matches the export.
  await assert.rejects(
    store.deleteAuditExported({ ...manifest, count: manifest.count - 1 }),
    /verified export/,
  )
  const again = await store.exportAudit()
  assert.equal(again.manifest.sha256, manifest.sha256)
  const deleted = await store.deleteAuditExported(manifest)
  assert.equal(deleted, 3)
  const left = await store.auditLog(10)
  assert.equal(left.length, 1)
  assert.equal(left[0].id, pendingId)
})
