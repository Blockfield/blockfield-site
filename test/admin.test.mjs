import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  rejectedByServer,
  can,
  checkRoleChange,
  devUser,
  handleAdmin,
  owners,
  playerId,
  moderationRequest,
  moderationCpFields,
  roleOf,
  siteBans,
  siteIdentity,
  validateSettings,
  workshopMembers,
  prepareWorkshopRequest,
  withMapAccess,
  handleWorkshopAccess,
  handleWorkshopSubmit,
} from '../src/lib/admin.ts'

const OWNER = 'e10438e4797b49718cfecec6a8fa171b',
  ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  MOD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  OTHER = 'cccccccccccccccccccccccccccccccc'
const status = (error) =>
  error instanceof Response ? error.status : assert.fail(`expected Response, got ${error}`)
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-admin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
import { database as store, databaseUrl, singletonDatabase } from './storage.mjs'
import { StatsError, statsStore } from '../src/lib/stats.ts'
import { subscribe } from '../src/lib/admin-events.ts'

after(await singletonDatabase())

test('permission map: roles grow strictly, unknown/no role has nothing', () => {
  assert.equal(can('builder', 'view'), true)
  assert.equal(can('builder', 'moderate'), false)
  assert.equal(can('moderator', 'mode'), false)
  assert.equal(can('moderator', 'maps'), true)
  assert.equal(can('moderator', 'recover'), false)
  assert.equal(can('moderator', 'ban'), false)
  assert.equal(can('admin', 'settings'), true)
  assert.equal(can('admin', 'roles'), true)
  assert.equal(can('admin', 'roles-admin'), false)
  assert.equal(can('owner', 'roles-admin'), true)
  assert.equal(can(null, 'view'), false)
  assert.equal(can('root', 'view'), false)
})

test('mode switch and cancel are admin-only; map create stays with the moderator', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const http = await import('node:http')
  const cp = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 202
    res.end(JSON.stringify({ operationId: 'op-1', revision: null, status: 'accepted' }))
  })
  await new Promise((resolve) => cp.listen(0, '127.0.0.1', resolve))
  t.after(() => cp.close())
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${cp.address().port}`,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  const s = await store(t)
  await s.setStaff(MOD, 'Mod', 'moderator', 'seed')
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const call = async (as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, s).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal(can('moderator', 'mode'), false, 'a moderator must not switch the server mode')
  assert.equal(can('moderator', 'maps'), true, 'map create/rename stay with the moderator')
  assert.equal(can('admin', 'mode'), true)
  assert.equal(
    (await call(`${MOD}:Mod`, 'POST', 'mode', { profile: 'game', expectedRevision: 0 })).status,
    403,
  )
  assert.equal((await call(`${MOD}:Mod`, 'POST', 'cancel', {})).status, 403)
  assert.equal((await call(`${MOD}:Mod`, 'POST', 'message', { message: 'hi' })).status, 200)
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'POST', 'mode', { profile: 'game', expectedRevision: 0 })).status,
    200,
  )
})

test('pending audit rows stay visible as unfinished and are marked at boot', async (t) => {
  const { StatsStore: Open } = await import('../src/lib/stats.ts')
  const url = await databaseUrl(t)
  const entry = {
    actorUuid: 'a'.repeat(32),
    actorName: 'Adm',
    role: 'admin',
    action: 'mode',
    target: 'game',
    ok: false,
    error: null,
  }
  const first = await Open.open(url)
  const id = await first.auditPending(entry)
  const shown = (await first.auditLog()).find((e) => e.id === id)
  assert.equal(shown?.pending, 1, 'unfinished attempts stay visible in the journal')
  assert.equal(shown?.ok, 0)
  await first.close()
  // A crash between the row and the effect: reopening marks the orphan instead of hiding it.
  const second = await Open.open(url)
  t.after(() => second.close())
  const marked = (await second.auditLog()).find((e) => e.id === id)
  assert.equal(marked?.pending, null)
  assert.equal(marked?.ok, 0)
  assert.match(marked?.error ?? '', /Прервано/)
})

test('workshop tablet flows journal first: dead log fails closed, lost finalize errors', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaffMaps(OTHER, ['fields'])
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async () => new Response('', { status: 404 })
  const KEY = 'k'.repeat(40)
  const grant = { actor: ADMIN, target: OTHER, mapId: 'hub', allowed: true }
  const call = (storage, body) =>
    handleWorkshopAccess(
      new Request('http://site/api/workshop/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      }),
      { BLOCKFIELD_WORKSHOP_KEY: KEY },
      storage,
    ).then(
      (r) => r,
      (e) => e,
    )
  assert.equal((await call(s, grant)).status, 200)
  const dead = new Proxy(s, {
    get: (target, prop) =>
      prop === 'auditPending'
        ? async () => {
            throw new StatsError(503, 'audit store is down')
          }
        : Reflect.get(target, prop),
  })
  assert.equal(
    (await call(dead, { ...grant, mapId: 'fields', allowed: false })).status,
    503,
    'nothing runs unaudited',
  )
  assert.deepEqual(
    (await s.staff()).find((row) => row.uuid === OTHER).maps,
    ['fields', 'hub'],
    'the grant never ran',
  )
  const flaky = new Proxy(s, {
    get: (target, prop) =>
      prop === 'auditFinalize'
        ? async () => {
            throw new StatsError(503, 'audit store is down')
          }
        : Reflect.get(target, prop),
  })
  assert.equal(
    (await call(flaky, { ...grant, mapId: 'fields', allowed: false })).status,
    503,
    'a lost finalize fails closed like staff/map-access',
  )
})

test('audit finalize stays silent until emitAudit', async (t) => {
  const s = await store(t)
  const seen = []
  const off = subscribe(
    (event) => event.type === 'audit',
    (event) => seen.push(event),
  )
  t.after(off)
  const id = await s.auditPending({
    actorUuid: ADMIN,
    actorName: 'Adm',
    role: 'admin',
    action: 'message',
    ok: false,
    error: null,
  })
  await s.auditFinalize(id, {
    actorUuid: ADMIN,
    actorName: 'Adm',
    role: 'admin',
    action: 'message',
    ok: true,
    error: null,
  })
  assert.equal(seen.length, 0, 'finalize must not publish before the commit')
  s.emitAudit({ action: 'message', ok: true })
  assert.equal(seen.length, 1)
})

test('a failed commit never shows as ok in the live feed', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'builder', 'seed')
  const seen = []
  const off = subscribe(
    (event) => event.type === 'audit',
    (event) => seen.push(event),
  )
  t.after(off)
  const noCommit = new Proxy(s, {
    get: (target, prop) => {
      if (prop === 'db') {
        const fake = Object.create(
          Object.getPrototypeOf(target.db),
          Object.getOwnPropertyDescriptors(target.db),
        )
        fake.transaction = async (work) => {
          await work()
          throw new Error('commit failed')
        }
        return fake
      }
      return Reflect.get(target, prop)
    },
  })
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OWNER}:Owner`
  const url = new URL('http://site/api/admin/staff')
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uuid: ADMIN, role: 'moderator' }),
  })
  const response = await handleAdmin(
    { request, url, cookies: { get: () => undefined } },
    'staff',
    noCommit,
  ).then(
    (r) => r,
    (e) => e,
  )
  assert.ok(response.status >= 500)
  assert.equal(
    seen.filter((e) => e.entry.action === 'role-grant' && e.entry.ok).length,
    0,
    'rolled-back writes never show as ok',
  )
})

test('tx failure is not applied: a rolled-back role change errors and leaves the role unchanged', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'builder', 'seed')
  const flaky = new Proxy(s, {
    get: (target, prop) =>
      prop === 'auditFinalize'
        ? async () => {
            throw new StatsError(503, 'audit store is down')
          }
        : Reflect.get(target, prop),
  })
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OWNER}:Owner`
  const url = new URL('http://site/api/admin/staff')
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uuid: ADMIN, role: 'moderator' }),
  })
  const response = await handleAdmin(
    { request, url, cookies: { get: () => undefined } },
    'staff',
    flaky,
  ).then(
    (r) => r,
    (e) => e,
  )
  assert.ok(response.status >= 500, `a rolled-back write must error, got ${response.status}`)
  assert.equal(
    (await s.staff()).find((r) => r.uuid === ADMIN)?.role,
    'builder',
    'the role update rolled back with the finalize',
  )
})

test('audit leads the effect: a dead log fails everything closed before anything runs', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const http = await import('node:http')
  let cpCalls = 0
  const cp = http.createServer((req, res) => {
    cpCalls++
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 202
    res.end(JSON.stringify({ operationId: 'op-dead', revision: null, status: 'accepted' }))
  })
  await new Promise((resolve) => cp.listen(0, '127.0.0.1', resolve))
  t.after(() => cp.close())
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${cp.address().port}`,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const dead = new Proxy(s, {
    get: (target, prop) =>
      prop === 'auditPending'
        ? async () => {
            throw new StatsError(503, 'audit store is down')
          }
        : Reflect.get(target, prop),
  })
  const call = async (storage, as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, storage).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal(
    (await call(dead, `${ADMIN}:Adm`, 'POST', 'mode', { profile: 'game', expectedRevision: 11 }))
      .status,
    503,
    'high-risk never runs unaudited',
  )
  assert.equal(
    (await call(dead, `${ADMIN}:Adm`, 'POST', 'message', { message: 'hi-pending-dead' })).status,
    503,
    'nothing runs unaudited, however small',
  )
  assert.equal(cpCalls, 0, 'no side effect ran')
})

test('finalize failure: low-risk warns on 200, high-risk fails closed', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const http = await import('node:http')
  const seen = []
  const cp = http.createServer((req, res) => {
    seen.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 202
    res.end(JSON.stringify({ operationId: 'op-flaky', revision: null, status: 'accepted' }))
  })
  await new Promise((resolve) => cp.listen(0, '127.0.0.1', resolve))
  t.after(() => cp.close())
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${cp.address().port}`,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  const flaky = new Proxy(s, {
    get: (target, prop) =>
      prop === 'auditFinalize'
        ? async () => {
            throw new StatsError(503, 'audit store is down')
          }
        : Reflect.get(target, prop),
  })
  const call = async (as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, flaky).then(
      (r) => r,
      (e) => e,
    )
  }
  const warned = await call(`${ADMIN}:Adm`, 'POST', 'message', { message: 'hi-flaky' })
  assert.equal(warned.status, 200)
  assert.match((await warned.json()).auditWarning, /не повторяйте/)
  assert.equal(warned.headers.get('X-Audit-Warning') !== null, true)
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'POST', 'mode', { profile: 'game', expectedRevision: 12012 }))
      .status,
    503,
    'high-risk fails closed when the finalize is lost',
  )
  assert.deepEqual(seen, ['/v2/workshop/message', '/v2/workshop/mode'])
})

test('admin writes are throttled per user: a flood ends in 429, reads are untouched', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const FLOOD = 'dddddddddddddddddddddddddddddddd'
  const s = await store(t)
  await s.setStaff(FLOOD, 'Flo', 'builder', 'seed')
  const call = async (method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${FLOOD}:Flo`
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, s).then(
      (r) => r,
      (e) => e,
    )
  }
  for (let i = 0; i < 60; i++)
    assert.equal((await call('POST', 'message', { message: 'hi' })).status, 403)
  assert.equal((await call('POST', 'message', { message: 'hi' })).status, 429)
  assert.equal((await (await call('GET', 'me')).json()).role, 'builder')
})

