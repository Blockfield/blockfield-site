import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpStaffConfigured, readMeCp, roleFromCpMe, postStaffGrantCp } from '../src/lib/cp.ts'
import { handleAdmin, handleWorkshopAccess, refreshRole } from '../src/lib/admin.ts'
import { staffIdempotencyKey } from '../src/lib/cp.ts'
import { exportStaff } from '../scripts/cp-staff-export.mjs'
import { database as store } from './storage.mjs'

const OWNER = 'e10438e4797b49718cfecec6a8fa171b'
const ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MOD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OTHER = 'cccccccccccccccccccccccccccccccc'
const GHOST = 'ffffffffffffffffffffffffffffffff'
const BERT = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const POISON = '12345678901234567890123456789012'
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
  // Owner names resolve through Drasl; stub it so the workshop push can be
  // built offline (admin.test.mjs does the same for the non-CP path).
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async (url, init) =>
    String(url).includes(OWNER) || String(url).includes(dashed(OWNER))
      ? Response.json({ id: dashed(OWNER), name: 'Nether' })
      : realFetch(url, init)
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
    ['service_actor_required', 500],
    ['actor_forbidden', 500],
    ['owner_approval_required', 403],
    ['invalid_owner_assertion', 403],
    ['forbidden', 403],
  ]
  for (const [nextCode, nextStatus] of cases) {
    code = nextCode
    status = nextStatus
    await assert.rejects(
      postStaffGrantCp({
        accountUuid: OTHER,
        role: 'moderator',
        expectedRevision: 1,
        actorAccountId: ADMIN,
      }),
      (e) => e.code === nextCode && e.status === nextStatus,
      nextCode,
    )
  }
})

async function staffFake(t, roles) {
  if (roles.writes === undefined) roles.writes = 0
  if (roles.writes === undefined) roles.writes = 0
  const seen = []
  const server = await fakeCp(t, (req, res) => {
    const url = new URL(req.url, 'http://cp')
    if (req.method === 'GET' && url.pathname === '/v2/staff/grants') {
      seen.push(['GET', req.url])
      if (
        typeof roles.failReadsFromWrites === 'number' &&
        roles.writes >= roles.failReadsFromWrites
      ) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: 'boom' }))
      }
      if (
        typeof roles.failReadsFromWrites === 'number' &&
        roles.writes >= roles.failReadsFromWrites
      ) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: 'boom' }))
      }
      const id = (url.searchParams.get('accountId') ?? '').replaceAll('-', '').toLowerCase()
      const entry = roles.get(id)
      res.setHeader('Content-Type', 'application/json')
      if (entry?.poison) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: 'boom' }))
      }
      if (!entry) {
        res.statusCode = 404
        return res.end(JSON.stringify({ error: 'account_not_found' }))
      }
      return res.end(
        JSON.stringify({
          accountId: url.searchParams.get('accountId'),
          expectedRevision: entry.epoch,
          grants: entry.roles.map((role) => ({
            role,
            environment: url.searchParams.get('environment') ?? 'prod',
            backend: url.searchParams.get('backend') ?? 'game',
            resource: '*',
            revision: entry.epoch,
            expires_at: null,
          })),
        }),
      )
    }
    if (req.method === 'POST' && url.pathname === '/v2/staff/grants') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const payload = JSON.parse(body)
        seen.push(['POST', req.url, payload])
        res.setHeader('Content-Type', 'application/json')
        const deny = (code, status = 403) => {
          res.statusCode = status
          res.end(JSON.stringify({ error: code }))
        }
        if (
          typeof payload.actorAccountId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            payload.actorAccountId,
          )
        )
          return deny('service_actor_required')
        const id = String(payload.accountId ?? '')
          .replaceAll('-', '')
          .toLowerCase()
        const entry = roles.get(id)
        if (!entry) return deny('account_not_found', 404)
        if (roles.dropNextPosts > 0) {
          roles.dropNextPosts -= 1
          req.socket.destroy()
          return
        }
        if (entry.epoch !== payload.expectedRevision) return deny('revision_conflict', 409)
        if (payload.role === 'admin' || entry.roles.includes('admin'))
          return deny('owner_approval_required')
        if (payload.revoke) entry.roles = entry.roles.filter((r) => r !== payload.role)
        else if (!entry.roles.includes(payload.role)) entry.roles.push(payload.role)
        entry.epoch += 1
        roles.writes += 1
        if (roles.destroyNextPosts > 0) {
          roles.destroyNextPosts -= 1
          req.socket.destroy()
          return
        }
        res.statusCode = 202
        res.end(
          JSON.stringify({
            operationId: '66666666-6666-4336-8666-666666666666',
            status: 'accepted',
            result: { authorizationEpoch: entry.epoch },
          }),
        )
      })
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not_found' }))
  })
  return { server, seen }
}

