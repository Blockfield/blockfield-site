import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { handleAdmin, pendingWakeId, writeRequest } from '../src/lib/admin.ts'
import { switchView } from '../src/lib/switch-status.ts'
import { MAP_NAMES, WORKSHOP_PLACES } from '../src/lib/game-names.ts'

const BUILDER = 'dddddddddddddddddddddddddddddddd',
  MOD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  NOBODY = 'cccccccccccccccccccccccccccccccc'
const status = (error) =>
  error instanceof Response ? error.status : assert.fail(`expected Response, got ${error}`)
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-wake-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
import { database as store } from './storage.mjs'

test('wake envelope: parameterless request with the standard inbox base', (t) => {
  const dir = temp(t),
    actor = { uuid: MOD, name: 'Mod', role: 'moderator' }
  const id = writeRequest(dir, actor, { kind: 'wake', extra: 'ignored' })
  const request = JSON.parse(readFileSync(join(dir, `${id}.json`)))
  assert.deepEqual(Object.keys(request).sort(), ['actor', 'createdAt', 'id', 'kind', 'schema'])
  assert.deepEqual(request, {
    schema: 1,
    id,
    kind: 'wake',
    actor: { draslId: MOD, name: 'Mod' },
    createdAt: request.createdAt,
  })
  assert.throws(
    () => writeRequest(dir, actor, { kind: 'wake-up' }),
    (e) => status(e) === 400,
  )
})

test('pendingWakeId: reuses an unanswered wake, ignores the rest', (t) => {
  const inbox = temp(t),
    results = temp(t)
  assert.equal(pendingWakeId(join(inbox, 'missing'), results), null)
  assert.equal(pendingWakeId(inbox, results), null)
  const actor = { uuid: MOD, name: 'Mod', role: 'moderator' }
  const first = writeRequest(inbox, actor, { kind: 'wake' })
  const second = writeRequest(inbox, actor, { kind: 'wake' })
  assert.ok([first, second].includes(pendingWakeId(inbox, results)))
  // An answered wake no longer counts; other kinds, dotfiles and junk never do.
  writeFileSync(join(results, `${first}.json`), JSON.stringify({ schema: 1, id: first, ok: true }))
  assert.equal(pendingWakeId(inbox, results), second)
  writeFileSync(join(inbox, '.wake.tmp'), '{}')
  writeFileSync(join(inbox, 'junk.json'), 'not json')
  writeFileSync(
    join(inbox, 'other.json'),
    JSON.stringify({ schema: 1, id: 'other', kind: 'cancel' }),
  )
  const alien = writeRequest(inbox, actor, { kind: 'cancel' })
  assert.equal(pendingWakeId(inbox, results), second, 'cancel request is not a wake')
  writeFileSync(
    join(results, `${second}.json`),
    JSON.stringify({ schema: 1, id: second, ok: true }),
  )
  writeFileSync(join(results, `${alien}.json`), JSON.stringify({ schema: 1, id: alien, ok: true }))
  assert.equal(pendingWakeId(inbox, results), null)
})

test('POST wake: every staff role may wake, strangers may not; one pending id is reused', async (t) => {
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
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: '', NODE_ENV: 'test' })
  const s = await store(t)
  await s.setStaff(BUILDER, 'Bob', 'builder', 'seed')
  await s.setStaff(MOD, 'Moddy', 'moderator', 'seed')
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
  assert.equal((await call(`${NOBODY}:Nobody`, 'POST', 'wake', {})).status, 403)
  for (const as of [`${BUILDER}:Bob`, `${MOD}:Moddy`, `${ADMIN}:Adm`]) {
    const response = await call(as, 'POST', 'wake', {})
    assert.equal(response.status, 200, as)
    assert.match((await response.json()).id, /^[0-9a-f-]{36}$/)
  }
  const files = readdirSync(dirs.BLOCKFIELD_INBOX_DIR).filter((n) => !n.startsWith('.'))
  assert.equal(files.length, 1, 'the second and third calls reuse the pending wake')
  const wake = JSON.parse(readFileSync(join(dirs.BLOCKFIELD_INBOX_DIR, files[0])))
  assert.equal(wake.kind, 'wake')
  assert.equal(wake.actor.draslId, BUILDER, 'the first (builder) request is kept')
  const log = (await (await call(`${ADMIN}:Adm`, 'GET', 'audit')).json()).entries
  assert.deepEqual(
    log.filter((e) => e.action === 'workshop-wake').map((e) => [e.actorName, e.ok]),
    [
      ['Adm', 1],
      ['Moddy', 1],
      ['Bob', 1],
    ],
  )
})

// Rendering: reuse the page's own describeWorkshop, like test/admin-shell.test.mjs does.
const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
const script = page.split('<script>')[1].split('</script>')[0]
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