test('bootstrap fails closed: no env and no rows means nobody; owners come only from env', async (t) => {
  const s = await store(t)
  assert.equal(owners(undefined).size, 0)
  assert.equal(owners('').size, 0)
  assert.equal(await roleOf(OWNER, s, owners(undefined)), null)
  assert.deepEqual(
    [...owners(`e10438e4-797b-4971-8cfe-cec6a8fa171b, junk,${ADMIN.toUpperCase()}`)],
    [OWNER, ADMIN],
  )
  assert.equal(await roleOf(OWNER, s, owners(OWNER)), 'owner')
  await s.setStaff(MOD, 'Mod', 'moderator', 'x')
  await s.setStaff(OTHER, 'Evil', 'owner', 'x')
  assert.equal(await roleOf(MOD, s, new Set()), 'moderator')
  assert.equal(await roleOf(OTHER, s, new Set()), null, 'a stored owner row is not an owner')
  assert.equal(playerId('E10438E4-797B-4971-8CFE-CEC6A8FA171B'), OWNER)
  assert.equal(playerId('nope'), null)
})

test('role change rules: admin manages builder/moderator only, no self change, owners immutable', () => {
  const ids = new Set([OWNER]),
    admin = { uuid: ADMIN, name: 'Adm', role: 'admin' },
    owner = { uuid: OWNER, name: 'Own', role: 'owner' }
  checkRoleChange(admin, MOD, null, 'moderator', ids)
  checkRoleChange(admin, MOD, 'moderator', null, ids)
  for (const [actor, target, from, to] of [
    [admin, MOD, null, 'admin'],
    [admin, MOD, 'admin', null],
    [admin, ADMIN, 'admin', 'builder'],
    [owner, OWNER, 'owner', null],
    [owner, OWNER, 'owner', 'admin'],
    [owner, MOD, null, 'owner'],
    [{ uuid: MOD, name: 'M', role: 'moderator' }, OTHER, null, 'builder'],
  ])
    assert.throws(
      () => checkRoleChange(actor, target, from, to, ids),
      (e) => status(e) === 403,
    )
  checkRoleChange(owner, ADMIN, 'admin', null, ids)
  checkRoleChange(owner, MOD, null, 'admin', ids)
})

test('workshop members mapping: owner/admin→admin, moderator→lead, builder→builder', () => {
  const members = workshopMembers(
    [
      { uuid: MOD, name: 'Mod', role: 'moderator' },
      { uuid: ADMIN, name: 'Adm', role: 'admin' },
      { uuid: OTHER, name: 'Bob', role: 'builder' },
    ],
    new Map([[OWNER, 'Nether']]),
  )
  assert.deepEqual(members, [
    { draslId: ADMIN, name: 'Adm', role: 'admin' },
    { draslId: MOD, name: 'Mod', role: 'lead' },
    { draslId: OTHER, name: 'Bob', role: 'builder' },
    { draslId: OWNER, name: 'Nether', role: 'admin' },
  ])
})

test("workshop members: a builder's map list rides along, lead/admin never carry one even if stored", () => {
  const members = workshopMembers(
    [
      { uuid: OTHER, name: 'Bob', role: 'builder', maps: ['fields', 'konstaxa'] },
      { uuid: MOD, name: 'Mod', role: 'moderator', maps: ['fields'] },
      { uuid: ADMIN, name: 'Adm', role: 'admin', maps: null },
    ],
    new Map(),
  )
  assert.deepEqual(members, [
    { draslId: ADMIN, name: 'Adm', role: 'admin' },
    { draslId: MOD, name: 'Mod', role: 'lead' },
    { draslId: OTHER, name: 'Bob', role: 'builder', maps: ['fields', 'konstaxa'] },
  ])
  // null/absent maps means every map: the key is left out entirely. [] is a real, different value: no maps, and it must ride along too.
  assert.deepEqual(
    workshopMembers([{ uuid: OTHER, name: 'Bob', role: 'builder', maps: null }], new Map()),
    [{ draslId: OTHER, name: 'Bob', role: 'builder' }],
  )
  assert.deepEqual(
    workshopMembers([{ uuid: OTHER, name: 'Bob', role: 'builder', maps: [] }], new Map()),
    [{ draslId: OTHER, name: 'Bob', role: 'builder', maps: [] }],
  )
})

test('workshop request is validated and mapped to a typed CP payload', () => {
  const lead = { uuid: MOD, name: 'Mod', role: 'moderator' },
    admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }
  const modeReq = prepareWorkshopRequest(lead, {
    kind: 'mode',
    profile: 'workshop',
    expectedRevision: 3,
    session: 'new',
    maps: null,
  })
  assert.deepEqual(modeReq, {
    cpKind: 'mode',
    fields: {
      profile: 'workshop',
      expectedRevision: 3,
      session: 'new',
      maps: null,
    },
  })
  for (const [actor, body, code] of [
    [lead, { kind: 'mode', profile: 'game', expectedRevision: 3, recover: true }, 403],
    [admin, { kind: 'mode', profile: 'workshop', expectedRevision: 3, recover: true }, 400],
    [admin, { kind: 'mode', profile: 'maintenance', expectedRevision: 3 }, 400],
    [admin, { kind: 'mode', profile: 'game' }, 400],
    [admin, { kind: 'mode', profile: 'workshop', expectedRevision: 3 }, 400, 'no session'],
    [admin, { kind: 'members', members: [{ draslId: 'bad', name: 'Bob', role: 'admin' }] }, 400],
    [admin, { kind: 'shell' }, 400],
  ])
    assert.throws(
      () => prepareWorkshopRequest(actor, body),
      (e) => status(e) === code,
      JSON.stringify(body),
    )
  const gameReq = prepareWorkshopRequest(admin, {
    kind: 'mode',
    profile: 'game',
    expectedRevision: 0,
    recover: true,
  })
  assert.equal(gameReq.fields.recover, true)
  // maps: [] is a valid, distinct value (no maps, not "every map"), and must survive as prepared.
  const mapsReq = prepareWorkshopRequest(admin, {
    kind: 'members',
    members: [{ draslId: OTHER, name: 'Bob', role: 'builder', maps: [] }],
  })
  assert.deepEqual(mapsReq.fields.members, [
    { draslId: OTHER, name: 'Bob', role: 'builder', maps: [] },
  ])
})

test('mode request: workshop needs a session; "new" validates maps against MAP_IDS (hub included), "resume" never carries maps', () => {
  const admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }
  const all = prepareWorkshopRequest(admin, {
    kind: 'mode',
    profile: 'workshop',
    expectedRevision: 1,
    session: 'new',
    maps: null,
  })
  assert.equal(all.fields.maps, null)
  const some = prepareWorkshopRequest(admin, {
    kind: 'mode',
    profile: 'workshop',
    expectedRevision: 1,
    session: 'new',
    maps: ['fields', 'hub'],
  })
  assert.deepEqual(some.fields.maps, ['fields', 'hub'])
  const resume = prepareWorkshopRequest(admin, {
    kind: 'mode',
    profile: 'workshop',
    expectedRevision: 1,
    session: 'resume',
    maps: ['fields'],
  })
  assert.equal(
    'maps' in resume.fields,
    false,
    'resume never carries maps, even if the caller sent some',
  )
  for (const body of [
    { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'later' },
    { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'new', maps: [] },
    { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'new', maps: ['not_a_map'] },
    {
      kind: 'mode',
      profile: 'workshop',
      expectedRevision: 1,
      session: 'new',
      maps: ['fields', 'fields'],
    },
  ])
    assert.throws(
      () => prepareWorkshopRequest(admin, body),
      (e) => status(e) === 400,
      JSON.stringify(body),
    )
})

test('mode request: test profile needs a known candidate id', () => {
  const admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }
  const testMode = prepareWorkshopRequest(admin, {
    kind: 'mode',
    profile: 'test',
    expectedRevision: 2,
    candidateId: 'a'.repeat(32),
  })
  assert.equal(testMode.fields.candidateId, 'a'.repeat(32))
  for (const body of [
    { kind: 'mode', profile: 'test', expectedRevision: 2 },
    { kind: 'mode', profile: 'test', expectedRevision: 2, candidateId: 'nope' },
  ])
    assert.throws(
      () => prepareWorkshopRequest(admin, body),
      (e) => status(e) === 400,
      JSON.stringify(body),
    )
})

test('publish request: optional force must be boolean, only set when true', () => {
  const admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }
  const plain = prepareWorkshopRequest(admin, { kind: 'publish', candidateId: 'a'.repeat(32) })
  assert.equal('force' in plain.fields.args, false)
  const forced = prepareWorkshopRequest(admin, {
    kind: 'publish',
    candidateId: 'a'.repeat(32),
    force: true,
  })
  assert.equal(forced.fields.args.force, true)
  const declined = prepareWorkshopRequest(admin, {
    kind: 'publish',
    candidateId: 'a'.repeat(32),
    force: false,
  })
  assert.equal('force' in declined.fields.args, false)
  assert.throws(
    () =>
      prepareWorkshopRequest(admin, {
        kind: 'publish',
        candidateId: 'a'.repeat(32),
        force: 'yes',
      }),
    (e) => status(e) === 400,
  )
})

test('settings validation rejects bad sections like the server', () => {
  for (const body of [
    { lobby: { pvpCooldownSeconds: 601 } },
    { lobby: { pvp: true } },
    { rooms: { maxRooms: 0 } },
    { rooms: { idleCloseSeconds: 29.5 } },
    { classLocks: ['Sniper'] },
    { classLocks: ['a', 'a'] },
    { campaignBalance: { '*': { rm_rf: 1 } } },
    { campaignBalance: { '*': { enable_spawn_shield: 1 } } },
    { campaignBalance: { 'bad id!': { max_tickets: 1 } } },
    { campaignBalance: { '*': { max_tickets: Infinity } } },
    { extra: 1 },
    { deathmatch: { minPlayers: 0 } },
    { deathmatch: { minPlayers: 25 } },
    { deathmatch: { minPlayers: 2.5 } },
    { deathmatch: { minPlayer: 3 } },
    { parcool: { allowedActions: ['Fastrun'] } },
    { parcool: { allowedActions: ['FastRun', 'FastRun'] } },
    { parcool: { allowedActions: 'FastRun' } },
    { parcool: { allowedActions: ['FastRun'], extra: 1 } },
    { parcool: [] },
    { parcool: 'FastRun' },
  ])
    assert.throws(
      () => validateSettings(body),
      (e) => status(e) === 400,
      JSON.stringify(body),
    )
  assert.deepEqual(validateSettings({ deathmatch: { minPlayers: 3 } }), {
    deathmatch: { minPlayers: 3 },
  })
  // Owner wants to be able to start deathmatch alone.
  assert.deepEqual(validateSettings({ deathmatch: { minPlayers: 1 } }), {
    deathmatch: { minPlayers: 1 },
  })
  // Present with an empty list forbids every parkour action; absent leaves the mod's base file in charge.
  assert.deepEqual(validateSettings({ parcool: { allowedActions: [] } }), {
    parcool: { allowedActions: [] },
  })
  assert.deepEqual(validateSettings({ parcool: { allowedActions: ['FastRun', 'ClimbUp'] } }), {
    parcool: { allowedActions: ['FastRun', 'ClimbUp'] },
  })
})

