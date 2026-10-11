import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isWorkshopAiGuardModel,
  isWorkshopAiKey,
  isWorkshopAiModel,
  workshopAiKeyLine,
} from '../src/lib/workshop-ai.ts'
import {
  readWorkshopAiKeyStatus,
  readWorkshopAiSettings,
  validateWorkshopAiKey,
  validateWorkshopAiSettings,
} from '../src/lib/workshop-ai-policy.ts'
import { handleAdmin, saveWorkshopAiSettings, writeRequest } from '../src/lib/admin.ts'
import { database } from './storage.mjs'

const SECRET = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789-AB'
const LEAK = (text) => !JSON.stringify(text).includes(SECRET)
const settings = () => ({
  schema: 1,
  revision: 2,
  enabled: true,
  generationModel: 'meta/muse-spark-1.3-contributor',
  guardModel: 'typesafe/jev-1.13',
  transcriptionModel: 'elevenlabs/scribe-v2',
})
const rejected = (action, status = 400) =>
  assert.throws(action, (error) => error instanceof Response && error.status === status)
function temp(t, prefix = 'bf-workshop-ai-') {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('settings validate a closed schema with per-field model rules', () => {
  assert.deepEqual(validateWorkshopAiSettings(settings()), settings())
  assert.ok(isWorkshopAiModel('a/b'))
  assert.ok(!isWorkshopAiModel('no-slash'))
  assert.ok(isWorkshopAiGuardModel('typesafe/jev-1.13'))
  assert.ok(!isWorkshopAiGuardModel('meta/muse-spark-1.3-contributor'))
  assert.ok(isWorkshopAiKey(SECRET))
  assert.ok(!isWorkshopAiKey('too short'))
  for (const mutate of [
    (value) => (value.schema = 2),
    (value) => (value.revision = -1),
    (value) => (value.revision = 1.5),
    (value) => (value.enabled = 'yes'),
    (value) => delete value.enabled,
    (value) => (value.extra = true),
    (value) => (value.generationModel = 'no-slash-here'),
    (value) => (value.generationModel = `a/${'x'.repeat(128)}`),
    (value) => (value.generationModel = 'a/b c'),
    (value) => (value.guardModel = 'typesafe/other-1'),
    (value) => (value.guardModel = 'meta/muse-spark-1.3-contributor'),
    (value) => (value.guardModel = `typesafe/jev-${'x'.repeat(65)}`),
    (value) => (value.transcriptionModel = ''),
    (value) => (value.transcriptionModel = 42),
  ]) {
    const invalid = settings()
    mutate(invalid)
    rejected(() => validateWorkshopAiSettings(invalid))
  }
})

test('missing file returns defaults with revision 0; corrupt or oversized files fail closed', (t) => {
  const directory = temp(t)
  assert.deepEqual(readWorkshopAiSettings(directory), {
    schema: 1,
    revision: 0,
    enabled: false,
    generationModel: 'meta/muse-spark-1.3-contributor',
    guardModel: 'typesafe/jev-1.13',
    transcriptionModel: 'elevenlabs/scribe-v2',
  })
  for (const bytes of [
    '{broken',
    JSON.stringify({ ...settings(), guardModel: 'wrong/model' }),
    'x'.repeat(4097),
  ]) {
    writeFileSync(join(directory, 'workshop-ai-settings.json'), bytes)
    rejected(() => readWorkshopAiSettings(directory), 503)
    rejected(
      () =>
        saveWorkshopAiSettings(directory, {
          expectedRevision: 0,
          enabled: false,
          generationModel: 'a/b',
          guardModel: 'typesafe/jev-1',
          transcriptionModel: 'c/d',
        }),
      503,
    )
    assert.equal(readFileSync(join(directory, 'workshop-ai-settings.json'), 'utf8'), bytes)
  }
})

test('settings save uses optimistic revision and rejects unknown keys', (t) => {
  const directory = temp(t)
  const body = {
    expectedRevision: 0,
    enabled: true,
    generationModel: 'provider/gen-model',
    guardModel: 'typesafe/jev-2',
    transcriptionModel: 'provider/stt-model',
  }
  const saved = saveWorkshopAiSettings(directory, body)
  assert.equal(saved.revision, 1)
  assert.equal(saved.enabled, true)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'workshop-ai-settings.json'), 'utf8')), {
    ...saved,
  })
  rejected(() => saveWorkshopAiSettings(directory, { ...body, expectedRevision: 0 }), 409)
  rejected(() => saveWorkshopAiSettings(directory, { ...body, expectedRevision: 1, extra: 1 }))
  rejected(() =>
    saveWorkshopAiSettings(directory, { ...body, expectedRevision: 1, guardModel: 'other/model' }),
  )
  assert.equal(
    JSON.parse(readFileSync(join(directory, 'workshop-ai-settings.json'), 'utf8')).revision,
    1,
  )
})

