import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpStaffConfigured, readMeCp, roleFromCpMe, postStaffGrantCp } from '../src/lib/cp.ts'
import { handleAdmin } from '../src/lib/admin.ts'
import { exportStaff } from '../scripts/cp-staff-export.mjs'
import { database as store } from './storage.mjs'

const OWNER = 'e10438e4797b49718cfecec6a8fa171b'
const ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MOD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OTHER = 'cccccccccccccccccccccccccccccccc'
const dashed = (id) =>
  `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`

async function fakeCp(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return server
}

function cpEnv(t, server) {
  const inbox = mkdtempSync(join(tmpdir(), 'bf-cpstaff-'))
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_STAFF_TOKEN: 'staff-t',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    BLOCKFIELD_ADMIN_DEV_USER: `${ADMIN}:Adm`,
    BLOCKFIELD_INBOX_DIR: inbox,
    BLOCKFIELD_SESSION_SECRET: 'a'.repeat(64),
    NODE_ENV: 'test',
  })
  t.after(() => rmSync(inbox, { recursive: true, force: true }))
}

test('staff switch: needs both the CP url and the staff token', () => {
  delete process.env.BLOCKFIELD_CP_STAFF_TOKEN
  delete process.env.BLOCKFIELD_CP_URL
  assert.equal(cpStaffConfigured(), false)
  assert.equal(cpStaffConfigured({ BLOCKFIELD_CP_URL: 'http://127.0.0.1:9' }), false)
  assert.equal(
    cpStaffConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_STAFF_TOKEN: 't',
    }),
    true,
  )
  assert.equal(
    cpStaffConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_STAFF_TOKEN: '   ',
    }),
    false,
  )
})

test('role from CP me: owner bit wins, then the highest in-scope grant', () => {
  const grants = (roles) =>
    roles.map(([role, resource]) => ({
      role,
      environment: 'prod',
      backend: 'game',
      resource,
      revision: 2,
      expires_at: null,
    }))
  assert.equal(roleFromCpMe({ accountId: 'x', owner: true, grants: [] }), 'owner')
  assert.equal(
    roleFromCpMe({
      accountId: 'x',
      owner: false,
      grants: grants([
        ['builder', '*'],
        ['moderator', '*'],
      ]),
    }),
    'moderator',
  )
  assert.equal(
    roleFromCpMe(
      { accountId: 'x', owner: false, grants: grants([['builder', 'room-1']]) },
      { environment: 'prod', backend: 'game', resource: 'room-1' },
    ),
    'builder',
  )
  assert.equal(
    roleFromCpMe({ accountId: 'x', owner: false, grants: grants([['builder', 'room-1']]) }),
    null,
    'a resource-scoped grant is not a site-wide role',
  )
  assert.equal(
    roleFromCpMe({ accountId: 'x', owner: false, grants: grants([['admin', 'other-backend']]) }),
    null,
    'a grant for another backend is not authority here',
  )
  assert.equal(roleFromCpMe({ accountId: 'x', owner: false, grants: [] }), null)
})

test('v2 me read: shape validated, CP denial keeps its code', async (t) => {
  const server = await fakeCp(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer staff-t') {
      res.statusCode = 403
      return res.end(JSON.stringify({ error: 'forbidden' }))
    }
    res.end(
      JSON.stringify({
        accountId: dashed(ADMIN),
        client: { id: 'site', via: 'ui' },
        owner: false,
        grants: [
          {
            role: 'admin',
            environment: 'prod',
            backend: 'game',
            resource: '*',
            revision: 2,
            expires_at: null,
          },
        ],
        ceiling: [],
      }),
    )
  })
  cpEnv(t, server)
  const me = await readMeCp()
  assert.equal(me.owner, false)
  assert.equal(roleFromCpMe(me), 'admin')
  await assert.rejects(readMeCp('wrong-t'), (e) => e.code === 'forbidden' && e.status === 403)
})