test('parcool validation accepts known actions like the other sections', () => {
  // CP revision conflicts for parcool ride saveSettingsCp (see cp-settings-handlers).
  assert.deepEqual(validateSettings({ parcool: { allowedActions: ['FastRun', 'ClingToCliff'] } }), {
    parcool: { allowedActions: ['FastRun', 'ClingToCliff'] },
  })
  assert.equal(validateSettings({ rooms: { maxRooms: 3 } }).parcool, undefined)
})

test('moderation bodies become typed CP fields and injection is refused', () => {
  const room = '0f8e0c3a-1b2c-4d5e-8f90-123456789abc'
  const build = (body) =>
    ['say', 'pardon', 'team-kick', 'class-lock', 'class-unlock', 'range', 'stop-room'].includes(
      body.action,
    )
      ? moderationCpFields(body)
      : moderationRequest(body)
  assert.deepEqual(build({ action: 'kick', player: 'Bob_1', reason: 'spam\nstop' }), {
    permission: 'moderate',
    kind: 'kick',
    fields: { reason: 'spam stop' },
    player: 'Bob_1',
  })
  assert.deepEqual(build({ action: 'say', text: 'Рестарт через §c5 минут' }), {
    text: 'Рестарт через c5 минут',
  })
  assert.deepEqual(build({ action: 'stop-room', roomId: room, outcome: 'RED', reason: 'тест' }), {
    roomId: room,
    outcome: 'RED',
    reason: 'тест',
  })
  assert.deepEqual(build({ action: 'interrupt', reason: 'авария' }).fields, {
    op: 'interrupt',
    reason: 'авария',
  })
  assert.deepEqual(build({ action: 'resume' }).fields, { op: 'resume' })
  assert.deepEqual(build({ action: 'maintenance-status' }).fields, { op: 'status' })
  assert.deepEqual(build({ action: 'class-unlock', classId: 'sniper' }), { classId: 'sniper' })
  assert.equal(build({ action: 'ban', player: 'Bob' }).permission, 'ban')
  for (const body of [
    { action: 'kick', player: 'Bob\nstop' },
    { action: 'kick', player: 'Bob Smith' },
    { action: 'ban', player: '@a' },
    { action: 'say', text: '/op x' },
    { action: 'say', text: '  /op x' },
    { action: 'say', text: '' },
    { action: 'say', text: 'x'.repeat(121) },
    { action: 'op', player: 'Bob' },
    { action: 'stop-room', roomId: `${room} ; stop`, outcome: 'none' },
    { action: 'stop-room', roomId: room, outcome: 'none', reason: 'draw now' },
    { action: 'stop-room', roomId: room, outcome: 'GREEN' },
    { action: 'class-lock', classId: 'sniper forced' },
    { action: 'range', op: 'delete' },
    { action: 'interrupt' },
    { action: 'team-kick', player: 'ab' },
  ])
    assert.throws(
      () => build(body),
      (e) => status(e) === 400,
      JSON.stringify(body),
    )
})

/**
 * Fake control plane for handler tests: POST /v2/actions/<kind> records the body
 * and settles the operation through `settle(kind, body)` ({status, output}); GET
 * /v2/operations/<id> returns it. Drasl name lookups answer from `names`.
 */
async function fakeCp(t, settle, names = {}) {
  const http = await import('node:http')
  const seen = [],
    operations = new Map()
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      const action = req.url.match(/^\/v2\/actions\/(.+)$/)
      if (req.method === 'POST' && action) {
        const body = JSON.parse(raw)
        seen.push([action[1], body, req.headers.authorization])
        const id = `op-${seen.length}`
        operations.set(id, settle(action[1], body))
        res.statusCode = 202
        return res.end(JSON.stringify({ operationId: id, revision: null, status: 'accepted' }))
      }
      const op = req.url.match(/^\/v2\/operations\/(.+)$/)
      if (op && operations.has(op[1])) {
        const { status, output } = operations.get(op[1])
        if (status === 'unreadable') {
          res.statusCode = 500
          return res.end('{}')
        }
        return res.end(
          JSON.stringify({
            operationId: op[1],
            status,
            receipts: [{ state: status, result: { code: 'ok', output } }],
          }),
        )
      }
      const name = req.url.match(/\/profiles\/minecraft\/(\w+)$/)
      if (name && names[name[1]])
        return res.end(JSON.stringify({ id: names[name[1]], name: name[1] }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}`, seen }
}
const GENERATION = '12345678-1234-4234-8234-123456789012'
const dashed = (uuid) => uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')

test('dev escape hatch is off in production and needs a valid uuid:name', () => {
  assert.deepEqual(devUser({ BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether` }), {
    uuid: OWNER,
    name: 'Nether',
  })
  assert.equal(
    devUser({ NODE_ENV: 'production', BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether` }),
    null,
  )
  assert.equal(devUser({ BLOCKFIELD_ADMIN_DEV_USER: 'nope:Nether' }), null)
})

test('API: role gate, audit of success and refusal, members request on role change', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const call = async (as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return handleAdmin(
      { request, url, cookies: { get: () => undefined } },
      path.split('?')[0],
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal((await (await call(`${OTHER}:Nobody`, 'GET', 'me')).json()).role, null)
  assert.equal((await call(`${OTHER}:Nobody`, 'GET', 'overview')).status, 403)
  assert.equal((await call(`${ADMIN}:Adm`, 'GET', 'audit')).status, 200)

  // Owner names resolve through Drasl; stub it so the members request can be built offline.
  // The same stub answers the typed Workshop calls (members and cancel go through CP here).
  const workshopPosts = []
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/v2/workshop/state')) {
      return Response.json({ seq: 1, documents: {} })
    }
    if (String(url).includes('/v2/workshop/')) {
      const payload = init?.body ? JSON.parse(String(init.body)) : null
      workshopPosts.push({ url: String(url), payload })
      const operationId = String(url).endsWith('/members') ? 'op-members' : 'op-cancel'
      return Response.json({ operationId, revision: null, status: 'accepted' }, { status: 202 })
    }
    if (String(url).includes(`/session/minecraft/profile/${OWNER}`))
      return Response.json({ id: OWNER, name: 'Nether' })
    if (String(url).endsWith('/Moddy')) return Response.json({ id: MOD, name: 'Moddy' })
    return new Response('', { status: 404 })
  }

  assert.equal(
    (await call(`${ADMIN}:Adm`, 'POST', 'staff', { name: 'Moddy', role: 'admin' })).status,
    403,
  )
  const granted = await call(`${ADMIN}:Adm`, 'POST', 'staff', { name: 'Moddy', role: 'moderator' })
  assert.equal(granted.status, 200)
  const { sync } = await granted.json()
  assert.equal(sync.id, 'op-members')
  const membersPost = workshopPosts.find((p) => p.url.endsWith('/members'))
  assert.deepEqual(membersPost?.payload?.members, [
    { draslId: ADMIN, name: 'Adm', role: 'admin' },
    { draslId: MOD, name: 'Moddy', role: 'lead' },
    { draslId: OWNER, name: 'Nether', role: 'admin' },
  ])
  assert.equal(
    (await call(`${MOD}:Moddy`, 'POST', 'rcon', { action: 'ban', player: 'Bob' })).status,
    403,
  )
  assert.equal(
    (await call(`${MOD}:Moddy`, 'POST', 'rcon', { action: 'kick', player: 'Bob\nstop' })).status,
    400,
  )
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'POST', 'staff', { uuid: ADMIN, role: null })).status,
    403,
  )

  // cancel and members go through CP (operationId receipts).
  assert.equal((await call(`${OTHER}:Nobody`, 'POST', 'cancel', {})).status, 403)
  assert.equal((await call(`${MOD}:Moddy`, 'POST', 'cancel', {})).status, 403)
  const cancelled = await call(`${ADMIN}:Adm`, 'POST', 'cancel', {})
  assert.equal(cancelled.status, 200)
  assert.deepEqual(await cancelled.json(), { operationId: 'op-cancel' })

  const log = (await (await call(`${OWNER}:Nether`, 'GET', 'audit')).json()).entries
  assert.deepEqual(
    log.map((e) => [e.actorName, e.action, e.ok, e.error !== null]),
    [
      ['Adm', 'cancel', 1, false],
      ['Moddy', 'cancel', 0, true],
      ['Adm', 'role-revoke', 0, true],
      ['Moddy', 'rcon:kick', 0, true],
      ['Moddy', 'rcon:ban', 0, true],
      ['Adm', 'role-grant', 1, false],
      ['Adm', 'role-grant', 0, true],
    ],
  )
  assert.equal(log[5].target, MOD)
  assert.equal(JSON.parse(log[5].detail).role, 'moderator')
})

test('POST rcon/raw audit: a body that never named a target is logged as unknown, not game', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`,
  })
  const s = await store(t)
  const raw = (text) => {
    const url = new URL('http://site/api/admin/rcon/raw')
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'rcon/raw', s).then(
      (r) => r,
      (e) => e,
    )
  }
  // All three fail validation (no command), but only the object body implies the game target.
  assert.equal((await raw('null')).status, 400)
  assert.equal((await raw('"oops"')).status, 400)
  assert.equal((await raw('{}')).status, 400)
  const url = new URL('http://site/api/admin/audit')
  const log = await (
    await handleAdmin(
      {
        request: new Request(url, { headers: { 'content-type': 'application/json' } }),
        url,
        cookies: { get: () => undefined },
      },
      'audit',
      s,
    )
  ).json()
  const targets = log.entries
    .filter((e) => e.action === 'rcon:raw')
    .map((e) => JSON.parse(e.detail).target)
  assert.deepEqual(targets, ['game', 'unknown', 'unknown'])
})

test('review: range keeps its op, Brigadier rejections are detected', () => {
  assert.deepEqual(moderationCpFields({ action: 'range', op: 'close' }), { op: 'close' })
  for (const reply of [
    'Unknown or incomplete command, see below for error',
    'Unknown command',
    'range close<--[HERE]',
  ])
    assert.equal(rejectedByServer(reply), true, reply)
  assert.equal(rejectedByServer('[BlockField] Полигон закрыт, выведено игроков: 0'), false)
})

test('review: balance types, per-key ranges and merged cross-checks match the mod', () => {
  validateSettings({
    campaignBalance: {
      '*': {
        max_tickets: 100000,
        score_per_obj_sec: 0.5,
        base_warn_radius: 50,
        base_kill_radius: 40,
        ready_timeout_seconds: 10,
      },
      desert: { max_players_per_team: 8 },
    },
  })
  for (const balance of [
    { '*': { max_tickets: 0 } },
    { '*': { max_tickets: 1.5 } },
    { '*': { ready_timeout_seconds: 9 } },
    { '*': { spawn_shield_duration_seconds: 61 } },
    { '*': { score_per_obj_sec: 1000.5 } },
    { '*': { enable_spawn_shield: 'true' } },
    { '*': { shuffle_teams_between_rounds: 1 } },
    { '*': { min_players_per_team: 5, max_players_per_team: 4 } },
    { '*': { min_players_per_team: 5 }, desert: { max_players_per_team: 4 } },
    { '*': { base_warn_radius: 30 }, desert: { base_kill_radius: 31 } },
  ])
    assert.throws(
      () => validateSettings({ campaignBalance: balance }),
      (e) => status(e) === 400,
      JSON.stringify(balance),
    )
})