async function callCp(s, as, method, path, body) {
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

test('CP mode lists the roster from CP grants, not the replica', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [OTHER, { roles: ['builder'], epoch: 3 }],
  ])
  const { server, seen } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
  await s.setStaff(GHOST, 'Gho', 'builder', 'seed')
  const res = await callCp(s, `${ADMIN}:Adm`, 'GET', 'staff')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(
    data.staff.map((m) => [m.uuid, m.role, m.expectedRevision]),
    [
      [ADMIN, 'admin', 7],
      [OTHER, 'builder', 3],
    ],
    'live CP roles win over stale replica rows; CP-unknown rows drop out',
  )
  assert.equal(data.staff.find((m) => m.uuid === OTHER).grantedBy, 'seed')
  assert.deepEqual(
    data.owners.map((o) => o.uuid),
    [OWNER],
  )
  assert.ok(
    seen
      .filter(([method]) => method === 'GET')
      .every(([, url]) => url.includes('environment=prod') && url.includes('backend=game')),
    'roster reads carry the site scope',
  )
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'moderator',
    'the list never rewrites the replica',
  )
})

test('CP mode role changes replace the other in-scope grants', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [OTHER, { roles: ['moderator'], epoch: 3 }],
  ])
  const { server, seen } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
  // Demote: moderator -> builder leaves only builder.
  const granted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'builder',
  })
  assert.equal(granted.status, 200)
  const posts = seen.filter(([method]) => method === 'POST')
  assert.equal(posts.length, 2, 'the leftover moderator grant is revoked too')
  const payload = posts[0][2]
  assert.equal(payload.accountId, dashed(OTHER))
  assert.equal(payload.expectedRevision, 3, 'the revision comes from the roster read')
  assert.equal(payload.role, 'builder')
  assert.equal(payload.revoke, false)
  assert.equal(payload.actorAccountId, dashed(ADMIN), 'the acting admin is asserted')
  assert.equal(payload.environment, 'prod')
  assert.equal(payload.backend, 'game')
  assert.equal(payload.resource, '*')
  assert.match(payload.idempotencyKey, /^[0-9a-f-]{36}$/)
  assert.equal(posts[1][2].role, 'moderator')
  assert.equal(posts[1][2].revoke, true)
  assert.equal(posts[1][2].expectedRevision, 4, 'reconcile re-reads the revision between writes')
  assert.deepEqual(roles.get(OTHER).roles, ['builder'])
  const receipt = await granted.json()
  assert.equal(receipt.role, 'builder')
  assert.equal(receipt.operationId, '66666666-6666-4336-8666-666666666666')
  assert.ok(receipt.sync.id, 'workshop sync still runs')
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'builder',
    'the replica mirrors the receipt',
  )
  // Promote, then the leftover builder grant goes with it.
  const promoted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'moderator',
  })
  assert.equal(promoted.status, 200)
  assert.deepEqual(roles.get(OTHER).roles, ['moderator'])
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  const cpBase = `http://127.0.0.1:${server.address().port}`
  globalThis.fetch = async (url, init) =>
    String(url).startsWith(cpBase)
      ? realFetch(url, init)
      : String(url).endsWith('/minecraft/Oth')
        ? Response.json({ id: dashed(OTHER), name: 'Oth' })
        : String(url).includes(OWNER) || String(url).includes(dashed(OWNER))
          ? Response.json({ id: dashed(OWNER), name: 'Nether' })
          : new Response('', { status: 404 })
  const revoked = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    name: 'Oth',
    role: null,
  })
  assert.equal(revoked.status, 200)
  const all = seen.filter(([method]) => method === 'POST')
  assert.equal(all.length, 5)
  assert.equal(all[2][2].expectedRevision, 5)
  assert.equal(all[3][2].expectedRevision, 6)
  assert.equal(all[4][2].revoke, true)
  assert.equal(all[4][2].role, 'moderator', 'revoke carries the live role for scope')
  assert.equal(all[4][2].expectedRevision, 7, 'every write chains on the previous receipt')
  assert.deepEqual(roles.get(OTHER).roles, [], 'revoke leaves nothing in scope')
  assert.equal((await revoked.json()).role, null)
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER),
    undefined,
    'revoke removes the mirrored row',
  )
})

