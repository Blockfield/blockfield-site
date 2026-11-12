import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
  rconCommand,
  roleOf,
  saveSettings,
  siteIdentity,
  validateSettings,
  workshopMembers,
  writeRequest,
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
  const dirs = { BLOCKFIELD_INBOX_DIR: temp(t) }
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
  Object.assign(process.env, dirs, {
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
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
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
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'workshop.key'), `${KEY}\n`)
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
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
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
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${ADMIN}:Adm`
  const url = new URL('http://site/api/admin/keys')
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: 'e10438e4-797b-4971-8cfe-cec6a8fa171b', label: 'x' }),
  })
  const response = await handleAdmin(
    { request, url, cookies: { get: () => undefined } },
    'keys',
    noCommit,
  ).then(
    (r) => r,
    (e) => e,
  )
  assert.ok(response.status >= 500)
  assert.equal(
    seen.filter((e) => e.entry.action === 'ingest-key-create' && e.entry.ok).length,
    0,
    'rolled-back writes never show as ok',
  )
})

test('tx failure is not applied: a rolled-back keys/create errors and shows no key', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const flaky = new Proxy(s, {
    get: (target, prop) =>
      prop === 'auditFinalize'
        ? async () => {
            throw new StatsError(503, 'audit store is down')
          }
        : Reflect.get(target, prop),
  })
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${ADMIN}:Adm`
  const url = new URL('http://site/api/admin/keys')
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: 'e10438e4-797b-4971-8cfe-cec6a8fa171b', label: 'producer' }),
  })
  const response = await handleAdmin(
    { request, url, cookies: { get: () => undefined } },
    'keys',
    flaky,
  ).then(
    (r) => r,
    (e) => e,
  )
  assert.ok(response.status >= 500, `a rolled-back write must error, got ${response.status}`)
  assert.equal((await s.ingestKeys()).length, 0, 'the key insert rolled back with the finalize')
})

test('audit leads the effect: a dead log fails everything closed before anything runs', async (t) => {
  const dirs = { BLOCKFIELD_INBOX_DIR: temp(t) }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
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
  assert.equal(readdirSync(dirs.BLOCKFIELD_INBOX_DIR).length, 0, 'no side effect ran')
})

test('finalize failure: low-risk warns on 200, high-risk fails closed', async (t) => {
  const dirs = { BLOCKFIELD_INBOX_DIR: temp(t) }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const http = await import('node:http')
  const cp = http.createServer((req, res) => {
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
  assert.equal(
    readdirSync(dirs.BLOCKFIELD_INBOX_DIR).length,
    1,
    'only the inbox effect wrote a file',
  )
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

test('inbox request is validated and written atomically as <id>.json', (t) => {
  const dir = temp(t),
    lead = { uuid: MOD, name: 'Mod', role: 'moderator' },
    admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }
  const id = writeRequest(dir, lead, {
    kind: 'mode',
    profile: 'workshop',
    expectedRevision: 3,
    session: 'new',
    maps: null,
  })
  assert.deepEqual(readdirSync(dir), [`${id}.json`], 'no temp file is left behind')
  const request = JSON.parse(readFileSync(join(dir, `${id}.json`)))
  assert.deepEqual(
    { ...request, createdAt: 0 },
    {
      schema: 1,
      id,
      kind: 'mode',
      actor: { draslId: MOD, name: 'Mod' },
      createdAt: 0,
      profile: 'workshop',
      expectedRevision: 3,
      session: 'new',
      maps: null,
    },
  )
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
      () => writeRequest(dir, actor, body),
      (e) => status(e) === code,
      JSON.stringify(body),
    )
  writeRequest(dir, admin, { kind: 'mode', profile: 'game', expectedRevision: 0, recover: true })
  assert.equal(readdirSync(dir).length, 2)
  // maps: [] is a valid, distinct value (no maps, not "every map"), and must survive the request as written.
  const mapsId = writeRequest(dir, admin, {
    kind: 'members',
    members: [{ draslId: OTHER, name: 'Bob', role: 'builder', maps: [] }],
  })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${mapsId}.json`))).members, [
    { draslId: OTHER, name: 'Bob', role: 'builder', maps: [] },
  ])
})

test('mode request: workshop needs a session; "new" validates maps against MAP_IDS (hub included), "resume" never carries maps', (t) => {
  const dir = temp(t),
    admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }
  const allId = writeRequest(dir, admin, {
    kind: 'mode',
    profile: 'workshop',
    expectedRevision: 1,
    session: 'new',
    maps: null,
  })
  assert.equal(JSON.parse(readFileSync(join(dir, `${allId}.json`))).maps, null)
  const someId = writeRequest(dir, admin, {
    kind: 'mode',
    profile: 'workshop',
    expectedRevision: 1,
    session: 'new',
    maps: ['fields', 'hub'],
  })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${someId}.json`))).maps, ['fields', 'hub'])
  const resumeId = writeRequest(dir, admin, {
    kind: 'mode',
    profile: 'workshop',
    expectedRevision: 1,
    session: 'resume',
    maps: ['fields'],
  })
  assert.equal(
    'maps' in JSON.parse(readFileSync(join(dir, `${resumeId}.json`))),
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
      () => writeRequest(dir, admin, body),
      (e) => status(e) === 400,
      JSON.stringify(body),
    )
})

