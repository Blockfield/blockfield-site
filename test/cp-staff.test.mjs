import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('CP mode refuses staff reads and writes without touching CP or the replica', async (t) => {
  const seen = []
  const server = await fakeCp(t, (req, res) => {
    seen.push([req.method, req.url])
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({}))
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(OTHER, 'Oth', 'moderator', 'seed')
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
  // Finding 1: a stale admin row buys nothing — the list itself refuses.
  const list = await call(`${ADMIN}:Adm`, 'GET', 'staff')
  assert.equal(list.status, 503)
  assert.match(await list.text(), /ростер-роут CP/)
  // The grant path refuses before any replica read, CP call or write.
  const granted = await call(`${ADMIN}:Adm`, 'POST', 'staff', {
    uuid: OTHER,
    role: 'builder',
  })
  assert.equal(granted.status, 503)
  assert.deepEqual(seen, [], 'no CP call precedes the refusal')
  assert.equal(
    (await s.staff()).find((row) => row.uuid === OTHER).role,
    'moderator',
    'the replica is untouched',
  )
})

test('CP mode refuses revokes for unknown targets and demotions alike', async (t) => {
  const seen = []
  const server = await fakeCp(t, (req, res) => {
    seen.push([req.method, req.url])
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({}))
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Mod', 'admin', 'seed')
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  const cpBase = `http://127.0.0.1:${server.address().port}`
  globalThis.fetch = async (url, init) =>
    String(url).startsWith(cpBase)
      ? realFetch(url, init)
      : String(url).endsWith('/Deed')
        ? Response.json({ id: 'dddddddddddddddddddddddddddddddd', name: 'Deed' })
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
  // Finding 2: no local row — refuses instead of deciding from `from: null`.
  assert.equal((await call(`${ADMIN}:Adm`, 'staff', { name: 'Deed', role: null })).status, 503)
  // Finding 3: demotion can no longer partially apply — nothing runs at all.
  assert.equal(
    (await call(`${OWNER}:Nether`, 'staff', { uuid: MOD, role: 'moderator' })).status,
    503,
  )
  assert.deepEqual(seen, [], 'neither revoke nor grant reached CP')
  assert.equal(
    (await s.staff()).find((row) => row.uuid === MOD).role,
    'admin',
    'the higher grant is untouched',
  )
})

test('CP mode refuses map and sync routes that authorize from the replica', async (t) => {
  const seen = []
  const server = await fakeCp(t, (req, res) => {
    seen.push([req.method, req.url])
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({}))
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  await s.setStaff(MOD, 'Mod', 'builder', 'seed')
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  const cpBase = `http://127.0.0.1:${server.address().port}`
  globalThis.fetch = async (url, init) =>
    String(url).startsWith(cpBase) ? realFetch(url, init) : new Response('', { status: 404 })
  const call = async (as, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, s).then(
      (r) => r,
      (e) => e,
    )
  }
  // OWNER dev user: BLOCKFIELD_OWNER_UUIDS is OWNER, so use the owner identity.
  process.env.BLOCKFIELD_OWNER_UUIDS = OWNER
  assert.equal((await call(`${ADMIN}:Adm`, 'staff/maps', { uuid: MOD, maps: null })).status, 503)
  assert.equal(
    (await call(`${ADMIN}:Adm`, 'staff/map-access', { mapId: 'fields', uuids: [] })).status,
    503,
  )
  assert.equal((await call(`${ADMIN}:Adm`, 'staff/sync', {})).status, 503)
  assert.deepEqual(seen, [], 'no CP call precedes the refusals')
  assert.equal((await s.staff()).find((row) => row.uuid === MOD).maps, null)
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
    postStaffGrantCp({ accountUuid: target, role, revoke, expectedRevision })
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