test('CP mode refuses self-edits, peers and unknown members before any grant POST', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [MOD, { roles: ['admin'], epoch: 4 }],
  ])
  const { server, seen } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Mod', 'moderator', 'seed')
  await s.setStaff(GHOST, 'Gho', 'builder', 'seed')
  const self = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: ADMIN,
    role: 'builder',
  })
  assert.equal(self.status, 403)
  assert.match(await self.text(), /Свою роль/)
  assert.deepEqual(
    seen,
    [['GET', `/v2/staff/grants?accountId=${dashed(ADMIN)}&environment=prod&backend=game`]],
    'self-edit needs only the actor roster read, never a grant POST',
  )
  const peer = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: MOD,
    role: 'moderator',
  })
  assert.equal(peer.status, 403)
  assert.match(await peer.text(), /Администраторов назначает только владелец/)
  assert.ok(
    seen.every(([method]) => method === 'GET'),
    'peer rule refuses before any grant POST',
  )
  const ghost = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: GHOST,
    role: 'builder',
  })
  assert.equal(ghost.status, 404)
  assert.match(await ghost.text(), /Участник не найден/)
  assert.ok(
    seen.every(([method]) => method === 'GET'),
    'unknown CP accounts never reach the grant endpoint',
  )
  assert.equal((await s.staff()).length, 3, 'refusals leave the replica alone')
})

test('CP mode owner step-up fails closed with a clear message', async (t) => {
  const roles = new Map([[OTHER, { roles: ['moderator'], epoch: 3 }]])
  const { server, seen } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
  const res = await callCp(s, `${OWNER}:Nether`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'admin',
  })
  assert.equal(res.status, 403)
  const text = await res.text()
  assert.match(text, /шага владельца/)
  assert.match(text, /недоступного на сайте/)
  assert.match(text, /координатору/)
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'moderator',
    'the refused grant mirrors nothing',
  )
  assert.equal(seen.filter(([method]) => method === 'POST').length, 1, 'the denial comes from CP')
})

test('CP mode maps and sync follow CP roles', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [MOD, { roles: ['builder'], epoch: 2 }],
  ])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Mod', 'moderator', 'seed')
  await s.setStaffMaps(MOD, ['fields'])
  const maps = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/maps', {
    uuid: MOD,
    maps: ['fields'],
  })
  assert.equal(maps.status, 200)
  assert.deepEqual((await maps.json()).maps, ['fields'])
  roles.get(MOD).roles = ['moderator']
  const demoted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/maps', {
    uuid: MOD,
    maps: null,
  })
  assert.equal(demoted.status, 400)
  assert.match(await demoted.text(), /только строителям/)
  const access = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/map-access', {
    mapId: 'fields',
    uuids: [MOD],
  })
  assert.equal(access.status, 400, 'a CP moderator is no builder for map access')
  roles.get(MOD).roles = ['builder']
  const repaired = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/map-access', {
    mapId: 'fields',
    uuids: [MOD],
  })
  assert.equal(repaired.status, 200)
  assert.deepEqual((await repaired.json()).changed, [])
  const sync = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/sync', {})
  assert.equal(sync.status, 200)
  const members = (await sync.json()).members
  assert.ok(
    members.some((m) => m.draslId === MOD && m.role === 'builder'),
    'sync pushes CP roles, not stale replica rows',
  )
})

test('CP mode ignores a stale replica admin on every route', async (t) => {
  const roles = new Map([[OTHER, { roles: [], epoch: 3 }]])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(OTHER, 'Oth', 'admin', 'seed')
  const me = await callCp(s, `${OTHER}:Oth`, 'GET', 'me')
  assert.equal(me.status, 200)
  const identity = await me.json()
  assert.equal(identity.role, null, 'CP grants decide, not the replica row')
  assert.deepEqual(identity.permissions, [])
  assert.equal((await callCp(s, `${OTHER}:Oth`, 'GET', 'staff')).status, 403)
})

