import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import ts from 'typescript'
import { handleAdmin } from '../src/lib/admin.ts'
import { switchView } from '../src/lib/switch-status.ts'
import { MAP_NAMES, WORKSHOP_PLACES } from '../src/lib/game-names.ts'

const BUILDER = 'dddddddddddddddddddddddddddddddd',
  MOD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  NOBODY = 'cccccccccccccccccccccccccccccccc',
  GEN = '12345678-1234-4234-8234-123456789012'
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-wake-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
import { database as store } from './storage.mjs'

function workshopEnv(t, server) {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: GEN,
  })
}

async function fakeCp(t) {
  const seen = []
  let dropNext = false,
    receiptlessNext = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (dropNext) {
        dropNext = false
        req.socket.destroy()
        return
      }
      seen.push([req.method, req.url, JSON.parse(body)])
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(
        receiptlessNext
          ? ((receiptlessNext = false), JSON.stringify({ status: 'accepted' }))
          : JSON.stringify({ operationId: 'op-1', revision: null, status: 'accepted' }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return {
    server,
    seen,
    dropNext: () => (dropNext = true),
    receiptlessNext: () => (receiptlessNext = true),
  }
}

async function setup(t, cp) {
  const dirs = {
    BLOCKFIELD_ADMIN_DIR: temp(t),
    BLOCKFIELD_INBOX_DIR: temp(t),
    BLOCKFIELD_SETTINGS_DIR: temp(t),
  }
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: '', NODE_ENV: 'test' })
  workshopEnv(t, cp)
  const s = await store(t)
  await s.setStaff(BUILDER, 'Bob', 'builder', 'seed')
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const call = async (as, path, body, method = 'POST') => {
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
  return { dirs, s, call }
}

test('POST wake goes through typed CP actions, open to every staff role', async (t) => {
  const cp = await fakeCp(t)
  const { s, call } = await setup(t, cp.server)
  assert.equal((await call(`${NOBODY}:Nobody`, 'wake', {})).status, 403)
  for (const as of [`${BUILDER}:Bob`, `${MOD}:Moddy`, `${ADMIN}:Adm`]) {
    const response = await call(as, 'wake', {})
    assert.equal(response.status, 200, as)
    assert.deepEqual(await response.json(), { operationId: 'op-1' })
  }
  assert.deepEqual(
    cp.seen.map(([m, u, b]) => [m, u, b.actor]),
    [
      ['POST', '/v2/workshop/wake', { draslId: BUILDER, name: 'Bob' }],
      ['POST', '/v2/workshop/wake', { draslId: MOD, name: 'Moddy' }],
      ['POST', '/v2/workshop/wake', { draslId: ADMIN, name: 'Adm' }],
    ],
  )
  const [, , first] = cp.seen[0]
  assert.equal(first.consumerId, 'workshop')
  assert.equal(first.generation, GEN)
  assert.equal(first.target, '*')
  assert.match(first.idempotencyKey, /^[0-9a-f-]{36}$/)
  const log = await s.auditLog()
  assert.deepEqual(
    log.map((e) => [e.actorName, e.action, e.ok]),
    [
      ['Adm', 'workshop-wake', 1],
      ['Moddy', 'workshop-wake', 1],
      ['Bob', 'workshop-wake', 1],
    ],
  )
  assert.equal(JSON.parse(log[0].detail).operationId, 'op-1')
})

test('POST wake reuses the client key and reports unknown outcomes as unconfirmed', async (t) => {
  const cp = await fakeCp(t)
  const { call } = await setup(t, cp.server)
  const key = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const first = await call(`${MOD}:Moddy`, 'wake', { idempotencyKey: key })
  assert.equal(first.status, 200)
  const retry = await call(`${MOD}:Moddy`, 'wake', { idempotencyKey: key })
  assert.equal(retry.status, 200)
  assert.deepEqual(
    cp.seen.map(([, , b]) => b.idempotencyKey),
    [key, key],
    'a retry resends the same key so CP dedupes instead of double-applying',
  )
  assert.equal((await call(`${MOD}:Moddy`, 'wake', { idempotencyKey: 'not-a-uuid' })).status, 400)
  assert.equal(cp.seen.length, 2, 'an invalid key is rejected before any CP call')
  cp.receiptlessNext()
  const receiptless = await call(`${MOD}:Moddy`, 'wake', { idempotencyKey: key })
  assert.equal(receiptless.status, 200)
  assert.deepEqual(await receiptless.json(), { operationId: null, unknownOutcome: true })
  cp.dropNext()
  const dropped = await call(`${MOD}:Moddy`, 'wake', { idempotencyKey: key })
  assert.equal(dropped.status, 200)
  assert.deepEqual(await dropped.json(), { operationId: null, unknownOutcome: true })
})

test('POST wake fails closed without the workshop CP client', async (t) => {
  const cp = await fakeCp(t)
  const { call } = await setup(t, cp.server)
  delete process.env.BLOCKFIELD_CP_WORKSHOP_TOKEN
  assert.equal((await call(`${ADMIN}:Adm`, 'wake', {})).status, 503)
  assert.equal(cp.seen.length, 0, 'no CP call ran')
})

test('POST message validates like the old inbox writer and posts the text', async (t) => {
  const cp = await fakeCp(t)
  const { s, call } = await setup(t, cp.server)
  assert.equal((await call(`${BUILDER}:Bob`, 'message', { message: 'hi' })).status, 403)
  const said = await call(`${MOD}:Moddy`, 'message', { message: 'Перерыв 5 минут' })
  assert.equal(said.status, 200)
  assert.deepEqual(await said.json(), { operationId: 'op-1' })
  assert.deepEqual(
    cp.seen.map(([m, u, b]) => [m, u, b.message, b.actor]),
    [['POST', '/v2/workshop/message', 'Перерыв 5 минут', { draslId: MOD, name: 'Moddy' }]],
  )
  // Same Cc/§ stripping and code-point count as the removed inbox writer.
  const stripped = await call(`${MOD}:Moddy`, 'message', {
    message: '  §cРаботы\n👨\u200d👩\u200d👧\t ',
  })
  assert.equal(stripped.status, 200)
  assert.deepEqual(
    cp.seen.map(([, , b]) => b.message),
    ['Перерыв 5 минут', 'cРаботы👨\u200d👩\u200d👧'],
  )
  assert.equal((await call(`${MOD}:Moddy`, 'message', { message: 'x'.repeat(201) })).status, 400)
  assert.equal((await call(`${MOD}:Moddy`, 'message', {})).status, 400)
  assert.equal(cp.seen.length, 2, 'invalid bodies never reach CP')
  const log = await s.auditLog()
  assert.deepEqual(
    log.map((e) => [e.actorName, e.action, e.ok]),
    [
      ['Moddy', 'message', 0],
      ['Moddy', 'message', 0],
      ['Moddy', 'message', 1],
      ['Moddy', 'message', 1],
      ['Bob', 'message', 0],
    ],
  )
  assert.equal(JSON.parse(log[2].detail).operationId, 'op-1')
})

test('POST cancel is admin-only and posts through CP', async (t) => {
  const cp = await fakeCp(t)
  const { s, call } = await setup(t, cp.server)
  assert.equal((await call(`${NOBODY}:Nobody`, 'cancel', {})).status, 403)
  assert.equal((await call(`${MOD}:Moddy`, 'cancel', {})).status, 403)
  const cancelled = await call(`${ADMIN}:Adm`, 'cancel', {})
  assert.equal(cancelled.status, 200)
  assert.deepEqual(await cancelled.json(), { operationId: 'op-1' })
  assert.deepEqual(
    cp.seen.map(([m, u, b]) => [m, u, { ...b, idempotencyKey: undefined }]),
    [
      [
        'POST',
        '/v2/workshop/cancel',
        {
          environment: 'prod',
          backend: 'game',
          consumerId: 'workshop',
          generation: GEN,
          target: '*',
          actor: { draslId: ADMIN, name: 'Adm' },
          idempotencyKey: undefined,
        },
      ],
    ],
  )
  const log = await s.auditLog()
  assert.deepEqual(
    log.map((e) => [e.actorName, e.action, e.ok]),
    [
      ['Adm', 'cancel', 1],
      ['Moddy', 'cancel', 0],
    ],
  )
  assert.equal(JSON.parse(log[0].detail).operationId, 'op-1')
})

test('members still go to the inbox: staff sync writes a members request', async (t) => {
  const cp = await fakeCp(t)
  const { dirs, call } = await setup(t, cp.server)
  const synced = await call(`${ADMIN}:Adm`, 'staff/sync', {})
  assert.equal(synced.status, 200)
  const { id } = await synced.json()
  assert.deepEqual(
    JSON.parse(readFileSync(join(dirs.BLOCKFIELD_INBOX_DIR, `${id}.json`))).kind,
    'members',
  )
  assert.deepEqual(
    readdirSync(dirs.BLOCKFIELD_INBOX_DIR).filter((n) => !n.startsWith('.')),
    [`${id}.json`],
    'no CP-covered kind wrote an inbox file',
  )
})

// Rendering: reuse the page's own describeWorkshop, like test/admin-shell.test.mjs does.
const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
// SITE95-U2: section helpers live in typed modules; extract from all sources.
const libs = [
  '../src/lib/admin-shell.ts',
  '../src/lib/admin-settings.ts',
  '../src/lib/admin-workshop.ts',
]
  .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n')
const script = page.split('<script>')[1].split('</script>')[0] + '\n' + libs
const source = ts.createSourceFile('admin.ts', script, ts.ScriptTarget.Latest, true)
const extracted = ts.transpileModule(
  source.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        ['describeWorkshop', 'sessionLine', 'timing', 'ago'].includes(node.name?.text ?? ''),
    )
    .map((node) => node.getText(source))
    .join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText
const { describeWorkshop } = new Function(
  'switchView',
  'MAP_NAMES',
  'WORKSHOP_PLACES',
  'relative',
  'can',
  `${extracted}; return { describeWorkshop };`,
)(
  switchView,
  MAP_NAMES,
  WORKSHOP_PLACES,
  new Intl.RelativeTimeFormat('ru', { numeric: 'auto' }),
  () => false,
)

test('status rendering: sleeping shows «Мастерская спит», STARTING shows progress', () => {
  assert.deepEqual(describeWorkshop({ schema: 1, phase: 'sleeping' }, null, null), {
    tone: 'warn',
    title: 'Мастерская спит',
    detail:
      'Никого нет, мастерская спит и не занимает память. Она проснётся, когда строитель зайдёт, или по кнопке ниже.',
  })
  const starting = describeWorkshop(
    { schema: 1, phase: 'STARTING', desired: { profile: 'workshop' } },
    null,
    null,
  )
  assert.equal(starting.tone, 'warn')
  assert.equal(starting.title, 'Запускаем мастерскую')
  assert.deepEqual(
    describeWorkshop({ schema: 1, phase: 'workshop', gate: 'builders' }, null, null).title,
    'Мастерская открыта',
  )
})