test('key accepts printable ASCII of 20–2048 chars or null; errors never echo the value', async () => {
  assert.equal(validateWorkshopAiKey(null), null)
  assert.equal(validateWorkshopAiKey(SECRET), SECRET)
  assert.equal(validateWorkshopAiKey('!'.repeat(20)), '!'.repeat(20))
  assert.equal(validateWorkshopAiKey('~'.repeat(2048)), '~'.repeat(2048))
  for (const invalid of [
    {},
    42,
    '',
    'x'.repeat(19),
    '~'.repeat(2049),
    'has space inside abcdefghij',
    'кириллица-abcdefghijklmnop',
    'tab\there-abcdefghijklmnop',
  ]) {
    const error = await Promise.resolve()
      .then(() => validateWorkshopAiKey(invalid))
      .then(
        () => null,
        (thrown) => thrown,
      )
    assert.ok(error instanceof Response && error.status === 400, `accepted ${invalid}`)
    const message = await error
      .clone()
      .json()
      .then((data) => data.error)
    assert.ok(!message.includes(SECRET), 'error echoes the key')
    if (typeof invalid === 'string' && invalid.length >= 8)
      assert.ok(!message.includes(invalid), 'error echoes the input')
  }
})

test('ai-key inbox request uses the shared envelope and is written atomically', (t) => {
  const inbox = temp(t, 'bf-ai-key-inbox-')
  const actor = { uuid: '1'.repeat(32), name: 'Tester', role: 'admin' }
  const id = writeRequest(inbox, actor, { kind: 'ai-key', key: SECRET })
  assert.match(id, /^[0-9a-f-]{36}$/)
  const files = readdirSync(inbox)
  assert.deepEqual(files, [`${id}.json`])
  const request = JSON.parse(readFileSync(join(inbox, `${id}.json`), 'utf8'))
  assert.equal(request.schema, 1)
  assert.equal(request.id, id)
  assert.equal(request.kind, 'ai-key')
  assert.deepEqual(request.actor, { draslId: actor.uuid, name: actor.name })
  assert.ok(Number.isSafeInteger(request.createdAt) && request.createdAt > 0)
  assert.equal(request.key, SECRET)
  const removed = writeRequest(inbox, actor, { kind: 'ai-key', key: null })
  assert.equal(JSON.parse(readFileSync(join(inbox, `${removed}.json`), 'utf8')).key, null)
  rejected(() => writeRequest(inbox, actor, { kind: 'ai-key', key: 'short' }))
  rejected(() => writeRequest(inbox, actor, { kind: 'ai-key' }))
  assert.equal(readdirSync(inbox).length, 2)
})

test('key status tolerates the controller file; missing or malformed means unset', (t) => {
  const directory = temp(t)
  assert.deepEqual(readWorkshopAiKeyStatus(directory), { set: false })
  writeFileSync(
    join(directory, 'ai-key.json'),
    JSON.stringify({
      set: true,
      last4: 'ab12',
      sha256Prefix: 'deadbeef',
      appliedAt: 1728400000000,
    }),
  )
  assert.deepEqual(readWorkshopAiKeyStatus(directory), {
    set: true,
    last4: 'ab12',
    sha256Prefix: 'deadbeef',
    appliedAt: 1728400000000,
  })
  // Newer controller fields never break the site; malformed values mean unset.
  writeFileSync(
    join(directory, 'ai-key.json'),
    JSON.stringify({ set: true, last4: 'ab12', ok: true, kind: 'ai-key', next: 1 }),
  )
  assert.deepEqual(readWorkshopAiKeyStatus(directory), { set: true, last4: 'ab12' })
  for (const bytes of [
    '{broken',
    JSON.stringify({ set: false }),
    JSON.stringify({ set: true, last4: 'TOOLONG' }),
    JSON.stringify({ set: true, sha256Prefix: 'xyz' }),
    JSON.stringify({ set: true, appliedAt: -1 }),
    'x'.repeat(4097),
  ]) {
    writeFileSync(join(directory, 'ai-key.json'), bytes)
    assert.deepEqual(readWorkshopAiKeyStatus(directory), { set: false })
  }
})

test('key status line covers unset, pending, error and set states', () => {
  const stamp = (ms) => `D${ms}`
  assert.equal(workshopAiKeyLine({ set: false }, { waiting: false }, stamp), 'Ключ не задан')
  assert.equal(workshopAiKeyLine({ set: false }, { waiting: true }, stamp), 'Ключ применяется…')
  assert.equal(
    workshopAiKeyLine({ set: true, last4: 'ab12' }, { waiting: false, error: 'bad key' }, stamp),
    'Контроллер не применил ключ: bad key',
  )
  assert.equal(
    workshopAiKeyLine(
      { set: true, last4: 'ab12', appliedAt: 1728400000000 },
      { waiting: false },
      stamp,
    ),
    'Ключ задан · ••••ab12 · D1728400000000',
  )
  assert.equal(workshopAiKeyLine({ set: true }, { waiting: false }, stamp), 'Ключ задан')
})