test('CP mode write-path syncs push CP roles, not stale replica rows', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [MOD, { roles: ['builder'], epoch: 2 }],
    [OTHER, { roles: ['builder'], epoch: 3 }],
    [BERT, { roles: ['builder'], epoch: 1 }],
  ])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Mod', 'builder', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  await s.setStaff(BERT, 'Ber', 'builder', 'seed')
  // Direct-CP revoke: the replica keeps a stale builder row.
  roles.get(OTHER).roles = []
  const inbox = process.env.BLOCKFIELD_INBOX_DIR
  const membersOf = (result) => {
    const file = join(inbox, `${result.sync.id}.json`)
    return JSON.parse(readFileSync(file, 'utf8')).members
  }
  const granted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: MOD,
    role: 'moderator',
  })
  assert.equal(granted.status, 200)
  const afterGrant = membersOf(await granted.json())
  assert.ok(afterGrant.some((m) => m.draslId === MOD && m.role === 'lead'))
  assert.ok(!afterGrant.some((m) => m.draslId === OTHER), 'direct-CP revokes leave the pushed list')
  const maps = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/maps', {
    uuid: BERT,
    maps: ['hub'],
  })
  assert.equal(maps.status, 200)
  assert.ok(!membersOf(await maps.json()).some((m) => m.draslId === OTHER))
  const access = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/map-access', {
    mapId: 'fields',
    uuids: [BERT],
  })
  assert.equal(access.status, 200)
  const accessBody = await access.json()
  assert.deepEqual(accessBody.changed, ['Ber'])
  assert.ok(!membersOf(accessBody).some((m) => m.draslId === OTHER))
})

test('CP mode map-access snapshots inside the lock', async (t) => {
  // 30 filler builders stretch the roster read; BERT sorts second, so its
  // snapshot is taken while a concurrent maps edit can still land.
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [BERT, { roles: ['builder'], epoch: 1 }],
  ])
  const fillers = []
  for (let i = 0; i < 30; i++) {
    const uuid = `${String(i).padStart(30, '0')}ff`
    fillers.push(uuid)
    roles.set(uuid, { roles: ['builder'], epoch: 1 })
  }
  const { server, seen } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(BERT, 'Ber', 'builder', 'seed')
  for (const [i, uuid] of fillers.entries())
    await s.setStaff(uuid, `M${String(i).padStart(2, '0')}`, 'builder', 'seed')
  await s.setStaffMaps(BERT, null)
  const pending = callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/map-access', {
    mapId: 'fields',
    uuids: [],
  })
  // Wait until the access read is past BERT: its snapshot predates the edit below.
  const start = Date.now()
  while (seen.filter(([method]) => method === 'GET').length < 12) {
    if (Date.now() - start > 5000) throw new Error('roster read stalled')
    await new Promise((r) => setTimeout(r, 5))
  }
  const edited = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff/maps', {
    uuid: BERT,
    maps: ['hub'],
  })
  assert.equal(edited.status, 200)
  const access = await pending
  assert.equal(access.status, 200)
  assert.ok((await access.json()).changed.includes('Ber'))
  assert.deepEqual(
    (await s.staff()).find((row) => row.uuid === BERT).maps,
    ['hub'],
    'the later maps edit wins; a stale snapshot must not overwrite it',
  )
})

test('CP mode role changes ignore non-site grants', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [OTHER, { roles: ['moderator', 'auditor'], epoch: 3 }],
  ])
  const { server, seen } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
  const granted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'builder',
  })
  assert.equal(granted.status, 200)
  const posts = seen.filter(([method]) => method === 'POST')
  assert.equal(posts.length, 2, 'only the leftover site role is revoked')
  assert.equal(posts[1][2].role, 'moderator')
  assert.deepEqual(
    [...roles.get(OTHER).roles].sort(),
    ['auditor', 'builder'],
    'auditor stays untouched',
  )
  assert.equal((await granted.json()).role, 'builder')
})

test('CP mode sync-list failure lands in the sync error field', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [OTHER, { roles: ['moderator'], epoch: 3 }],
    [POISON, { roles: ['builder'], epoch: 1, poison: true }],
  ])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
  await s.setStaff(POISON, 'Poi', 'builder', 'seed')
  const res = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'builder',
  })
  assert.equal(res.status, 200, 'the applied grant is reported, not thrown away')
  const body = await res.json()
  assert.equal(body.role, 'builder')
  assert.ok(body.operationId)
  assert.ok(typeof body.sync.error === 'string', 'sync failure is a field, not a throw')
  assert.deepEqual(roles.get(OTHER).roles, ['builder'])
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'builder',
    'the grant is mirrored despite the sync failure',
  )
})