test('staff grant denial matrix: every CP refusal maps to a site status', async (t) => {
  let code = 'self_role_edit'
  let status = 403
  const server = await fakeCp(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = status
    res.end(JSON.stringify({ error: code }))
  })
  cpEnv(t, server)
  const cases = [
    ['self_role_edit', 403],
    ['peer_role_edit', 403],
    ['protected_owner', 403],
    ['ineligible_account', 403],
    ['account_not_found', 404],
    ['revision_conflict', 409],
    ['idempotency_conflict', 409],
  ]
  for (const [nextCode, nextStatus] of cases) {
    code = nextCode
    status = nextStatus
    await assert.rejects(
      postStaffGrantCp({ accountUuid: OTHER, role: 'moderator', expectedRevision: 1 }),
      (e) => e.code === nextCode && e.status === nextStatus,
      nextCode,
    )
  }
})

test('staff grant posts the v2 GrantChange shape and fences the local write', async (t) => {
  const seen = []
  const server = await fakeCp(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      seen.push([req.method, req.url, req.headers.authorization, body ? JSON.parse(body) : null])
      res.statusCode = 202
      res.end(
        JSON.stringify({
          operationId: '11111111-1111-4111-8111-111111111111',
          revision: 2,
          status: 'accepted',
          result: { authorizationEpoch: 2 },
        }),
      )
    })
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  const cpBase = `http://127.0.0.1:${server.address().port}`
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async (url, init) =>
    String(url).startsWith(cpBase)
      ? realFetch(url, init)
      : String(url).endsWith(`/session/minecraft/profile/${OWNER}`)
        ? Response.json({ id: OWNER, name: 'Nether' })
        : new Response('', { status: 404 })
  const call = async (as, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'staff', s).then(
      (r) => r,
      (e) => e,
    )
  }
  const granted = await call(`${ADMIN}:Adm`, 'staff', {
    uuid: OTHER,
    role: 'moderator',
    expectedRevision: 1,
  })
  assert.equal(granted.status, 200)
  const payload = await granted.json()
  assert.match(payload.operationId, /.+/)
  assert.equal(seen.length, 1)
  const [method, url, auth, body] = seen[0]
  assert.equal(method, 'POST')
  assert.equal(url, '/v2/staff/grants')
  assert.equal(auth, 'Bearer staff-t')
  assert.deepEqual(body, {
    idempotencyKey: body.idempotencyKey,
    environment: 'prod',
    backend: 'game',
    accountId: dashed(OTHER),
    expectedRevision: 1,
    role: 'moderator',
    resource: '*',
    revoke: false,
  })
  assert.match(body.idempotencyKey, /.+/)
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'moderator',
    'the receipt mirrors into the replica, so roleOf and the next from stay correct',
  )
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: 'admin', expectedRevision: 1 }))
      .status,
    403,
    'an admin grant stays owner-only before any CP call',
  )
  assert.equal(seen.length, 1, 'the refused admin grant never reached CP')
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'staff', { uuid: ADMIN, role: null, expectedRevision: 2 })).status,
    403,
    'no self edit, even with a revision',
  )
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: 'moderator' })).status,
    200,
    'no revision sent: the receipt converged the cache to epoch 2',
  )
  assert.equal(seen[1][3].expectedRevision, 2)
})