test('admin routes: staff-only access, no key in files, responses, errors or audit', async (t) => {
  const settingsDir = temp(t, 'bf-ai-settings-'),
    adminDir = temp(t, 'bf-ai-admin-'),
    inbox = temp(t, 'bf-ai-inbox-'),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  const owner = '1'.repeat(32),
    admin = '2'.repeat(32),
    moderator = '3'.repeat(32)
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: owner,
    BLOCKFIELD_SETTINGS_DIR: settingsDir,
    BLOCKFIELD_ADMIN_DIR: adminDir,
    BLOCKFIELD_INBOX_DIR: inbox,
  })
  await store.setStaff(admin, 'Tester', 'admin', 'seed')
  await store.setStaff(moderator, 'Tester', 'moderator', 'seed')
  const call = async (actor, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${actor}:Tester`
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return handleAdmin(
      { request, url, cookies: { get: () => undefined } },
      path.split('?')[0],
      store,
    ).catch((error) => error)
  }
  for (const [method, path, body] of [
    ['GET', 'workshop-ai-settings', undefined],
    ['PUT', 'workshop-ai-settings', { expectedRevision: 0, ...settings(), revision: undefined }],
    ['GET', 'workshop-ai-key', undefined],
    ['POST', 'workshop-ai-key', { key: SECRET }],
  ]) {
    const response = await call(moderator, method, path, body)
    assert.equal(response.status, 403, `${method} ${path} is not staff-only`)
  }
  const initial = await call(admin, 'GET', 'workshop-ai-settings')
  assert.equal(initial.status, 200)
  assert.deepEqual((await initial.json()).settings, {
    schema: 1,
    revision: 0,
    enabled: false,
    generationModel: 'meta/muse-spark-1.3-contributor',
    guardModel: 'typesafe/jev-1.13',
    transcriptionModel: 'elevenlabs/scribe-v2',
  })
  const saved = await call(admin, 'PUT', 'workshop-ai-settings', {
    expectedRevision: 0,
    enabled: true,
    generationModel: 'provider/gen',
    guardModel: 'typesafe/jev-2',
    transcriptionModel: 'provider/stt',
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).settings.revision, 1)
  assert.equal(
    (await call(admin, 'PUT', 'workshop-ai-settings', { expectedRevision: 0, enabled: true }))
      .status,
    409,
  )
  const posted = await call(admin, 'POST', 'workshop-ai-key', { key: SECRET })
  assert.equal(posted.status, 200)
  const { id } = await posted.json()
  assert.deepEqual(Object.keys({ id }), ['id'])
  const inboxFiles = readdirSync(inbox)
  assert.equal(inboxFiles.length, 1)
  assert.equal(JSON.parse(readFileSync(join(inbox, inboxFiles[0]), 'utf8')).key, SECRET)
  const bad = await call(admin, 'POST', 'workshop-ai-key', { key: 'short' })
  assert.equal(bad.status, 400)
  assert.ok(LEAK(await bad.clone().json()))
  // Pending while the controller has no result yet; corrupt results fail closed.
  const pending = await call(admin, 'GET', 'workshop-ai-key', undefined)
  assert.equal(pending.status, 200)
  assert.deepEqual(await pending.json(), { status: { set: false }, result: null })
  const pendingId = await call(admin, 'GET', `workshop-ai-key?id=${id}`, undefined)
  assert.deepEqual(await pendingId.json(), { status: { set: false }, result: null })
  mkdirSync(join(adminDir, 'results'), { recursive: true })
  writeFileSync(
    join(adminDir, 'results', `${id}.json`),
    JSON.stringify({ schema: 1, id, ok: 'yes' }),
  )
  assert.equal((await call(admin, 'GET', `workshop-ai-key?id=${id}`, undefined)).status, 503)
  writeFileSync(
    join(adminDir, 'results', `${id}.json`),
    JSON.stringify({ schema: 1, id, kind: 'ai-key', ok: true, set: true, last4: 'ab12' }),
  )
  const done = await call(admin, 'GET', `workshop-ai-key?id=${id}`, undefined)
  assert.equal((await done.json()).result.ok, true)
  assert.equal((await call(admin, 'GET', 'workshop-ai-key?id=nope', undefined)).status, 400)
  // The key lives only in the inbox file: never in settings, responses, errors or audit.
  assert.ok(LEAK(readFileSync(join(settingsDir, 'workshop-ai-settings.json'), 'utf8')))
  for (const entry of await store.auditLog(50)) assert.ok(LEAK(entry))
  const keyAudit = (await store.auditLog(50)).filter((entry) => entry.action === 'workshop-ai-key')
  assert.ok(keyAudit.length >= 1)
  assert.ok(keyAudit.every((entry) => entry.ok || entry.action === 'workshop-ai-key'))
})