test('mode request: test profile needs a known candidate id', (t) => {
  const dir = temp(t),
    admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }
  const id = writeRequest(dir, admin, {
    kind: 'mode',
    profile: 'test',
    expectedRevision: 2,
    candidateId: 'a'.repeat(32),
  })
  assert.equal(JSON.parse(readFileSync(join(dir, `${id}.json`))).candidateId, 'a'.repeat(32))
  for (const body of [
    { kind: 'mode', profile: 'test', expectedRevision: 2 },
    { kind: 'mode', profile: 'test', expectedRevision: 2, candidateId: 'nope' },
  ])
    assert.throws(
      () => writeRequest(dir, admin, body),
      (e) => status(e) === 400,
      JSON.stringify(body),
    )
})

test('publish request: optional force must be boolean, only written when true', (t) => {
  const dir = temp(t),
    admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }
  const plain = writeRequest(dir, admin, { kind: 'publish', candidateId: 'a'.repeat(32) })
  assert.equal('force' in JSON.parse(readFileSync(join(dir, `${plain}.json`))), false)
  const forced = writeRequest(dir, admin, {
    kind: 'publish',
    candidateId: 'a'.repeat(32),
    force: true,
  })
  assert.equal(JSON.parse(readFileSync(join(dir, `${forced}.json`))).force, true)
  const declined = writeRequest(dir, admin, {
    kind: 'publish',
    candidateId: 'a'.repeat(32),
    force: false,
  })
  assert.equal('force' in JSON.parse(readFileSync(join(dir, `${declined}.json`))), false)
  assert.throws(
    () => writeRequest(dir, admin, { kind: 'publish', candidateId: 'a'.repeat(32), force: 'yes' }),
    (e) => status(e) === 400,
  )
})

test('settings validation and optimistic revision conflict', (t) => {
  const dir = temp(t)
  const first = saveSettings(
    dir,
    {
      expectedRevision: 0,
      lobby: { pvpEnabled: true, pvpCooldownSeconds: 30 },
      classLocks: ['sniper'],
      campaignBalance: { '*': { max_tickets: 300, enable_spawn_shield: false } },
    },
    'Adm',
  )
  assert.equal(first.revision, 1)
  assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'))).updatedBy, 'Adm')
  assert.throws(
    () => saveSettings(dir, { expectedRevision: 0, rooms: { maxRooms: 2 } }, 'Other'),
    (e) => status(e) === 409,
  )
  assert.equal(
    saveSettings(dir, { expectedRevision: 1, rooms: { maxRooms: 2 } }, 'Adm').revision,
    2,
  )
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

test('parcool settings round-trip through saveSettings like the other sections', (t) => {
  const dir = temp(t)
  const saved = saveSettings(
    dir,
    { expectedRevision: 0, parcool: { allowedActions: ['FastRun', 'ClingToCliff'] } },
    'Adm',
  )
  assert.deepEqual(saved.parcool, { allowedActions: ['FastRun', 'ClingToCliff'] })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'))).parcool, {
    allowedActions: ['FastRun', 'ClingToCliff'],
  })
  // A later save that omits `parcool` drops the section entirely (every save replaces the whole file), returning control to the base file.
  const cleared = saveSettings(dir, { expectedRevision: 1, rooms: { maxRooms: 3 } }, 'Adm')
  assert.equal(cleared.parcool, undefined)
})