test('CP mode partial reconcile still mirrors and names held roles', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [OTHER, { roles: ['moderator'], epoch: 3 }],
  ])
  roles.failReadsFromWrites = 1
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
  // Demote: the main grant applies, the reconcile re-read fails.
  const demoted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'builder',
  })
  assert.equal(demoted.status, 200, 'the applied grant is reported, not thrown away')
  const demotedBody = await demoted.json()
  assert.equal(demotedBody.role, 'builder')
  assert.ok(demotedBody.operationId)
  assert.deepEqual(
    [...demotedBody.partialApply].sort(),
    ['builder', 'moderator'],
    'the failed reconcile names what CP still holds',
  )
  assert.ok(typeof demotedBody.sync.error === 'string', 'sync failure is a field too')
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'moderator',
    'the mirror shows the highest held role, not the just-granted one',
  )
  // Revoke: the same holds when the leftover cannot even be re-read.
  roles.failReadsFromWrites = 2
  const revoked = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: null,
  })
  assert.equal(revoked.status, 200)
  const revokedBody = await revoked.json()
  assert.deepEqual(revokedBody.partialApply, ['builder'])
  assert.equal(revokedBody.role, null)
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'builder',
    'the row is kept while CP still holds a site role',
  )
  roles.failReadsFromWrites = Infinity
  const relist = await callCp(s, `${ADMIN}:Adm`, 'GET', 'staff')
  assert.equal(relist.status, 200)
  assert.ok(
    (await relist.json()).staff.some((m) => m.uuid === OTHER && m.role === 'builder'),
    'the member does not disappear from GET staff before the retry',
  )
})

test('CP mode editable maps follow the replica row maps, not its role', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [MOD, { roles: ['builder'], epoch: 2 }],
    [OTHER, { roles: ['builder'], epoch: 1 }],
  ])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const adminDir = mkdtempSync(join(tmpdir(), 'bf-maps-'))
  t.after(() => rmSync(adminDir, { recursive: true, force: true }))
  writeFileSync(
    join(adminDir, 'maps.json'),
    JSON.stringify({
      schema: 1,
      maps: [
        {
          mapId: 'fields',
          kind: 'arena',
          mapJson: { id: 'fields' },
          head: null,
          versions: [
            {
              schema: 1,
              mapId: 'fields',
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
        },
      ],
    }),
  )
  Object.assign(process.env, { BLOCKFIELD_ADMIN_DIR: adminDir })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Mod', 'moderator', 'seed')
  await s.setStaffMaps(MOD, ['fields'])
  const res = await callCp(s, `${MOD}:Mod`, 'GET', 'maps')
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).editableMaps, ['fields'])
  const norow = await callCp(s, `${OTHER}:Oth`, 'GET', 'maps')
  assert.equal(norow.status, 200)
  assert.deepEqual((await norow.json()).editableMaps, [], 'no row means no maps')
})

test('CP mode tablet access authorizes from CP', async (t) => {
  const KEY = 'k'.repeat(40)
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [OTHER, { roles: ['builder'], epoch: 2 }],
  ])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  const tablet = (actor, target) =>
    handleWorkshopAccess(
      new Request('http://site/api/workshop/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ actor, target, mapId: 'hub', allowed: true }),
      }),
      { BLOCKFIELD_WORKSHOP_KEY: KEY },
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
  // A replica admin revoked in CP is refused.
  roles.get(ADMIN).roles = []
  assert.equal((await tablet(ADMIN, OTHER)).status, 403)
  roles.get(ADMIN).roles = ['admin']
  // A CP builder target passes even though the replica agrees here.
  const ok = await tablet(ADMIN, OTHER)
  assert.equal(ok.status, 200)
  // A CP-revoked target is not a builder, even with a replica row.
  roles.get(OTHER).roles = []
  assert.equal((await tablet(ADMIN, OTHER)).status, 400)
})

test('CP mode event refresh ignores stale replica roles', async (t) => {
  const roles = new Map([[OTHER, { roles: [], epoch: 3 }]])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(OTHER, 'Oth', 'admin', 'seed')
  assert.equal(await refreshRole({ uuid: OTHER, name: 'Oth', role: 'admin' }, s), null)
  roles.get(OTHER).roles = ['moderator']
  assert.equal(await refreshRole({ uuid: OTHER, name: 'Oth', role: null }, s), 'moderator')
  delete process.env.BLOCKFIELD_CP_STAFF_TOKEN
  assert.equal(await refreshRole({ uuid: OTHER, name: 'Oth', role: null }, s), 'admin')
})