test('epoch cache: receipts converge the list, stale 409s', async (t) => {
  const server = await fakeCp(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      res.setHeader('Content-Type', 'application/json')
      if (payload.expectedRevision === 999) {
        res.statusCode = 409
        return res.end(JSON.stringify({ error: 'revision_conflict' }))
      }
      res.statusCode = 202
      res.end(
        JSON.stringify({
          operationId: '22222222-2222-4222-8222-222222222222',
          revision: payload.expectedRevision + 1,
          status: 'accepted',
          result: { authorizationEpoch: payload.expectedRevision + 1 },
        }),
      )
    })
  })
  cpEnv(t, server)
  const cpBase = `http://127.0.0.1:${server.address().port}`
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async (url, init) =>
    String(url).startsWith(cpBase)
      ? realFetch(url, init)
      : String(url).endsWith(`/session/minecraft/profile/${OWNER}`)
        ? Response.json({ id: OWNER, name: 'Nether' })
        : new Response('', { status: 404 })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  const call = async (as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(method === 'POST' ? { origin: 'http://site' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, s).then(
      (r) => r,
      (e) => e,
    )
  }
  const list = async () => (await (await call(`${ADMIN}:Adm`, 'GET', 'staff')).json()).staff
  assert.equal(
    (await list()).find((row) => row.uuid === OTHER).expectedRevision,
    null,
    'no receipt yet: the panel sends nothing and the server defaults',
  )
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'POST', 'staff', { uuid: OTHER, role: 'moderator' })).status,
    200,
  )
  assert.equal((await list()).find((row) => row.uuid === OTHER).expectedRevision, 2)
  assert.equal(
    (
      await call(`${ADMIN}:Adm`, 'POST', 'staff', {
        uuid: OTHER,
        role: 'builder',
        expectedRevision: 999,
      })
    ).status,
    409,
    'a stale explicit epoch surfaces as 409, never a blind overwrite',
  )
})

test('staff export: rows become operator import references, never accountIds', async (t) => {
  const s = await store(t)
  await s.setStaff(MOD, 'Mod', 'moderator', 'seed')
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const spec = await exportStaff(s)
  assert.equal(spec.scope.backend, 'game')
  assert.deepEqual(spec.staff, [
    { draslUuid: ADMIN, name: 'Adm', role: 'admin', maps: null },
    { draslUuid: MOD, name: 'Mod', role: 'moderator', maps: null },
  ])
  assert.ok(!JSON.stringify(spec).includes('accountId'), 'no invented CP identity')
})

function staffCall(s, server, extraFetch) {
  const cpBase = `http://127.0.0.1:${server.address().port}`
  const realFetch = globalThis.fetch
  const restore = () => {
    globalThis.fetch = realFetch
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(cpBase)) return realFetch(url, init)
    if (extraFetch) {
      const out = extraFetch(url)
      if (out) return out
    }
    return String(url).endsWith(`/session/minecraft/profile/${OWNER}`)
      ? Response.json({ id: OWNER, name: 'Nether' })
      : new Response('', { status: 404 })
  }
  const call = async (as, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, s).then(
      (r) => r,
      (e) => e,
    )
  }
  return { call, restore }
}

test('write-through: a CP receipt mirrors into the local replica', async (t) => {
  const server = await fakeCp(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(
        JSON.stringify({
          operationId: '33333333-3333-4333-8333-333333333333',
          revision: payload.expectedRevision + 1,
          status: 'accepted',
          result: { authorizationEpoch: payload.expectedRevision + 1 },
        }),
      )
    })
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  const { call, restore } = staffCall(s, server)
  t.after(restore)
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: 'moderator' })).status,
    200,
  )
  assert.deepEqual(
    (({ uuid, name, role, grantedBy, maps }) => ({ uuid, name, role, grantedBy, maps }))(
      (await s.staff()).find((row) => row.uuid === OTHER),
    ),
    { uuid: OTHER, name: 'Oth', role: 'moderator', grantedBy: 'Adm', maps: null },
    'the receipt mirrors into the replica',
  )
  assert.equal(await s.getCpEpoch(OTHER), 2)
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: null })).status,
    200,
    'revoke rides the cached epoch, no explicit revision needed',
  )
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER),
    undefined,
    'revoke deletes the replica row',
  )
})