test('review: non-staff are refused before the body is read and never audited; CP errors hide addresses', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: 'http://127.0.0.1:1',
    BLOCKFIELD_CP_MODERATION_TOKEN: 'x',
    BLOCKFIELD_CP_CONSUMER_GENERATION: GENERATION,
  })
  const s = await store(t)
  let read = false
  const call = (as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    Object.defineProperty(request, 'body', {
      get() {
        read = true
        return null
      },
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, s).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal(
    (
      await call(`${OTHER}:Nobody`, 'PUT', 'settings', {
        expectedRevision: 0,
        x: 'y'.repeat(60000),
      })
    ).status,
    403,
  )
  assert.equal(read, false)
  assert.equal((await s.auditLog()).length, 0)
  const failed = await handleAdmin(
    (() => {
      process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OWNER}:Nether`
      const url = new URL('http://site/api/admin/rcon')
      return {
        request: new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'list' }),
        }),
        url,
        cookies: { get: () => undefined },
      }
    })(),
    'rcon',
    s,
  ).then(
    (r) => r,
    (e) => e,
  )
  // CP unreachable: a read is unconfirmed, never an address in the reply.
  assert.equal(failed.status, 504)
  const text = (await failed.json()).error
  assert.equal(text, 'Сервер не ответил. Попробуйте ещё раз.')
  assert.ok(!text.includes('127.0.0.1'))
  assert.equal((await s.auditLog())[0].ok, 0)
})

test('owner row falls back to the last known profile name, the signed-in owner name, then «Неизвестный игрок», when Drasl is down', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const second = 'dddddddddddddddddddddddddddddddd',
    third = 'ffffffffffffffffffffffffffffffff'
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: `${OWNER},${second},${third}`,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${second}:Second`,
  })
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  const s = await store(t)
  await s.db
    .prepare('INSERT INTO profiles VALUES (?,?,?)')
    .run('e10438e4-797b-4971-8cfe-cec6a8fa171b', 'Nether', 1)
  const url = new URL('http://site/api/admin/staff')
  const response = await handleAdmin(
    { request: new Request(url), url, cookies: { get: () => undefined } },
    'staff',
    s,
  )
  assert.deepEqual((await response.json()).owners, [
    { uuid: OWNER, name: 'Nether' },
    { uuid: second, name: 'Second' },
    { uuid: third, name: 'Неизвестный игрок' },
  ])
})

test('siteIdentity: dev user short-circuits, missing/invalid cookie is anonymous, role decides admin access', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OTHER}:Guest`,
  })
  await statsStore()
  assert.deepEqual(
    await siteIdentity({ get: () => undefined }),
    { name: 'Guest', hasAdminAccess: false },
    'dev user with no staff row can still open /admin as no-role',
  )
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OWNER}:Nether`
  assert.deepEqual(await siteIdentity({ get: () => undefined }), {
    name: 'Nether',
    hasAdminAccess: true,
  })
  delete process.env.BLOCKFIELD_ADMIN_DEV_USER
  assert.equal(
    await siteIdentity({ get: () => undefined }),
    null,
    'no session cookie, no dev user: signed out',
  )
})

test('siteIdentity keeps the name when the CP role read fails (site#120 major)', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_SESSION_SECRET: 'b'.repeat(64),
    BLOCKFIELD_CP_URL: 'http://cp.test',
    BLOCKFIELD_CP_STAFF_TOKEN: 'staff-t',
    DRASL_URL: 'http://drasl.test',
  })
  delete process.env.BLOCKFIELD_ADMIN_DEV_USER
  const { startSession } = await import('../src/lib/account.ts')
  // siteIdentity resolves the session through the statsStore() singleton, so the
  // session row must live there (not in a separate isolated schema).
  const { statsStore } = await import('../src/lib/stats.ts')
  const s = await statsStore()
  const jar = new Map()
  const cookies = {
    get: (name) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name, value) => jar.set(name, value),
  }
  const uuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  await startSession(cookies, s, 'drasl-token', OTHER)
  const realFetch = globalThis.fetch
  const errors = []
  const realError = console.error
  console.error = (...args) => errors.push(args)
  t.after(() => {
    globalThis.fetch = realFetch
    console.error = realError
  })
  // CP staff read 500s while Drasl answers: the user stays signed in, only the admin link hides.
  globalThis.fetch = async (url) =>
    String(url).startsWith('http://drasl.test')
      ? new Response(JSON.stringify({ username: 'Hero', players: [{ uuid }] }), { status: 200 })
      : new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
  assert.deepEqual(await siteIdentity(cookies), { name: 'Hero', hasAdminAccess: false })
  assert.equal(errors.length, 1, 'one log line for the failed role lookup')
  // Drasl itself failing still means signed out.
  globalThis.fetch = async (url) =>
    String(url).startsWith('http://drasl.test')
      ? new Response(JSON.stringify({ error: 'down' }), { status: 500 })
      : new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
  assert.equal(await siteIdentity(cookies), null)
})

test('POST staff/maps: only a builder row accepts a map list, ids must be known and unique', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`,
  })
  const s = await store(t)
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async () => new Response('', { status: 404 })
  const call = (path, body) => {
    const url = new URL(`http://site/api/admin/${path}`)
    return handleAdmin(
      {
        request: new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        url,
        cookies: { get: () => undefined },
      },
      path,
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal(
    (await call('staff/maps', { uuid: MOD, maps: ['fields'] })).status,
    400,
    'a moderator has every map, cannot be given a list',
  )
  assert.equal((await call('staff/maps', { uuid: OTHER, maps: ['not_a_map'] })).status, 400)
  assert.equal(
    (await call('staff/maps', { uuid: OTHER, maps: ['fields', 'fields'] })).status,
    400,
    'duplicates rejected',
  )
  const ok = await call('staff/maps', { uuid: OTHER, maps: ['fields', 'konstaxa'] })
  assert.equal(ok.status, 200)
  assert.deepEqual((await s.staff()).find((row) => row.uuid === OTHER).maps, ['fields', 'konstaxa'])
  // [] is a real, distinct value: the builder keeps a workshop account but has nothing to edit.
  const none = await call('staff/maps', { uuid: OTHER, maps: [] })
  assert.equal(none.status, 200)
  assert.deepEqual((await s.staff()).find((row) => row.uuid === OTHER).maps, [])
  const cleared = await call('staff/maps', { uuid: OTHER, maps: null })
  assert.equal(cleared.status, 200)
  assert.equal((await s.staff()).find((row) => row.uuid === OTHER).maps, null)
})

test("GET candidates/download: only an accepted candidate's exported package, with its checksum", async (t) => {
  const adminDir = temp(t)
  const defaultPackagesDir = join(adminDir, 'packages')
  const overridePackagesDir = temp(t)
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const accepted = { id: 'a'.repeat(32), status: 'accepted', sha256: '1'.repeat(64) },
    pending = { id: 'b'.repeat(32), status: 'pending', sha256: '2'.repeat(64) }
  const http = await import('node:http')
  const cp = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        seq: 1,
        documents: {
          candidates: {
            name: 'candidates',
            revision: 1,
            seq: 1,
            updatedAt: 1,
            value: { schema: 1, candidates: [accepted, pending] },
          },
        },
      }),
    )
  })
  await new Promise((resolve) => cp.listen(0, '127.0.0.1', resolve))
  t.after(() => cp.close())
  delete process.env.BLOCKFIELD_MAP_PACKAGES_DIR
  Object.assign(process.env, {
    BLOCKFIELD_ADMIN_DIR: adminDir,
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`,
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${cp.address().port}`,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
  })
  const s = await store(t)
  const call = (id) => {
    const url = new URL(`http://site/api/admin/candidates/download?id=${id}`)
    return handleAdmin(
      { request: new Request(url), url, cookies: { get: () => undefined } },
      'candidates/download',
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal((await call(accepted.id)).status, 503, 'accepted but not exported yet')
  mkdirSync(defaultPackagesDir)
  writeFileSync(join(defaultPackagesDir, `${accepted.sha256}.zip`), 'zip-bytes')
  writeFileSync(join(defaultPackagesDir, `${pending.sha256}.zip`), 'zip-bytes')
  const ok = await call(accepted.id)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('x-checksum-sha256'), accepted.sha256)
  assert.equal(await ok.text(), 'zip-bytes')
  assert.equal((await call(pending.id)).status, 404, 'a pending candidate is not downloadable')
  assert.equal((await call('../etc')).status, 400)
  process.env.BLOCKFIELD_MAP_PACKAGES_DIR = overridePackagesDir
  assert.equal((await call(accepted.id)).status, 503, 'override dir has precedence over default')
  writeFileSync(join(overridePackagesDir, `${accepted.sha256}.zip`), 'override-bytes')
  const overridden = await call(accepted.id)
  assert.equal(overridden.status, 200)
  assert.equal(await overridden.text(), 'override-bytes')
})

test('withMapAccess: grant keeps "every map", revoke from "every map" lists the rest, a grant never implies future maps', () => {
  assert.equal(withMapAccess(null, 'fields', true), null)
  assert.deepEqual(withMapAccess(['konstaxa'], 'fields', true), ['konstaxa', 'fields'])
  assert.deepEqual(withMapAccess(['fields'], 'fields', true), ['fields'])
  assert.deepEqual(withMapAccess(['konstaxa', 'fields'], 'fields', false), ['konstaxa'])
  const rest = withMapAccess(null, 'fields', false)
  assert.ok(!rest.includes('fields') && rest.includes('konstaxa'))
})