test('team page reports CP-held roles after a partial grant', async () => {
  const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
  // SITE95-U2: section helpers live in typed modules; extract from all sources.
  const libs = [
    '../src/lib/admin-shell.ts',
    '../src/lib/admin-settings.ts',
    '../src/lib/admin-workshop.ts',
    '../src/lib/admin-overview.ts',
    '../src/lib/admin-players.ts',
    '../src/lib/admin-stats.ts',
    '../src/lib/admin-journal.ts',
    '../src/lib/admin-health.ts',
    '../src/lib/admin-console.ts',
    '../src/lib/admin-tabs.ts',
  ]
    .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
    .join('\n')
  const script = page.split('<script>')[1].split('</script>')[0] + '\n' + libs
  const source = ts.createSourceFile('admin.ts', script, ts.ScriptTarget.Latest, true)
  const wanted = ['changeRole', 'CP_ROLE_GENITIVE']
  const defs = source.statements
    .filter(
      (node) =>
        (ts.isFunctionDeclaration(node) && wanted.includes(node.name?.text ?? '')) ||
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((d) => wanted.includes(d.name.getText(source)))),
    )
    .map((node) => node.getText(source))
    .join('\n')
  const compiled = ts.transpileModule(defs, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const dom = new JSDOM('', { url: 'https://blockfield.test/admin', runScripts: 'outside-only' })
  try {
    let posted
    let shown
    Object.assign(dom.window, {
      api: async (path, method, body) => {
        posted = body
        return { sync: {}, partialApply: ['moderator'] }
      },
      loadTeam: async () => {},
      run: async (line, fn) => {
        shown = await fn()
      },
    })
    dom.window.eval(compiled)
    await dom.window.eval(`changeRole({ uuid: 'x', role: 'builder' }, 'X теперь строитель.', null)`)
    assert.equal(posted.role, 'builder')
    assert.equal(shown, 'X теперь строитель. Но в CP осталась роль модератора — повторите.')
    dom.window.api = async () => ({ sync: {}, partialApply: ['builder', 'moderator'] })
    await dom.window.eval(
      `changeRole({ uuid: 'x', role: 'moderator' }, 'X теперь модератор.', null)`,
    )
    assert.equal(
      shown,
      'X теперь модератор. Но в CP остались роли строителя, модератора — повторите.',
    )
    dom.window.api = async () => ({ sync: { error: 'x' }, partialApply: ['moderator'] })
    await dom.window.eval(`changeRole({ uuid: 'x', role: 'builder' }, 'X теперь строитель.', null)`)
    assert.ok(shown.includes('Обновить доступ'), 'the sync warning stays')
    assert.ok(shown.includes('роль модератора'), 'the partial warning joins it')
    dom.window.api = async () => ({ sync: {}, partialApply: [] })
    await dom.window.eval(`changeRole({ uuid: 'x', role: 'builder' }, 'X теперь строитель.', null)`)
    assert.equal(shown, 'X теперь строитель.')
  } finally {
    dom.window.close()
  }
})

test('CP mode skips unreadable roster rows instead of aborting', async (t) => {
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [OTHER, { roles: ['builder'], epoch: 2 }],
    [POISON, { roles: ['builder'], epoch: 1, poison: true }],
  ])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'builder', 'seed')
  await s.setStaff(POISON, 'Poi', 'builder', 'seed')
  const list = await callCp(s, `${ADMIN}:Adm`, 'GET', 'staff')
  assert.equal(list.status, 200)
  const members = (await list.json()).staff.map((m) => m.uuid)
  assert.ok(members.includes(ADMIN) && members.includes(OTHER))
  assert.ok(!members.includes(POISON), 'the poisoned row is left out, not fatal')
  const granted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'moderator',
  })
  assert.equal(granted.status, 200)
  const body = await granted.json()
  assert.equal(body.role, 'moderator')
  assert.ok(body.sync.id)
  assert.match(body.sync.error, /Poi/, 'the push names the skipped account')
  const pushed = JSON.parse(
    readFileSync(join(process.env.BLOCKFIELD_INBOX_DIR, `${body.sync.id}.json`), 'utf8'),
  ).members
  assert.ok(!pushed.some((m) => m.draslId === POISON), 'the push leaves the bad row out')
  assert.ok(pushed.some((m) => m.draslId === OTHER && m.role === 'lead'))
})