test('write-through: revoke drops the member from the workshop sync', async (t) => {
  const server = await fakeCp(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(
        JSON.stringify({
          operationId: '44444444-4444-4334-8444-444444444444',
          revision: payload.expectedRevision + 1,
          status: 'accepted',
          result: { authorizationEpoch: payload.expectedRevision + 1 },
        }),
      )
    })
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  const { call, restore } = staffCall(s, server)
  t.after(restore)
  const granted = await (
    await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: 'moderator' })
  ).json()
  const membersAfterGrant = JSON.parse(
    readFileSync(join(process.env.BLOCKFIELD_INBOX_DIR, `${granted.sync.id}.json`), 'utf8'),
  ).members
  assert.ok(
    membersAfterGrant.some((m) => m.draslId === OTHER && m.role === 'lead'),
    'granted moderator reaches the members list',
  )
  const revoked = await (await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: null })).json()
  const membersAfterRevoke = JSON.parse(
    readFileSync(join(process.env.BLOCKFIELD_INBOX_DIR, `${revoked.sync.id}.json`), 'utf8'),
  ).members
  assert.ok(
    !membersAfterRevoke.some((m) => m.draslId === OTHER),
    'revoked member leaves the members list',
  )
})

test('revoke hits every role with a fresh epoch per call', async (t) => {
  const seen = []
  const server = await fakeCp(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      seen.push({ role: payload.role, expectedRevision: payload.expectedRevision })
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(
        JSON.stringify({
          operationId: '55555555-5555-4335-8555-555555555555',
          revision: payload.expectedRevision + 1,
          status: 'accepted',
          result: { authorizationEpoch: payload.expectedRevision + 1 },
        }),
      )
    })
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  const { call, restore } = staffCall(s, server)
  t.after(restore)
  assert.equal((await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: null })).status, 200)
  assert.deepEqual(
    seen.map((c) => [c.role, c.expectedRevision]),
    [
      ['builder', 1],
      ['moderator', 2],
      ['admin', 3],
    ],
    'every role revoked, each call on the epoch the previous receipt returned',
  )
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER),
    undefined,
  )
})

test('conflict: loud 409, cache kept, explicit revision recovers', async (t) => {
  const server = await fakeCp(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      res.setHeader('Content-Type', 'application/json')
      if (payload.expectedRevision === 9) {
        res.statusCode = 202
        return res.end(
          JSON.stringify({
            operationId: '66666666-6666-4336-8666-666666666666',
            revision: 10,
            status: 'accepted',
            result: { authorizationEpoch: 10 },
          }),
        )
      }
      res.statusCode = 409
      res.end(JSON.stringify({ error: 'revision_conflict' }))
    })
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  await s.setCpEpoch(OTHER, 5)
  const { call, restore } = staffCall(s, server)
  t.after(restore)
  const refused = await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: 'moderator' })
  assert.equal(refused.status, 409)
  assert.match(await refused.text(), /координатор/, 'points at the recovery path')
  assert.equal(await s.getCpEpoch(OTHER), 5, 'a refusal never clobbers the cache')
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'builder',
    'a refusal writes nothing locally',
  )
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'staff', { uuid: OTHER, role: 'moderator', expectedRevision: 9 }))
      .status,
    200,
    'an explicit epoch from the operator recovers',
  )
  assert.equal(await s.getCpEpoch(OTHER), 10)
  assert.equal((await s.staff()).find((row) => row.uuid === OTHER).role, 'moderator')
})

test('peer backstop: an out-of-band admin cannot be revoked by a non-owner', async (t) => {
  const seen = []
  const server = await fakeCp(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(JSON.parse(body).role)
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 403
      res.end(JSON.stringify({ error: 'peer_role_edit' }))
    })
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const outsider = 'dddddddddddddddddddddddddddddddd'
  const { call, restore } = staffCall(s, server, (url) =>
    String(url).endsWith('/Deed') ? Response.json({ id: outsider, name: 'Deed' }) : null,
  )
  t.after(restore)
  const refused = await call(`${ADMIN}:Adm`, 'staff', { name: 'Deed', role: null })
  assert.equal(refused.status, 403)
  assert.deepEqual(seen, ['builder'], 'aborts on the first refusal, nothing half-applied')
  assert.equal(
    (await s.staff()).find((row) => row.uuid === outsider),
    undefined,
    'a refusal creates no replica row',
  )
  assert.equal(await s.getCpEpoch(outsider), null, 'a refusal caches no epoch')
})