test('POST staff/map-access: sets one map for every builder in one request, only known maps and builders', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`,
    BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  const s = await store(t)
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  await s.setStaff(MOD, 'Moddy', 'builder', 'seed')
  await s.setStaffMaps(MOD, ['konstaxa'])
  const membersPosts = []
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/v2/workshop/state')) {
      return Response.json({ seq: 1, documents: {} })
    }
    if (String(url).includes('/v2/workshop/members')) {
      membersPosts.push(JSON.parse(String(init?.body ?? '{}')))
      return Response.json(
        { operationId: 'op-map-access', revision: null, status: 'accepted' },
        { status: 202 },
      )
    }
    return new Response('', { status: 404 })
  }
  const call = (body) => {
    const url = new URL('http://site/api/admin/staff/map-access')
    return handleAdmin(
      {
        request: new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        url,
        cookies: { get: () => undefined },
      },
      'staff/map-access',
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal((await call({ mapId: 'not_a_map', uuids: [] })).status, 400)
  assert.equal(
    (await call({ mapId: 'fields', uuids: [OWNER] })).status,
    400,
    'only builders carry map lists',
  )
  const ok = await call({ mapId: 'fields', uuids: [MOD] })
  assert.equal(ok.status, 200)
  const maps = (uuid) => s.staff().then((rows) => rows.find((row) => row.uuid === uuid).maps)
  assert.deepEqual(await maps(MOD), ['konstaxa', 'fields'])
  assert.ok(
    !(await maps(OTHER)).includes('fields') && (await maps(OTHER)).includes('konstaxa'),
    'Bob had every map, now every map but fields',
  )
  assert.equal(membersPosts.length, 1, 'one members request for the whole change')
})

test("POST /api/workshop/access: key, then the in-game actor's own site role; hub is a scope; audited", async (t) => {
  const dirs = { BLOCKFIELD_ADMIN_DIR: temp(t) }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  await s.setStaffMaps(OTHER, ['fields'])
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async () => new Response('', { status: 404 })
  const KEY = 'k'.repeat(40),
    ENV_KEY = 'e'.repeat(40),
    env = { BLOCKFIELD_WORKSHOP_KEY: KEY }
  const call = (body, key = KEY, e = env) =>
    handleWorkshopAccess(
      new Request('http://site/api/workshop/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }),
      e,
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  const grant = { actor: OWNER, target: OTHER, mapId: 'hub', allowed: true }
  assert.equal((await call(grant, KEY, {})).status, 503, 'no key configured')
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'workshop.key'), `${KEY}\n`)
  assert.equal(
    (await call({ ...grant, actor: MOD }, KEY, {})).status,
    403,
    'the key file in the admin export works like the env',
  )
  assert.equal(
    (await call({ ...grant, actor: MOD }, ENV_KEY, { BLOCKFIELD_WORKSHOP_KEY: ENV_KEY })).status,
    403,
    'env wins over the key file when set',
  )
  assert.equal(
    (await call(grant, KEY, { BLOCKFIELD_WORKSHOP_KEY: ENV_KEY })).status,
    401,
    'key file is not accepted when env overrides it',
  )
  assert.equal((await call(grant, 'wrong'.repeat(8))).status, 401)
  assert.equal(
    (await call({ ...grant, actor: MOD })).status,
    403,
    'a moderator cannot change rights',
  )
  assert.equal((await call({ ...grant, target: MOD })).status, 400, 'only builders carry map lists')
  assert.equal((await call({ ...grant, mapId: 'nowhere' })).status, 400)
  const ok = await call(grant)
  assert.equal(ok.status, 200)
  assert.deepEqual((await s.staff()).find((row) => row.uuid === OTHER).maps, ['fields', 'hub'])
  assert.equal((await call({ ...grant, mapId: 'fields', allowed: false })).status, 200)
  assert.deepEqual((await s.staff()).find((row) => row.uuid === OTHER).maps, ['hub'])
  const log = await s.auditLog(20)
  assert.ok(
    log.some((e) => e.action === 'workshop-map-access' && e.ok && e.target === 'hub'),
    'granted from the game is in the journal',
  )
  assert.ok(
    log.some((e) => e.action === 'workshop-map-access' && !e.ok),
    'refusals are journaled too',
  )
})

test('concurrent tablet and web map grants for one builder keep both grants', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`,
  })
  const s = await store(t)
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  await s.setStaffMaps(OTHER, ['fields'])
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async () => new Response('', { status: 404 })
  const KEY = 'k'.repeat(40)
  // Both requests must snapshot before either writes to lose a grant. The gate releases on the
  // second staff() read; the timeout releases it for the serialized path, where the second
  // request never reaches its read until the first one is done.
  let calls = 0,
    release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const timer = setTimeout(release, 100)
  t.after(() => clearTimeout(timer))
  const gated = new Proxy(s, {
    get: (target, prop) => {
      if (prop === 'staff')
        return async (...args) => {
          calls++
          if (calls >= 2) release()
          await gate
          return target.staff(...args)
        }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const tablet = handleWorkshopAccess(
    new Request('http://site/api/workshop/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ actor: OWNER, target: OTHER, mapId: 'hub', allowed: true }),
    }),
    { BLOCKFIELD_WORKSHOP_KEY: KEY },
    gated,
  ).then(
    (r) => r,
    (e) => e,
  )
  const web = (() => {
    const url = new URL('http://site/api/admin/staff/map-access')
    return handleAdmin(
      {
        request: new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mapId: 'konstaxa', uuids: [OTHER] }),
        }),
        url,
        cookies: { get: () => undefined },
      },
      'staff/map-access',
      gated,
    ).then(
      (r) => r,
      (e) => e,
    )
  })()
  const [tabletReply, webReply] = await Promise.all([tablet, web])
  assert.equal(tabletReply.status, 200)
  assert.equal(webReply.status, 200)
  const maps = (await s.staff()).find((row) => row.uuid === OTHER).maps
  assert.deepEqual([...maps].sort(), ['fields', 'hub', 'konstaxa'])
})

test('POST /api/workshop/submit: a builder only for maps they build on; posts a CP candidate request; journaled', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const s = await store(t)
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  await s.setStaffMaps(OTHER, ['fields'])
  const KEY = 'k'.repeat(40)
  const workingCopyId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const buildMaps = (merged) => ({
    schema: 1,
    maps: ['fields', 'konstaxa'].map((mapId) => ({
      mapId,
      kind: 'arena',
      mapJson: { id: mapId },
      head: merged
        ? {
            schema: 1,
            mapId,
            kind: 'arena',
            versionDigest: 'a'.repeat(64),
            generation: 1,
            bundle: 'bundle',
            activatedAt: 1,
            activatedBy: { name: 'Bob' },
          }
        : null,
      versions: [
        {
          schema: 1,
          mapId,
          kind: 'arena',
          versionDigest: 'a'.repeat(64),
          parent: null,
          createdAt: 1,
          author: { name: 'Bob' },
          source: 'commit',
          note: 'Layout update',
          worldDigest: 'b'.repeat(64),
          changed: ['world/region/r.0.0.mca'],
          deleted: [],
          fileCount: 2,
        },
      ],
      branches: [
        ...(merged
          ? [
              {
                schema: 1,
                mapId,
                name: 'main',
                versionDigest: 'a'.repeat(64),
                generation: 1,
                workingCopyId: null,
                createdAt: 1,
                createdBy: { name: 'Bob' },
              },
            ]
          : []),
        {
          schema: 1,
          mapId,
          name: 'layout-work',
          versionDigest: 'a'.repeat(64),
          generation: 1,
          workingCopyId: null,
          createdAt: 1,
          createdBy: { draslId: OTHER, name: 'Bob' },
        },
      ],
    })),
  })
  const cpDocs = {
    maps: buildMaps(false),
    session: {
      schema: 1,
      id: workingCopyId,
      maps: ['fields', 'konstaxa'],
      branches: { fields: 'layout-work', konstaxa: 'layout-work' },
    },
    status: {
      schema: 1,
      phase: 'workshop',
      gate: 'builders',
      desired: { profile: 'workshop', session: workingCopyId },
    },
  }
  const cpResults = {}
  const cpPosts = []
  let opSeq = 0
  const http = await import('node:http')
  const { randomUUID } = await import('node:crypto')
  const cpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname.startsWith('/v2/workshop/')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const operationId = randomUUID()
        cpPosts.push({
          id: operationId,
          kind: url.pathname.slice('/v2/workshop/'.length),
          body: JSON.parse(body),
        })
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ operationId, revision: null, status: 'accepted' }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v2/workshop/state') {
      const names = (url.searchParams.get('names') ?? '').split(',').filter(Boolean)
      const documents = {}
      opSeq++
      for (const name of names) {
        if (name in cpDocs && cpDocs[name] !== undefined) {
          documents[name] = { name, revision: opSeq, seq: opSeq, updatedAt: 1, value: cpDocs[name] }
        } else if (name.startsWith('result:')) {
          const id = name.slice('result:'.length)
          if (id in cpResults) {
            documents[name] = {
              name,
              revision: opSeq,
              seq: opSeq,
              updatedAt: 1,
              value: cpResults[id],
            }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ seq: opSeq, documents }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => cpServer.listen(0, '127.0.0.1', resolve))
  t.after(() => cpServer.close())
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_WORKSHOP_KEY: KEY,
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${cpServer.address().port}`,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  const call = (body) =>
    handleWorkshopSubmit(
      new Request('http://site/api/workshop/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      }),
      { BLOCKFIELD_WORKSHOP_KEY: KEY },
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  assert.equal((await call({ actor: OTHER, mapId: 'konstaxa' })).status, 403, 'not his map')
  assert.equal((await call({ actor: OTHER, mapId: 'hub' })).status, 400, 'the hub is not a map')
  assert.equal(
    (
      await call({
        actor: OTHER,
        actorName: 'Bob',
        mapId: 'fields',
        workingCopyId: '00000000-0000-0000-0000-000000000000',
      })
    ).status,
    409,
    'stale working copy',
  )
  cpDocs.maps = buildMaps(true)
  const ok = await call({ actor: OTHER, actorName: 'Bob', mapId: 'fields', workingCopyId })
  assert.equal(ok.status, 200)
  assert.equal(cpPosts.length, 1)
  const firstPost = cpPosts[0].body
  assert.deepEqual(
    [firstPost.mapOp, firstPost.args.mapId, firstPost.actor.name],
    ['candidate', 'fields', 'Bob'],
  )
  assert.equal(firstPost.args.workingCopyId, workingCopyId)
  assert.equal(firstPost.args.expectedHead, 'a'.repeat(64))
  assert.equal(firstPost.args.commit, true)
  assert.equal(firstPost.args.note, 'С планшета: Bob')
  const { id } = await ok.json()
  const poll = (receipt = id, key = KEY) =>
    handleWorkshopSubmit(
      new Request(`http://site/api/workshop/submit?id=${receipt}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
      { BLOCKFIELD_WORKSHOP_KEY: KEY },
      s,
    ).catch((error) => error)
  assert.deepEqual(await (await poll()).json(), { result: null })
  assert.equal((await poll(id, 'wrong-key')).status, 401)
  assert.equal((await poll('../bad')).status, 400)
  const result = { id, ok: false, error: 'no changes on the branch', doneAt: Date.now() }
  cpResults[id] = result
  assert.deepEqual(await (await poll()).json(), { result }, 'controller refusal reaches the tablet')
  result.ok = true
  result.error = null
  result.payload = { mapId: 'fields' }
  cpResults[id] = result
  assert.deepEqual(await (await poll()).json(), { result })
  cpResults[id] = { ...result, schema: 2 }
  assert.equal((await poll()).status, 503, 'unknown result schema is refused')

  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OTHER}:Bob`
  const web = (body) => {
    const url = new URL('http://site/api/admin/candidates/create')
    return handleAdmin(
      {
        url,
        request: new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        cookies: { get: () => undefined },
      },
      'candidates/create',
      s,
    ).catch((error) => error)
  }
  const draft = { mapId: 'fields', workingCopyId, expectedHead: 'a'.repeat(64) }
  assert.equal((await web({ mapId: 'fields' })).status, 409, 'review pins the working copy')
  assert.equal(
    (await web({ ...draft, workingCopyId: '00000000-0000-0000-0000-000000000000' })).status,
    409,
    'stale copy is refused',
  )
  assert.equal((await web(draft)).status, 200, 'plain review queues')
  assert.equal((await web({ ...draft, commit: true, note: '' })).status, 400)
  assert.equal(
    (await web({ ...draft, expectedHead: 'b'.repeat(64), commit: true, note: 'Update' })).status,
    409,
  )
  const combined = await web({ ...draft, commit: true, note: ' Layout update ' })
  assert.equal(combined.status, 200)
  const combinedId = (await combined.json()).id
  const combinedPost = cpPosts.find((p) => p.id === combinedId)?.body
  assert.equal(combinedPost.mapOp, 'candidate')
  assert.equal(combinedPost.args.commit, true)
  assert.equal(combinedPost.args.note, 'Layout update')
  assert.equal(combinedPost.args.workingCopyId, workingCopyId)
  assert.equal(combinedPost.args.expectedHead, 'a'.repeat(64))
  assert.equal(cpPosts.length, 3, 'one request per submission')
  assert.ok(
    (await s.auditLog(5)).some(
      (e) => e.action === 'workshop-candidate' && e.ok && e.target === 'fields',
    ),
  )
})

test('prepareWorkshopRequest: candidate/rollback take a real map, publish/reject a candidate id', () => {
  const actor = { uuid: OWNER, name: 'Nether', role: 'owner' }
  assert.ok(prepareWorkshopRequest(actor, { kind: 'candidate', mapId: 'konstaxa' }))
  const combined = {
    kind: 'candidate',
    mapId: 'konstaxa',
    workingCopyId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    expectedHead: 'a'.repeat(64),
    commit: true,
    note: 'Update',
  }
  assert.ok(prepareWorkshopRequest(actor, combined))
  for (const overrides of [
    { note: '' },
    { note: 'a'.repeat(201) },
    { note: 'line\nbreak' },
    { workingCopyId: undefined },
    { expectedHead: undefined },
    { commit: 'true' },
  ])
    assert.throws(() => prepareWorkshopRequest(actor, { ...combined, ...overrides }))
  assert.ok(prepareWorkshopRequest(actor, { kind: 'publish', candidateId: 'a'.repeat(32) }))
  assert.throws(() => prepareWorkshopRequest(actor, { kind: 'rollback', mapId: 'hub' }))
  assert.throws(() => prepareWorkshopRequest(actor, { kind: 'reject', candidateId: '../x' }))
})

test('review: stop-room without CP configured fails fast, before querying rooms', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`,
    BLOCKFIELD_SERVER_HOST: '10.255.255.1',
    BLOCKFIELD_LOBBY_HOST: '10.255.255.1',
  })
  delete process.env.BLOCKFIELD_CP_MODERATION_TOKEN
  delete process.env.BLOCKFIELD_GATE_FILE
  const s = await store(t),
    url = new URL('http://site/api/admin/rcon'),
    started = Date.now()
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'stop-room',
      roomId: '0f8e0c3a-1b2c-4d5e-8f90-123456789abc',
      outcome: 'draw',
    }),
  })
  const response = await handleAdmin(
    { request, url, cookies: { get: () => undefined } },
    'rcon',
    s,
  ).then(
    (r) => r,
    (e) => e,
  )
  assert.equal(response.status, 503)
  assert.ok(Date.now() - started < 1000)
})