test('CP mode unknown primary outcome recovers from CP truth', async (t) => {
  assert.equal(
    staffIdempotencyKey({
      actorAccountId: ADMIN,
      accountUuid: OTHER,
      role: 'builder',
      revoke: false,
      scope: { environment: 'prod', backend: 'game', resource: '*' },
      uiRevision: 3,
    }),
    staffIdempotencyKey({
      actorAccountId: dashed(ADMIN),
      accountUuid: dashed(OTHER),
      role: 'builder',
      revoke: false,
      scope: { environment: 'prod', backend: 'game', resource: '*' },
      uiRevision: 3,
    }),
    'same intent, same key',
  )
  assert.notEqual(
    staffIdempotencyKey({
      actorAccountId: ADMIN,
      accountUuid: OTHER,
      role: 'builder',
      revoke: false,
      scope: { environment: 'prod', backend: 'game', resource: '*' },
      uiRevision: 3,
    }),
    staffIdempotencyKey({
      actorAccountId: ADMIN,
      accountUuid: OTHER,
      role: 'builder',
      revoke: false,
      scope: { environment: 'prod', backend: 'game', resource: '*' },
      uiRevision: 4,
    }),
    'a later list revision gets a new key',
  )
  const roles = new Map([
    [ADMIN, { roles: ['admin'], epoch: 7 }],
    [OTHER, { roles: ['moderator'], epoch: 3 }],
  ])
  roles.failReadsFromWrites = Infinity
  const { server, seen } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
  // The primary answer is lost after CP applied it: the re-read continues.
  roles.destroyNextPosts = 1
  const granted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'builder',
    expectedRevision: 3,
  })
  assert.equal(granted.status, 200)
  const grantedBody = await granted.json()
  const mainPost = seen.filter(([method]) => method === 'POST')[0][2]
  assert.equal(
    mainPost.idempotencyKey,
    staffIdempotencyKey({
      actorAccountId: ADMIN,
      accountUuid: OTHER,
      role: 'builder',
      revoke: false,
      scope: { environment: 'prod', backend: 'game', resource: '*' },
      uiRevision: 3,
    }),
  )
  assert.equal(grantedBody.role, 'builder')
  assert.ok(grantedBody.operationId === null || typeof grantedBody.operationId === 'string')
  assert.deepEqual(roles.get(OTHER).roles, ['builder'])
  assert.equal((await s.staff()).find((row) => row.uuid === OTHER).role, 'builder')
  // The primary answer is lost and the change did not land: report, do not mirror.
  roles.dropNextPosts = 1
  const dropped = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'moderator',
    expectedRevision: 4,
  })
  assert.equal(dropped.status, 503)
  assert.equal((await s.staff()).find((row) => row.uuid === OTHER).role, 'builder')
  // CP unreachable after an unknown write: retry state, no mirrored guess.
  roles.failReadsFromWrites = 3
  roles.destroyNextPosts = 1
  const unknown = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'moderator',
    expectedRevision: 4,
  })
  assert.equal(unknown.status, 200)
  const unknownBody = await unknown.json()
  assert.equal(unknownBody.unknownOutcome, true)
  assert.ok(unknownBody.operationId === null)
  assert.ok(typeof unknownBody.sync.error === 'string')
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'builder',
    'no CP answer means no mirrored guess',
  )
})