test('RCON allowlist builds exact commands and rejects injection', () => {
  const room = '0f8e0c3a-1b2c-4d5e-8f90-123456789abc'
  assert.deepEqual(
    rconCommand({ action: 'kick', player: 'Bob_1', reason: 'spam\nstop' }).commands,
    ['kick Bob_1 spam stop'],
  )
  assert.deepEqual(rconCommand({ action: 'say', text: 'Рестарт через §c5 минут' }).commands, [
    'say Рестарт через c5 минут',
  ])
  assert.deepEqual(
    rconCommand({ action: 'stop-room', roomId: room, outcome: 'RED', reason: 'тест' }).commands,
    [`bf stop room ${room} win RedTeam тест`],
  )
  assert.deepEqual(rconCommand({ action: 'stop-room', roomId: room, outcome: 'draw' }).commands, [
    `bf stop room ${room} draw`,
  ])
  assert.deepEqual(
    rconCommand({ action: 'stop-room', roomId: room, outcome: 'none', reason: 'window' }).commands,
    [`bf stop room ${room} window`],
  )
  assert.deepEqual(rconCommand({ action: 'interrupt', reason: 'авария' }).commands, [
    'bf maintenance interrupt',
    'bf maintenance interrupt confirm авария',
  ])
  assert.deepEqual(rconCommand({ action: 'resume' }).commands, ['bf maintenance resume'])
  assert.deepEqual(rconCommand({ action: 'class-unlock', classId: 'sniper' }).commands, [
    'bf class unlock sniper',
  ])
  assert.equal(rconCommand({ action: 'ban', player: 'Bob' }).permission, 'ban')
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
      () => rconCommand(body),
      (e) => status(e) === 400,
      JSON.stringify(body),
    )
})

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
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  delete process.env.BLOCKFIELD_RCON_HOST
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

  mkdirSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'results'))
  // Owner names resolve through Drasl; stub it so the members request can be built offline.
  // The same stub answers the typed Workshop calls (cancel goes through CP here).
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async (url) =>
    String(url).includes('/v2/workshop/')
      ? Response.json(
          { operationId: 'op-cancel', revision: null, status: 'accepted' },
          { status: 202 },
        )
      : String(url).includes(`/session/minecraft/profile/${OWNER}`)
        ? Response.json({ id: OWNER, name: 'Nether' })
        : String(url).endsWith('/Moddy')
          ? Response.json({ id: MOD, name: 'Moddy' })
          : new Response('', { status: 404 })

  assert.equal(
    (await call(`${ADMIN}:Adm`, 'POST', 'staff', { name: 'Moddy', role: 'admin' })).status,
    403,
  )
  const granted = await call(`${ADMIN}:Adm`, 'POST', 'staff', { name: 'Moddy', role: 'moderator' })
  assert.equal(granted.status, 200)
  const { sync } = await granted.json()
  const request = JSON.parse(readFileSync(join(dirs.BLOCKFIELD_INBOX_DIR, `${sync.id}.json`)))
  assert.deepEqual(request.members, [
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

  // cancel switches the server like mode does: admin-only. The command goes
  // through CP (operationId receipt); the member list still goes to the inbox.
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
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, {
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

test('review: range goes through /bf, Brigadier rejections are detected', () => {
  assert.deepEqual(rconCommand({ action: 'range', op: 'close' }).commands, ['bf range close'])
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

test('review: non-staff are refused before the body is read and never audited; RCON errors hide addresses', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_RCON_HOST: '127.0.0.1',
    BLOCKFIELD_RCON_PORT: '1',
    BLOCKFIELD_RCON_PASSWORD: 'x',
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
  assert.equal(failed.status, 502)
  const text = (await failed.json()).error
  assert.equal(text, 'Игровой сервер не отвечает.')
  assert.ok(!text.includes('127.0.0.1'))
  assert.match((await s.auditLog())[0].error, /ECONNREFUSED/)
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
    BLOCKFIELD_ADMIN_DIR: temp(t),
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
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, {
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
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`,
  })
  const s = await store(t)
  const accepted = { id: 'a'.repeat(32), status: 'accepted', sha256: '1'.repeat(64) },
    pending = { id: 'b'.repeat(32), status: 'pending', sha256: '2'.repeat(64) }
  writeFileSync(
    join(dirs.BLOCKFIELD_ADMIN_DIR, 'candidates.json'),
    JSON.stringify({ schema: 1, candidates: [accepted, pending] }),
  )
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
  mkdirSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'packages'))
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'packages', `${accepted.sha256}.zip`), 'zip-bytes')
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'packages', `${pending.sha256}.zip`), 'zip-bytes')
  const ok = await call(accepted.id)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('x-checksum-sha256'), accepted.sha256)
  assert.equal(await ok.text(), 'zip-bytes')
  assert.equal((await call(pending.id)).status, 404, 'a pending candidate is not downloadable')
  assert.equal((await call('../etc')).status, 400)
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
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`,
  })
  const s = await store(t)
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  await s.setStaff(MOD, 'Moddy', 'builder', 'seed')
  await s.setStaffMaps(MOD, ['konstaxa'])
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async () => new Response('', { status: 404 })
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
  assert.equal(
    readdirSync(dirs.BLOCKFIELD_INBOX_DIR).filter((f) => f.endsWith('.json')).length,
    1,
    'one members request for the whole change',
  )
})

test("POST /api/workshop/access: key, then the in-game actor's own site role; hub is a scope; audited", async (t) => {
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
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
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, {
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

test('POST /api/workshop/submit: a builder only for maps they build on; writes a candidate request; journaled', async (t) => {
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed')
  await s.setStaffMaps(OTHER, ['fields'])
  const KEY = 'k'.repeat(40)
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'workshop.key'), KEY)
  const workingCopyId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const writeMaps = (merged) =>
    writeFileSync(
      join(dirs.BLOCKFIELD_ADMIN_DIR, 'maps.json'),
      JSON.stringify({
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
      }),
    )
  writeMaps(false)
  writeFileSync(
    join(dirs.BLOCKFIELD_ADMIN_DIR, 'session.json'),
    JSON.stringify({
      schema: 1,
      id: workingCopyId,
      maps: ['fields', 'konstaxa'],
      branches: { fields: 'layout-work', konstaxa: 'layout-work' },
    }),
  )
  writeFileSync(
    join(dirs.BLOCKFIELD_ADMIN_DIR, 'status.json'),
    JSON.stringify({
      schema: 1,
      phase: 'workshop',
      gate: 'builders',
      desired: { profile: 'workshop', session: workingCopyId },
    }),
  )
  const call = (body) =>
    handleWorkshopSubmit(
      new Request('http://site/api/workshop/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      }),
      {},
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
  writeMaps(true)
  const ok = await call({ actor: OTHER, actorName: 'Bob', mapId: 'fields', workingCopyId })
  assert.equal(ok.status, 200)
  const files = readdirSync(dirs.BLOCKFIELD_INBOX_DIR).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 1)
  const request = JSON.parse(readFileSync(join(dirs.BLOCKFIELD_INBOX_DIR, files[0]), 'utf8'))
  assert.deepEqual(
    [request.kind, request.mapId, request.actor.name],
    ['candidate', 'fields', 'Bob'],
  )
  assert.equal(request.workingCopyId, workingCopyId)
  assert.equal(request.expectedHead, 'a'.repeat(64))
  assert.equal(request.commit, true)
  assert.equal(request.note, 'С планшета: Bob')
  const { id } = await ok.json()
  const poll = (receipt = id, key = KEY) =>
    handleWorkshopSubmit(
      new Request(`http://site/api/workshop/submit?id=${receipt}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
      {},
      s,
    ).catch((error) => error)
  assert.deepEqual(await (await poll()).json(), { result: null })
  assert.equal((await poll(id, 'wrong-key')).status, 401)
  assert.equal((await poll('../bad')).status, 400)
  mkdirSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'results'))
  const result = { id, ok: false, error: 'no changes on the branch', doneAt: Date.now() }
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'results', `${id}.json`), JSON.stringify(result))
  assert.deepEqual(await (await poll()).json(), { result }, 'controller refusal reaches the tablet')
  result.ok = true
  result.error = null
  result.payload = { mapId: 'fields' }
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'results', `${id}.json`), JSON.stringify(result))
  assert.deepEqual(await (await poll()).json(), { result })
  writeFileSync(
    join(dirs.BLOCKFIELD_ADMIN_DIR, 'results', `${id}.json`),
    JSON.stringify({ ...result, schema: 2 }),
  )
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
  const combinedRequest = JSON.parse(
    readFileSync(join(dirs.BLOCKFIELD_INBOX_DIR, `${combinedId}.json`), 'utf8'),
  )
  assert.equal(combinedRequest.kind, 'candidate')
  assert.equal(combinedRequest.commit, true)
  assert.equal(combinedRequest.note, 'Layout update')
  assert.equal(combinedRequest.workingCopyId, workingCopyId)
  assert.equal(combinedRequest.expectedHead, 'a'.repeat(64))
  assert.equal(readdirSync(dirs.BLOCKFIELD_INBOX_DIR).length, 3, 'one request per submission')
  assert.ok(
    (await s.auditLog(5)).some(
      (e) => e.action === 'workshop-candidate' && e.ok && e.target === 'fields',
    ),
  )
})

test('writeRequest: candidate/rollback take a real map, publish/reject a candidate id', (t) => {
  const dir = temp(t),
    actor = { uuid: OWNER, name: 'Nether', role: 'owner' }
  assert.ok(writeRequest(dir, actor, { kind: 'candidate', mapId: 'konstaxa' }))
  const combined = {
    kind: 'candidate',
    mapId: 'konstaxa',
    workingCopyId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    expectedHead: 'a'.repeat(64),
    commit: true,
    note: 'Update',
  }
  assert.ok(writeRequest(dir, actor, combined))
  for (const overrides of [
    { note: '' },
    { note: 'a'.repeat(201) },
    { note: 'line\nbreak' },
    { workingCopyId: undefined },
    { expectedHead: undefined },
    { commit: 'true' },
  ])
    assert.throws(() => writeRequest(dir, actor, { ...combined, ...overrides }))
  assert.ok(writeRequest(dir, actor, { kind: 'publish', candidateId: 'a'.repeat(32) }))
  assert.throws(() => writeRequest(dir, actor, { kind: 'rollback', mapId: 'hub' }))
  assert.throws(() => writeRequest(dir, actor, { kind: 'reject', candidateId: '../x' }))
})

test('review: stop-room without RCON configured fails fast, before querying rooms', async (t) => {
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
  delete process.env.BLOCKFIELD_RCON_HOST
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

test('class prices round-trip through settings with strict numeric limits', (t) => {
  const dir = temp(t)
  const prices = { tech: 0, sniper: 150, drone: 10000 }
  const saved = saveSettings(dir, { expectedRevision: 0, classCosts: prices }, 'Adm')
  assert.deepEqual(saved.classCosts, prices)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'))).classCosts, prices)
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

test('raw console: owner only, one validated line, every call audited including refusals', async (t) => {
  const net = await import('node:net')
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  // Minimal vanilla-like RCON: auth reply, command echo, "Unknown request" for the end-of-output sentinel.
  const seen = []
  const frame = (id, type, body) => {
    const text = Buffer.from(body),
      out = Buffer.alloc(14 + text.length)
    out.writeInt32LE(10 + text.length, 0)
    out.writeInt32LE(id, 4)
    out.writeInt32LE(type, 8)
    text.copy(out, 12)
    return out
  }
  const server = net.createServer((socket) =>
    socket.on('data', (chunk) => {
      const id = chunk.readInt32LE(4),
        type = chunk.readInt32LE(8),
        body = chunk.subarray(12, chunk.readInt32LE(0) + 2).toString()
      if (type === 3) socket.write(frame(id, 2, ''))
      else if (type === 2) {
        seen.push(body)
        socket.write(
          frame(
            id,
            0,
            body === 'bogus'
              ? 'Unknown or incomplete command'
              : body.includes('example-short-password')
                ? '{"client_secret":"response-short-secret","password":"reply-short-password"}'
                : '§aDone',
          ),
        )
      } else socket.write(frame(id, 0, 'Unknown request'))
    }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_RCON_HOST: '127.0.0.1',
    BLOCKFIELD_RCON_PORT: String(server.address().port),
    BLOCKFIELD_RCON_PASSWORD: 'x',
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
  assert.deepEqual(seen, ['time set day', 'bogus'], 'refused and invalid commands never reach RCON')

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

test('raw console target selector: routes to game or workshop, enforces config and rejects unknown enums', async (t) => {
  const net = await import('node:net')
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  const frame = (id, type, body) => {
    const text = Buffer.from(body),
      out = Buffer.alloc(14 + text.length)
    out.writeInt32LE(10 + text.length, 0)
    out.writeInt32LE(id, 4)
    out.writeInt32LE(type, 8)
    text.copy(out, 12)
    return out
  }

  const makeServer = (expectedPassword, replyPrefix) => {
    const seen = []
    const server = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.on('data', (chunk) => {
        const id = chunk.readInt32LE(4),
          type = chunk.readInt32LE(8),
          body = chunk.subarray(12, chunk.readInt32LE(0) + 2).toString()
        if (type === 3) socket.write(frame(body === expectedPassword ? id : -1, 2, ''))
        else if (type === 2) {
          seen.push(body)
          socket.write(frame(id, 0, `${replyPrefix}:${body}`))
        } else socket.write(frame(id, 0, 'Unknown request'))
      })
    })
    return { server, seen }
  }

  const game = makeServer('game-pass', 'game')
  const workshop = makeServer('workshop-pass', 'workshop')
  await new Promise((resolve) => game.server.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => workshop.server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    game.server.close()
    workshop.server.close()
  })

  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_RCON_HOST: '127.0.0.1',
    BLOCKFIELD_RCON_PORT: String(game.server.address().port),
    BLOCKFIELD_RCON_PASSWORD: 'game-pass',
    BLOCKFIELD_WORKSHOP_RCON_HOST: '127.0.0.1',
    BLOCKFIELD_WORKSHOP_RCON_PORT: String(workshop.server.address().port),
    BLOCKFIELD_WORKSHOP_RCON_PASSWORD: 'workshop-pass',
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
    output: 'workshop:say hello workshop',
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

  // 5. Unconfigured Workshop RCON returns 503 and NEVER falls back to Game
  delete process.env.BLOCKFIELD_WORKSHOP_RCON_HOST
  const unconfiguredWs = await call(`${OWNER}:Nether`, { command: 'test', target: 'workshop' })
  assert.equal(unconfiguredWs.status, 503)
  assert.equal((await unconfiguredWs.json()).error, 'RCON для Workshop не настроен на сайте.')
  assert.deepEqual(
    game.seen,
    ['say hello game', 'default command'],
    'no fallback from Workshop to Game',
  )

  // 6. Unconfigured Game RCON returns 503
  delete process.env.BLOCKFIELD_RCON_HOST
  const unconfiguredGame = await call(`${OWNER}:Nether`, { command: 'test', target: 'game' })
  assert.equal(unconfiguredGame.status, 503)
  assert.equal((await unconfiguredGame.json()).error, 'RCON не настроен на сайте.')

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
  assert.equal(JSON.parse(wsAudit.detail).output, 'workshop:say hello workshop')
})

test('diagnostics are admin-only and never report health without data', async (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' })
  delete process.env.BLOCKFIELD_RCON_HOST
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
  const empty = await (await call(`${ADMIN}:Adm`, 'diagnostics')).json()
  assert.equal(empty.lastSampleAt, null)
  assert.deepEqual([empty.samples, empty.events], [[], []])
  assert.equal((await call(`${ADMIN}:Adm`, 'diagnostics/live')).status, 503)
})

test('console link: logs and suggestions proxy the mod endpoint with the console-read token, reads stay unaudited', async (t) => {
  const { createServer } = await import('node:http')
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const seen = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} auth=${req.headers.authorization}`)
    if (req.headers.authorization !== 'Bearer read-token') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"Unauthorized."}')
      return
    }
    const url = new URL(req.url, 'http://game')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.pathname.endsWith('/logs'))
      res.end(
        JSON.stringify({
          next: 2,
          entries: [
            { seq: 1, at: 1000, level: 'INFO', logger: 'net.Foo', message: 'hello' },
            { seq: 2, at: 2000, level: 'WARN', logger: 'net.Foo', message: 'careful' },
          ],
        }),
      )
    else
      res.end(
        JSON.stringify({
          from: 5,
          suggestions: [{ text: 'set', hint: '' }],
        }),
      )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  Object.assign(process.env, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_RCON_HOST: '127.0.0.1',
    BLOCKFIELD_RCON_PORT: '1',
    BLOCKFIELD_RCON_PASSWORD: 'x',
    BLOCKFIELD_CONSOLE_PORT: String(server.address().port),
    BLOCKFIELD_CONSOLE_READ_TOKEN: 'read-token',
  })
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
  // Moderators keep their old console: only the raw-console permission may read the link.
  assert.equal((await call(`${MOD}:Moddy`, 'console/logs?since=0')).status, 403)
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
  assert.equal((await call(`${OWNER}:Nether`, 'console/logs?since=nope')).status, 400)
  assert.ok(
    seen.length > 0 && seen.every((line) => line.includes('auth=Bearer read-token')),
    'the console-read token is the only link secret, never the RCON password',
  )
  delete process.env.BLOCKFIELD_CONSOLE_READ_TOKEN
  const before = seen.length
  assert.equal((await call(`${OWNER}:Nether`, 'console/logs?since=0')).status, 503)
  assert.equal(seen.length, before, 'no token: the link is never called')
  assert.equal((await s.auditLog()).length, 0, 'link reads are not audited')
})

test('POST rcon moderation goes through typed CP actions when configured, 503 without CP (no RCON fallback)', async (t) => {
  const http = await import('node:http')
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
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
  Object.assign(process.env, dirs, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_MODERATION_TOKEN: 'mod-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  delete process.env.BLOCKFIELD_RCON_HOST
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
  // Same bodies RCON refused stay refused before any CP call.
  assert.equal((await call(`${MOD}:Moddy`, { action: 'say', text: '/op x' })).status, 400)
  assert.equal(seen.length, 1)
  // Pardon needs the ban permission, like its RCON path.
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
  // Without CP there is no RCON fallback: even with RCON configured the CP
  // kinds fail closed (before the cutover this fell through to RCON).
  Object.assign(process.env, {
    BLOCKFIELD_RCON_HOST: '127.0.0.1',
    BLOCKFIELD_RCON_PORT: '1',
    BLOCKFIELD_RCON_PASSWORD: 'x',
  })
  delete process.env.BLOCKFIELD_CP_MODERATION_TOKEN
  assert.equal((await call(`${MOD}:Moddy`, { action: 'say', text: 'hi' })).status, 503)
})

test('POST rcon moderation reuses the client key and reports unknown outcomes as unconfirmed', async (t) => {
  const http = await import('node:http')
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
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
  Object.assign(process.env, dirs, {
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    NODE_ENV: 'test',
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_MODERATION_TOKEN: 'mod-t',
    BLOCKFIELD_CP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  delete process.env.BLOCKFIELD_RCON_HOST
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