test('class prices validate through settings with strict numeric limits', () => {
  const prices = { tech: 0, sniper: 150, drone: 10000 }
  // CP persistence for classCosts rides saveSettingsCp (see cp-settings-handlers).
  assert.deepEqual(validateSettings({ classCosts: prices }), { classCosts: prices })
  for (const classCosts of [
    { sniper: -1 },
    { sniper: 0.5 },
    { sniper: 10001 },
    { sniper: '90' },
    { sniper: null },
    { sniper: Infinity },
    { assault: 10 },
    [],
    null,
  ]) {
    assert.throws(
      () => validateSettings({ classCosts }),
      (e) => status(e) === 400,
    )
  }
})

test('raw console: owner only, one validated line through CP, every call audited including refusals', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const cp = await fakeCp(t, (kind, body) => ({
    status: 'effective',
    output:
      body.command === 'bogus'
        ? 'Unknown or incomplete command'
        : body.command.includes('example-short-password')
          ? '{"client_secret":"response-short-secret","password":"reply-short-password"}'
          : '§aDone',
  }))
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: cp.url,
    BLOCKFIELD_CP_CONSOLE_TOKEN: 'console-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: GENERATION,
  })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  const call = (as, command, target) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL('http://site/api/admin/rcon/raw')
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(target !== undefined ? { command, target } : { command }),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'rcon/raw', s).then(
      (r) => r,
      (e) => e,
    )
  }
  for (const who of [`${ADMIN}:Adm`, `${MOD}:Moddy`, `${OTHER}:Bob`])
    assert.equal((await call(who, 'stop')).status, 403, who)
  assert.equal((await call(`${OWNER}:Nether`, 'say a\nstop')).status, 400)
  const ok = await call(`${OWNER}:Nether`, '/time set day')
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), {
    command: 'time set day',
    output: 'Done',
    rejected: false,
    target: 'game',
  })
  assert.equal((await (await call(`${OWNER}:Nether`, 'bogus')).json()).rejected, true)
  // Exactly the ConsoleRun fields: CP refuses unknown keys (no resource or target).
  assert.deepEqual(Object.keys(cp.seen[0][1]).sort(), [
    'actorAccountId',
    'backend',
    'command',
    'consumerId',
    'environment',
    'generation',
    'idempotencyKey',
  ])
  assert.deepEqual(
    cp.seen.map(([kind, body, auth]) => [kind, body.command, body.actorAccountId, auth]),
    [
      ['console.run', 'time set day', dashed(OWNER), 'Bearer console-t'],
      ['console.run', 'bogus', dashed(OWNER), 'Bearer console-t'],
    ],
    'refused and invalid commands never reach CP',
  )

  const log = await s.auditLog()
  assert.deepEqual(
    log.map((e) => [e.actorName, e.action, e.ok, e.target]),
    [
      ['Nether', 'rcon:raw', 1, 'bogus'],
      ['Nether', 'rcon:raw', 1, 'time set day'],
      ['Nether', 'rcon:raw', 0, 'say a stop'],
      ['Bob', 'rcon:raw', 0, null],
      ['Moddy', 'rcon:raw', 0, null],
      ['Adm', 'rcon:raw', 0, null],
    ],
  )
  assert.equal(JSON.parse(log[1].detail).target, 'game')
  assert.equal(JSON.parse(log[1].detail).output, 'Done')
  const command =
    'data modify storage test:config value set value {"password":"example-short-password","access_token":"short-token"}'
  const privateReply = await (await call(`${OWNER}:Nether`, command)).json()
  assert.equal(privateReply.command, command, 'the owner receives the original command')
  assert.ok(
    privateReply.output.includes('response-short-secret'),
    'the owner receives the raw response',
  )
  assert.equal(
    (await call(`${OWNER}:Nether`, 'say rcon_password=invalid-short-secret\nstop')).status,
    400,
  )
  const sanitized = JSON.stringify((await s.auditLog()).slice(0, 2))
  for (const leak of [
    'example-short-password',
    'short-token',
    'response-short-secret',
    'reply-short-password',
    'invalid-short-secret',
  ])
    assert.ok(!sanitized.includes(leak), `${leak} must not reach the admin-readable audit`)
  assert.ok(sanitized.includes('[secret]'))
})