test('CP outage fails staff routes closed', async (t) => {
  const probe = await fakeCp(t, (req, res) => res.end('{}'))
  cpEnv(t, probe)
  const dead = `http://127.0.0.1:${probe.address().port}`
  probe.close()
  Object.assign(process.env, { BLOCKFIELD_CP_URL: dead })
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
  const list = await callCp(s, `${ADMIN}:Adm`, 'GET', 'staff')
  assert.equal(list.status, 503)
  assert.match(await list.text(), /координатору/)
  const granted = await callCp(s, `${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'builder',
  })
  assert.equal(granted.status, 503)
})

test('CP-known actor without a replica row passes the gate', async (t) => {
  const roles = new Map([[ADMIN, { roles: ['admin'], epoch: 7 }]])
  const { server } = await staffFake(t, roles)
  cpEnv(t, server)
  const s = await store(t)
  const res = await callCp(s, `${ADMIN}:Adm`, 'GET', 'staff')
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).staff, [])
  roles.delete(ADMIN)
  const denied = await callCp(s, `${ADMIN}:Adm`, 'GET', 'staff')
  assert.equal(denied.status, 403)
})

test('CP staff error messages name the coordinator for the new codes', async (t) => {
  let code = 'service_actor_required'
  const server = await fakeCp(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 500
    res.end(JSON.stringify({ error: code }))
  })
  cpEnv(t, server)
  for (const next of [
    'service_actor_required',
    'actor_forbidden',
    'owner_approval_required',
    'invalid_owner_assertion',
    'forbidden',
  ]) {
    code = next
    await assert.rejects(
      postStaffGrantCp({
        accountUuid: OTHER,
        role: 'moderator',
        expectedRevision: 1,
        actorAccountId: ADMIN,
      }),
      (e) => e.code === next && /координатор/.test(e.message),
      next,
    )
  }
})

test('peer rule: stateful fake CP enforces the real grant_change policy', async (t) => {
  // Mirrors control-plane cpv2/core.py grant_change: owner check, peer check,
  // existence, epoch CAS, step-up for admin work, then apply with epoch+1.
  const accounts = new Map()
  const adminTarget = 'dddddddddddddddddddddddddddddddd'
  accounts.set(adminTarget, { epoch: 5, grants: new Set(['admin']), owner: false })
  const server = await fakeCp(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      res.setHeader('Content-Type', 'application/json')
      const deny = (code, status = 403) => {
        res.statusCode = status
        res.end(JSON.stringify({ error: code }))
      }
      const account = accounts.get(payload.accountId.replaceAll('-', ''))
      if (account?.owner) return deny('protected_owner')
      if (account && account.grants.has('admin')) return deny('peer_role_edit')
      if (!account) return deny('account_not_found', 404)
      if (typeof payload.actorAccountId !== 'string') return deny('service_actor_required')
      if (account.epoch !== payload.expectedRevision) return deny('revision_conflict', 409)
      if (payload.role === 'admin') return deny('owner_approval_required')
      if (payload.revoke) account.grants.delete(payload.role)
      else account.grants.add(payload.role)
      account.epoch += 1
      res.statusCode = 202
      res.end(
        JSON.stringify({
          operationId: '66666666-6666-4336-8666-666666666666',
          revision: account.epoch,
          status: 'accepted',
          result: { authorizationEpoch: account.epoch },
        }),
      )
    })
  })
  cpEnv(t, server)
  const target = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  accounts.set(target, { epoch: 1, grants: new Set(), owner: false })
  const grant = (role, revoke, expectedRevision) =>
    postStaffGrantCp({ accountUuid: target, role, revoke, expectedRevision, actorAccountId: ADMIN })
  const ok = (promise) =>
    promise.then(
      (r) => r,
      (e) => e,
    )
  // Chained epochs land every grant, exactly like the prescribed loop would.
  assert.equal((await grant('builder', false, 1)).authorizationEpoch, 2)
  assert.equal((await grant('moderator', false, 2)).authorizationEpoch, 3)
  assert.deepEqual([...accounts.get(target).grants].sort(), ['builder', 'moderator'])
  // An out-of-band admin cannot be revoked by the non-owner service caller.
  const peer = await ok(
    postStaffGrantCp({
      accountUuid: adminTarget,
      role: 'builder',
      revoke: true,
      expectedRevision: 5,
      actorAccountId: ADMIN,
    }),
  )
  assert.equal(peer.status, 403)
  assert.equal(peer.code, 'peer_role_edit')
  assert.ok(accounts.get(adminTarget).grants.has('admin'), 'the admin grant survives')
  // Admin grants need owner step-up, which a service credential cannot present.
  const stepUp = await ok(grant('admin', false, 3))
  assert.equal(stepUp.status, 403)
  assert.equal(stepUp.code, 'owner_approval_required')
  // A stale epoch is a 409 with the recovery hint, never a silent write.
  const stale = await ok(grant('builder', true, 1))
  assert.equal(stale.status, 409)
  assert.match(stale.message, /координатор/)
  assert.ok(accounts.get(target).grants.has('builder'), 'the refused revoke changed nothing')
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

test('site#116 item 5: public player role reads CP, not the replica (revoked admin is null)', async (t) => {
  const { handleStatsRequest } = await import('../src/lib/stats.ts')
  const server = await fakeCp(t, (req, res) => {
    const url = new URL(req.url, 'http://cp')
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && url.pathname === '/v2/staff/grants') {
      return res.end(JSON.stringify({ accountId: OTHER, roles: [], grants: [], epoch: 3 }))
    }
    if (req.method === 'GET' && url.pathname === `/v2/stats/players/${dashed(OTHER)}`) {
      return res.end(
        JSON.stringify({
          schemaVersion: 1,
          checkedAt: '2026-09-14T00:02:00.000Z',
          ratingStatus: 'glicko2-v1',
          season: null,
          mmrSeason: 's2',
          page: 1,
          limit: 20,
          profile: {
            uuid: dashed(OTHER),
            name: 'Oth',
            lastSeen: Date.parse('2026-09-14T00:01:00Z'),
            role: null,
          },
          totals: null,
          campaigns: { completed: 0, wins: 0 },
          classes: [],
          history: [],
          mmr: null,
          ratingHistory: [],
        }),
      )
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not_found' }))
  })
  cpEnv(t, server)
  process.env.BLOCKFIELD_CP_STATS_TOKEN = 'stats-t'
  const s = await store(t)
  await s.setStaff(OTHER, 'Oth', 'admin', 'seed')
  const res = await handleStatsRequest(
    new Request(`https://example.test/api/stats/players/${dashed(OTHER)}`),
    { store: s },
  )
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.profile.role, null, 'CP revoke wins over replica row')
})
