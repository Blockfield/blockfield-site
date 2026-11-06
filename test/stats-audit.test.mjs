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

test('retention deletion requires the archived export, not just its manifest', async (t) => {
  const store = await database(t)
  await write(store, 3)
  const { manifest, jsonl } = await store.exportAudit()
  assert.equal(manifest.count, 3)
  // Manifest alone with the archive lost: refused.
  await assert.rejects(store.deleteAuditExported(manifest, undefined), /verified export/)
  // Corrupt archive: refused.
  await assert.rejects(store.deleteAuditExported(manifest, 'not jsonl'), /verified export/)
  const lines = jsonl.split('\n')
  await assert.rejects(
    store.deleteAuditExported(manifest, lines.slice(0, 2).join('\n')),
    /verified export/,
  )
  const tampered = [...lines]
  tampered[1] = tampered[1].replace('"probe:1"', '"probe:X"')
  await assert.rejects(store.deleteAuditExported(manifest, tampered.join('\n')), /verified export/)
  // Refused attempts deleted nothing.
  assert.equal((await store.auditLog(10)).length, 3)
  assert.equal(await store.deleteAuditExported(manifest, jsonl), 3)
  assert.equal((await store.auditLog(10)).length, 0)
  // Replaying the archive after a successful delete: the rows are gone.
  await assert.rejects(store.deleteAuditExported(manifest, jsonl), /verified export/)
})

test('retention deletion works past the engine bind limit', async (t) => {
  const store = await database(t)
  await write(store, 40_000)
  const { manifest, jsonl } = await store.exportAudit()
  assert.equal(manifest.count, 40_000)
  assert.equal(await store.deleteAuditExported(manifest, jsonl), 40_000)
  assert.equal((await store.auditLog(1)).length, 0)
})

test('rows finalized after the export are not deleted with the exported range', async (t) => {
  const store = await database(t)
  await write(store, 2)
  const pendingId = await store.auditPending({ ...actor, action: 'pending-op', ok: true })
  await write(store, 1)
  const { manifest, jsonl } = await store.exportAudit()
  assert.equal(manifest.count, 3)
  // The pending row finalizes inside the exported id range after the export.
  await store.auditFinalize(pendingId, { ...actor, action: 'pending-op', ok: true })
  assert.equal(await store.deleteAuditExported(manifest, jsonl), 3)
  const left = await store.auditLog(10)
  assert.equal(left.length, 1)
  assert.equal(left[0].id, pendingId)
})

test('auditFinalize keeps the journal-time transport', async (t) => {
  const store = await database(t)
  const id = await store.auditPending({
    ...actor,
    action: 'discord-op',
    ok: true,
    via: 'discord',
    client: 'bot:1',
    correlation: 'c1',
  })
  await store.auditFinalize(id, { ...actor, action: 'discord-op', ok: true })
  const [row] = await store.auditLog(1)
  assert.equal(row.via, 'discord')
  assert.equal(row.client, 'bot:1')
  assert.equal(row.correlation, 'c1')
})