test('POST rcon interrupt is one CP maintenance action and reports the confirmation window', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const cp = await fakeCp(t, () => ({ status: 'effective', output: 'Done' }))
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: cp.url,
    BLOCKFIELD_CP_MODERATION_TOKEN: 'mod-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: GENERATION,
  })
  delete process.env.BLOCKFIELD_GATE_FILE
  const s = await store(t)
  const call = async (body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OWNER}:Nether`
    const url = new URL('http://site/api/admin/rcon')
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'rcon', s).then(
      (r) => r,
      (e) => e,
    )
  }
  const before = Date.now()
  const first = await call({ action: 'interrupt', reason: 'авария' })
  assert.equal(first.status, 200)
  const firstBody = await first.json()
  assert.ok(
    Number.isInteger(firstBody.interruptAt) && firstBody.interruptAt >= before,
    'interrupt reports when the confirm applied',
  )
  // The game arms and confirms as one sender: the site sends one action.
  assert.deepEqual(
    cp.seen.map(([kind, body]) => [kind, body.op, body.reason]),
    [['moderation.maintenance', 'interrupt', 'авария']],
  )
})

test('POST rcon list/kick/ban/maintenance wait for the game through CP', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const BOB = '0f8e0c3a1b2c4d5e8f90123456789abc'
  const cp = await fakeCp(
    t,
    (kind, body) =>
      kind === 'moderation.list'
        ? { status: 'effective', output: 'There are 2 of a max of 40 players online: Bob, Alice' }
        : kind === 'moderation.kick' && body.reason === 'lost'
          ? { status: 'unreadable', output: undefined }
          : kind === 'moderation.kick'
            ? { status: 'rejected', output: undefined }
            : kind === 'moderation.maintenance' && body.op === 'drain'
              ? { status: 'expired', output: undefined }
              : kind === 'moderation.maintenance' && body.op === 'resume'
                ? { status: 'unknown', output: undefined }
                : kind === 'moderation.maintenance'
                  ? { status: 'effective', output: 'draining=false rooms=0 drained=false' }
                  : { status: 'effective', output: undefined },
    { Bob: BOB },
  )
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: cp.url,
    DRASL_URL: cp.url,
    BLOCKFIELD_CP_MODERATION_TOKEN: 'mod-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: GENERATION,
  })
  delete process.env.BLOCKFIELD_GATE_FILE
  const s = await store(t)
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const call = async (as, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL('http://site/api/admin/rcon')
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'rcon', s).then(
      (r) => r,
      (e) => e,
    )
  }
  const listed = await call(`${MOD}:Moddy`, { action: 'list' })
  assert.equal(listed.status, 200)
  assert.deepEqual((await listed.json()).players, ['Bob', 'Alice'])
  const kicked = await call(`${MOD}:Moddy`, { action: 'kick', player: 'Bob', reason: 'spam' })
  assert.equal(kicked.status, 409)
  assert.equal((await kicked.json()).error, 'Игрок не в сети.')
  assert.equal((await call(`${MOD}:Moddy`, { action: 'ban', player: 'Bob' })).status, 403)
  assert.equal((await call(`${ADMIN}:Adm`, { action: 'ban', player: 'Bob' })).status, 200)
  assert.equal((await call(`${ADMIN}:Adm`, { action: 'ban', player: 'Nobody' })).status, 404)
  assert.equal((await call(`${MOD}:Moddy`, { action: 'maintenance-status' })).status, 403)
  const status = await call(`${ADMIN}:Adm`, { action: 'maintenance-status' })
  assert.equal((await status.json()).output, 'draining=false rooms=0 drained=false')
  // Expired: the game never took it.
  assert.equal((await call(`${ADMIN}:Adm`, { action: 'drain' })).status, 504)
  // Accepted but unconfirmed: kick returns the panel's retry marker, maintenance
  // an error whose audit keeps the operation id for reconciliation.
  const lost = await call(`${MOD}:Moddy`, { action: 'kick', player: 'Bob', reason: 'lost' })
  assert.equal(lost.status, 200)
  assert.deepEqual(await lost.json(), { operationId: 'op-6', unknownOutcome: true })
  const resumed = await call(`${ADMIN}:Adm`, { action: 'resume' })
  assert.equal(resumed.status, 504)
  assert.match((await s.auditLog())[0].error, /unconfirmed operation op-7/)
  assert.deepEqual(
    cp.seen.map(([kind, body]) => [kind, body.playerId ?? body.op ?? null, body.actorAccountId]),
    [
      ['moderation.list', null, dashed(MOD)],
      // CP parses either UUID spelling; the game receives it dashed.
      ['moderation.kick', BOB, dashed(MOD)],
      ['moderation.ban', BOB, dashed(ADMIN)],
      ['moderation.maintenance', 'status', dashed(ADMIN)],
      ['moderation.maintenance', 'drain', dashed(ADMIN)],
      ['moderation.kick', BOB, dashed(MOD)],
      ['moderation.maintenance', 'resume', dashed(ADMIN)],
    ],
  )
  // Audit names stay as before the cutover (the bans list reads rcon:ban rows).
  assert.deepEqual((await s.auditLog()).map((e) => [e.action, e.ok, e.target]).slice(2, 6), [
    ['rcon:drain', 0, null],
    ['rcon:maintenance-status', 1, null],
    ['rcon:maintenance-status', 0, null],
    ['rcon:ban', 0, 'Nobody'],
  ])
  // Only the confirmed ban lists Bob; an unconfirmed ban never does.
  assert.deepEqual(
    (await siteBans(s)).map((b) => b.player),
    ['Bob'],
  )
  await s.audit({
    actorUuid: ADMIN,
    actorName: 'Adm',
    role: 'admin',
    action: 'rcon:ban',
    target: 'Carol',
    detail: { player: 'Carol', operationId: 'op-x', unknownOutcome: true },
    ok: true,
    error: null,
  })
  assert.deepEqual(
    (await siteBans(s)).map((b) => b.player),
    ['Bob'],
  )
})

test('raw console target selector: routes to game or workshop, enforces config and rejects unknown enums', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const cp = await fakeCp(t, (kind, body) => ({
    status: 'effective',
    output: `${body.consumerId}:${body.command}`,
  }))
  const seen = (consumer) =>
    cp.seen.filter(([, body]) => body.consumerId === consumer).map(([, body]) => body.command)
  const game = {
    get seen() {
      return seen('game')
    },
  }
  const workshop = {
    get seen() {
      return seen('workshop-game')
    },
  }
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: cp.url,
    BLOCKFIELD_CP_CONSOLE_TOKEN: 'console-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: GENERATION,
    BLOCKFIELD_CP_WORKSHOP_GAME_CONSUMER_ID: 'workshop-game',
    BLOCKFIELD_CP_WORKSHOP_GAME_CONSUMER_GENERATION: GENERATION,
  })

  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')

  const call = (as, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL('http://site/api/admin/rcon/raw')
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'rcon/raw', s).then(
      (r) => r,
      (e) => e,
    )
  }

  // 1. Target game
  const gameRes = await call(`${OWNER}:Nether`, { command: 'say hello game', target: 'game' })
  assert.equal(gameRes.status, 200)
  assert.deepEqual(await gameRes.json(), {
    command: 'say hello game',
    output: 'game:say hello game',
    rejected: false,
    target: 'game',
  })
  assert.deepEqual(game.seen, ['say hello game'])
  assert.deepEqual(workshop.seen, [])

  // 2. Target workshop
  const wsRes = await call(`${OWNER}:Nether`, { command: 'say hello workshop', target: 'workshop' })
  assert.equal(wsRes.status, 200)
  assert.deepEqual(await wsRes.json(), {
    command: 'say hello workshop',
    output: 'workshop-game:say hello workshop',
    rejected: false,
    target: 'workshop',
  })
  assert.deepEqual(workshop.seen, ['say hello workshop'])

  // 3. Target omitted defaults to game
  const defaultRes = await call(`${OWNER}:Nether`, { command: 'default command' })
  assert.equal(defaultRes.status, 200)
  assert.equal((await defaultRes.json()).target, 'game')
  assert.deepEqual(game.seen, ['say hello game', 'default command'])

  // 4. Unknown target rejected BEFORE network with 400
  for (const badTarget of ['bogus', 'GAME', 'Workshop', 'hub', '127.0.0.1']) {
    const res = await call(`${OWNER}:Nether`, { command: 'test', target: badTarget })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'Неизвестная цель консоли.')
  }
  // Verify neither server saw any of the bad target commands
  assert.deepEqual(game.seen, ['say hello game', 'default command'])
  assert.deepEqual(workshop.seen, ['say hello workshop'])

  // 5. Unconfigured Workshop console returns 503 and NEVER falls back to Game
  delete process.env.BLOCKFIELD_CP_WORKSHOP_GAME_CONSUMER_ID
  const unconfiguredWs = await call(`${OWNER}:Nether`, { command: 'test', target: 'workshop' })
  assert.equal(unconfiguredWs.status, 503)
  assert.equal((await unconfiguredWs.json()).error, 'Консоль Мастерской не настроена.')
  assert.deepEqual(
    game.seen,
    ['say hello game', 'default command'],
    'no fallback from Workshop to Game',
  )

  // 6. Unconfigured Game console returns 503
  delete process.env.BLOCKFIELD_CP_CONSOLE_TOKEN
  const unconfiguredGame = await call(`${OWNER}:Nether`, { command: 'test', target: 'game' })
  assert.equal(unconfiguredGame.status, 503)
  assert.equal((await unconfiguredGame.json()).error, 'Консоль не настроена.')

  // 7. Non-owner roles are denied for both targets unchanged (403)
  for (const who of [`${ADMIN}:Adm`, `${MOD}:Moddy`, `${OTHER}:Bob`]) {
    assert.equal((await call(who, { command: 'stop', target: 'workshop' })).status, 403, who)
    assert.equal((await call(who, { command: 'stop', target: 'game' })).status, 403, who)
  }

  // 8. Audit log records targets
  const auditEntries = await s.auditLog()
  const rawEntries = auditEntries.filter((e) => e.action === 'rcon:raw')
  const wsAudit = rawEntries.find((e) => e.target === 'say hello workshop')
  assert.ok(wsAudit, 'workshop command was audited')
  assert.equal(JSON.parse(wsAudit.detail).target, 'workshop')
  assert.equal(JSON.parse(wsAudit.detail).output, 'workshop-game:say hello workshop')
})

test('diagnostics are admin-only and never report health without data', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  delete process.env.BLOCKFIELD_CP_CONSOLE_TOKEN
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  const call = (as, path) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    return handleAdmin(
      { request: new Request(url), url, cookies: { get: () => undefined } },
      path,
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal((await call(`${MOD}:Moddy`, 'diagnostics')).status, 403)
  assert.equal((await call(`${ADMIN}:Adm`, 'diagnostics')).status, 503)
  assert.equal((await call(`${ADMIN}:Adm`, 'diagnostics/live')).status, 503)
  // Live tick check: the read-only `tick query` through CP, asserted as the admin.
  const cp = await fakeCp(t, () => ({
    status: 'effective',
    output:
      'The game is running normally\nTarget tick rate: 20.0 per second.\n' +
      'Average time per tick: 25.0ms (Target: 50.0ms)',
  }))
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: cp.url,
    BLOCKFIELD_CP_CONSOLE_TOKEN: 'console-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: GENERATION,
  })
  const live = await (await call(`${ADMIN}:Adm`, 'diagnostics/live')).json()
  assert.equal(live.state, 'running')
  assert.equal(live.msptAvg, 25)
  assert.deepEqual(
    cp.seen.map(([kind, body]) => [kind, body.command, body.actorAccountId]),
    [['console.run', 'tick query', dashed(ADMIN)]],
  )
})

test('console via CP: log tail + suggest ride the console token, reads stay unaudited', async (t) => {
  const { createServer } = await import('node:http')
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const seen = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://cp')
    seen.push(`${req.method} ${url.pathname}${url.search} auth=${req.headers.authorization}`)
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer console-t') {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v2/console/logs') {
      const since = url.searchParams.get('since')
      if (url.searchParams.get('consumerId') !== 'game') {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'consumer_not_found' }))
        return
      }
      if (since === '7') {
        res.writeHead(403)
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      if (since === '8') {
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'control_plane_error' }))
        return
      }
      if (since === '9') {
        res.writeHead(200)
        res.end(JSON.stringify({ nope: true }))
        return
      }
      const n = Number(since)
      res.writeHead(200)
      res.end(
        JSON.stringify(
          n === 0
            ? {
                next: 2,
                entries: [
                  { seq: 1, at: 1000, level: 'INFO', logger: 'net.Foo', message: 'hello' },
                  { seq: 2, at: 2000, level: 'WARN', logger: 'net.Foo', message: 'careful' },
                ],
              }
            : { next: n, entries: [] },
        ),
      )
      return
    }
    if (req.method === 'POST' && url.pathname === '/v2/console/suggest') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw)
        seen.push(`suggest input=${body.input} generation=${body.generation}`)
        if (body.consumerId !== 'game' || body.generation !== GENERATION) {
          res.writeHead(409)
          res.end(JSON.stringify({ error: 'consumer_generation_or_capability' }))
          return
        }
        if (body.input === 'forbidden-line') {
          res.writeHead(403)
          res.end(JSON.stringify({ error: 'forbidden' }))
          return
        }
        if (body.input === 'stale') {
          res.writeHead(409)
          res.end(JSON.stringify({ error: 'consumer_generation_or_capability' }))
          return
        }
        if (body.input === 'busy') {
          res.writeHead(409)
          res.end(JSON.stringify({ error: 'consumer_lag' }))
          return
        }
        if (body.input === 'silent') {
          res.writeHead(504)
          res.end(JSON.stringify({ error: 'suggest_timeout' }))
          return
        }
        if (body.input === 'garbage') {
          res.writeHead(200)
          res.end(JSON.stringify({ oops: 1 }))
          return
        }
        res.writeHead(200)
        res.end(JSON.stringify({ from: 5, suggestions: [{ text: 'set', hint: '' }] }))
      })
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_CONSOLE_TOKEN: 'console-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: GENERATION,
  })
  // The direct mod link is gone: no BLOCKFIELD_CONSOLE_* env may remain.
  assert.deepEqual(
    Object.keys(process.env).filter((k) => k.startsWith('BLOCKFIELD_CONSOLE')),
    [],
  )
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const call = (as, path) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    return handleAdmin(
      {
        request: new Request(url, { method: 'GET' }),
        url,
        cookies: { get: () => undefined },
      },
      path.split('?')[0],
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  }
  // Only the raw-console permission reads the tail: moderators stay refused before any CP call.
  assert.equal((await call(`${MOD}:Moddy`, 'console/logs?since=0')).status, 403)
  assert.equal((await call(`${MOD}:Moddy`, 'console/suggest?input=time')).status, 403)
  assert.equal(seen.length, 0)
  const logs = await call(`${OWNER}:Nether`, 'console/logs?since=0')
  assert.equal(logs.status, 200)
  assert.deepEqual(await logs.json(), {
    entries: [
      { seq: 1, at: 1000, level: 'INFO', logger: 'net.Foo', message: 'hello' },
      { seq: 2, at: 2000, level: 'WARN', logger: 'net.Foo', message: 'careful' },
    ],
    next: 2,
  })
  const suggest = await call(`${OWNER}:Nether`, 'console/suggest?input=time%20s')
  assert.equal(suggest.status, 200)
  assert.deepEqual(await suggest.json(), { from: 5, suggestions: [{ text: 'set', hint: '' }] })
  assert.ok(
    seen.some((line) => line === `suggest input=time s generation=${GENERATION}`),
    'the suggest frame carries the game consumer generation',
  )
  // Site-side validation never reaches CP.
  assert.equal((await call(`${OWNER}:Nether`, 'console/logs?since=nope')).status, 400)
  assert.equal((await call(`${OWNER}:Nether`, 'console/suggest?input=a%0Ab')).status, 400)
  // CP error codes map through: 403 stays 403, unknown/malformed become 502.
  assert.equal((await call(`${OWNER}:Nether`, 'console/logs?since=7')).status, 403)
  assert.equal((await call(`${OWNER}:Nether`, 'console/logs?since=8')).status, 502)
  assert.equal((await call(`${OWNER}:Nether`, 'console/logs?since=9')).status, 502)
  assert.equal((await call(`${OWNER}:Nether`, 'console/suggest?input=forbidden-line')).status, 403)
  assert.equal((await call(`${OWNER}:Nether`, 'console/suggest?input=stale')).status, 503)
  assert.equal((await call(`${OWNER}:Nether`, 'console/suggest?input=busy')).status, 503)
  assert.equal((await call(`${OWNER}:Nether`, 'console/suggest?input=silent')).status, 504)
  assert.equal((await call(`${OWNER}:Nether`, 'console/suggest?input=garbage')).status, 502)
  assert.ok(
    seen.every(
      (line) => line.includes('auth=Bearer console-t') || line.startsWith('suggest input='),
    ),
    'the console token is the only CP secret',
  )
  // The Workshop game target is unconfigured here: 503 without touching CP.
  const before = seen.length
  assert.equal((await call(`${OWNER}:Nether`, 'console/logs?target=workshop&since=0')).status, 503)
  assert.equal(seen.length, before, 'unconfigured target: CP is never called')
  delete process.env.BLOCKFIELD_CP_CONSOLE_TOKEN
  assert.equal((await call(`${OWNER}:Nether`, 'console/logs?since=0')).status, 503)
  assert.equal(seen.length, before, 'no token: CP is never called')
  assert.equal((await s.auditLog()).length, 0, 'tail/suggest reads are not audited')
})

test('POST rcon moderation goes through typed CP actions when configured, 503 without CP', async (t) => {
  const http = await import('node:http')
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push([req.method, req.url, JSON.parse(body)])
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op-1', revision: null, status: 'accepted' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_MODERATION_TOKEN: 'mod-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  const s = await store(t)
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const call = async (as, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL('http://site/api/admin/rcon')
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'rcon', s).then(
      (r) => r,
      (e) => e,
    )
  }
  const said = await call(`${MOD}:Moddy`, { action: 'say', text: 'Рестарт через 5 минут' })
  assert.equal(said.status, 200)
  assert.deepEqual(await said.json(), { operationId: 'op-1' })
  assert.deepEqual(
    seen.map(([m, u, b]) => [m, u, b.text]),
    [['POST', '/v2/actions/moderation.say', 'Рестарт через 5 минут']],
  )
  // Malformed bodies stay refused before any CP call.
  assert.equal((await call(`${MOD}:Moddy`, { action: 'say', text: '/op x' })).status, 400)
  assert.equal(seen.length, 1)
  // Pardon needs the ban permission.
  assert.equal((await call(`${MOD}:Moddy`, { action: 'pardon', player: 'Bob' })).status, 403)
  const pardoned = await call(`${ADMIN}:Adm`, { action: 'pardon', player: 'Bob' })
  assert.equal(pardoned.status, 200)
  assert.deepEqual(seen[1][1], '/v2/actions/moderation.pardon')
  const log = await s.auditLog()
  assert.deepEqual(
    log.map((e) => [e.actorName, e.action, e.ok]),
    [
      ['Adm', 'rcon:pardon', 1],
      ['Moddy', 'rcon:pardon', 0],
      ['Moddy', 'rcon:say', 0],
      ['Moddy', 'rcon:say', 1],
    ],
  )
  assert.equal(JSON.parse(log[0].detail).operationId, 'op-1')
  // Without CP the game is unreachable: the route fails closed.
  delete process.env.BLOCKFIELD_CP_MODERATION_TOKEN
  assert.equal((await call(`${MOD}:Moddy`, { action: 'say', text: 'hi' })).status, 503)
})

test('POST rcon moderation reuses the client key and reports unknown outcomes as unconfirmed', async (t) => {
  const http = await import('node:http')
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  // dropNext makes the next request die mid-flight (applied or not: unknown).
  // badReceiptNext answers 2xx without an operation id (also unknown).
  const seen = []
  let dropNext = false,
    badReceiptNext = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (dropNext) {
        dropNext = false
        req.socket.destroy()
        return
      }
      seen.push(JSON.parse(body))
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(
        badReceiptNext
          ? ((badReceiptNext = false), JSON.stringify({ status: 'accepted' }))
          : JSON.stringify({ operationId: 'op-9', revision: null, status: 'accepted' }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_MODERATION_TOKEN: 'mod-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  const s = await store(t)
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  const call = async (body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${MOD}:Moddy`
    const url = new URL('http://site/api/admin/rcon')
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'rcon', s).then(
      (r) => r,
      (e) => e,
    )
  }
  const key = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const first = await call({ action: 'say', text: 'Тихо', idempotencyKey: key })
  assert.equal(first.status, 200)
  const retry = await call({ action: 'say', text: 'Тихо', idempotencyKey: key })
  assert.equal(retry.status, 200)
  assert.deepEqual(
    seen.map((b) => b.idempotencyKey),
    [key, key],
    'a retry resends the same key so CP dedupes instead of double-applying',
  )
  // An invalid key is rejected before any CP call.
  const bad = await call({ action: 'say', text: 'Тихо', idempotencyKey: 'not-a-uuid' })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /ключ/i)
  assert.equal(seen.length, 2)
  // A 2xx receipt without an operation id is unconfirmed, not failed.
  badReceiptNext = true
  const receiptless = await call({ action: 'say', text: 'Тихо', idempotencyKey: key })
  assert.equal(receiptless.status, 200)
  assert.deepEqual(await receiptless.json(), { operationId: null, unknownOutcome: true })
  // A dropped connection is unconfirmed too.
  dropNext = true
  const dropped = await call({ action: 'say', text: 'Тихо', idempotencyKey: key })
  assert.equal(dropped.status, 200)
  assert.deepEqual(await dropped.json(), { operationId: null, unknownOutcome: true })
  const log = await s.auditLog()
  const unconfirmed = log.filter((e) => JSON.parse(e.detail).unknownOutcome === true)
  assert.equal(unconfirmed.length, 2)
  for (const entry of unconfirmed) {
    assert.equal(entry.ok, 1, 'unconfirmed rows are not failures')
    assert.equal(JSON.parse(entry.detail).operationId, null)
  }
})

test('site#116 item 1: admin event stream role check requires the session (logout/password change closes it)', async (t) => {
  const { adminEventRole } = await import('../src/lib/admin.ts')
  const { database: db } = await import('./storage.mjs')
  const s = await db(t)
  const prevSecret = process.env.BLOCKFIELD_SESSION_SECRET
  const prevDev = process.env.BLOCKFIELD_ADMIN_DEV_USER
  process.env.BLOCKFIELD_SESSION_SECRET = '1'.repeat(64)
  delete process.env.BLOCKFIELD_ADMIN_DEV_USER
  t.after(() => {
    if (prevSecret === undefined) delete process.env.BLOCKFIELD_SESSION_SECRET
    else process.env.BLOCKFIELD_SESSION_SECRET = prevSecret
    if (prevDev === undefined) delete process.env.BLOCKFIELD_ADMIN_DEV_USER
    else process.env.BLOCKFIELD_ADMIN_DEV_USER = prevDev
  })
  const { sealTokenRaw } = await import('../src/lib/session-crypto.ts')
  const { sessionKeyBytes } = await import('../src/lib/session-crypto.ts')
  const key = sessionKeyBytes()
  const id = 'd'.repeat(32)
  const uuid = OTHER
  await s.insertSession(id, sealTokenRaw('drasl-token', key), uuid, Date.now())
  await s.setStaff(uuid, 'Oth', 'admin', 'seed')
  const actor = { uuid, name: 'Oth', role: 'admin' }
  const context = {
    cookies: { get: (name) => (name === 'bf_session' ? { value: id } : undefined) },
    request: new Request('http://site/api/admin/events'),
  }
  assert.equal(await adminEventRole(context, actor, s), 'admin')
  await s.deleteSession(id)
  await assert.rejects(
    () => adminEventRole(context, actor, s),
    (e) => e instanceof Response && e.status === 401,
    'logout closes the stream on next ping',
  )
  const id2 = 'e'.repeat(32)
  await s.insertSession(id2, sealTokenRaw('drasl-token', key), uuid, Date.now())
  const context2 = {
    cookies: { get: (name) => (name === 'bf_session' ? { value: id2 } : undefined) },
    request: new Request('http://site/api/admin/events'),
  }
  assert.equal(await adminEventRole(context2, actor, s), 'admin')
  await s.deleteUserSessions(uuid)
  await assert.rejects(
    () => adminEventRole(context2, actor, s),
    (e) => e instanceof Response && e.status === 401,
    'password change closes the stream on next ping',
  )
})

test('site#116 item 5: header identity reads CP, not the replica (revoked admin has no link)', async (t) => {
  const http = (await import('node:http')).default
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://cp')
    if (req.method === 'GET' && url.pathname === '/v2/staff/grants') {
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 404
      return res.end(JSON.stringify({ error: 'account_not_found' }))
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not_found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_STAFF_TOKEN: 'staff-t',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_SESSION_SECRET: '1'.repeat(64),
    BLOCKFIELD_ADMIN_DEV_USER: '',
    DRASL_URL: 'http://drasl.test',
  })
  delete process.env.BLOCKFIELD_ADMIN_DEV_USER
  const { siteIdentity: identity } = await import('../src/lib/admin.ts')
  const { statsStore: singleton } = await import('../src/lib/stats.ts')
  const s = await singleton()
  const { sealTokenRaw, sessionKeyBytes } = await import('../src/lib/session-crypto.ts')
  const key = sessionKeyBytes()
  const id = 'f'.repeat(32)
  const realFetch = globalThis.fetch
  const user = { username: 'Oth', players: [{ uuid: OTHER, name: 'Oth' }] }
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://drasl.test')) return Response.json(user)
    return realFetch(url, init)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })
  await s.insertSession(id, sealTokenRaw('drasl-token', key), OTHER, Date.now())
  await s.setStaff(OTHER, 'Oth', 'admin', 'seed')
  const cookies = { get: (name) => (name === 'bf_session' ? { value: id } : undefined) }
  const me = await identity(cookies)
  assert.deepEqual(me, { name: 'Oth', hasAdminAccess: false }, 'CP revoke hides the header link')
  await s.deleteSession(id)
})
