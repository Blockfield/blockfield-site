import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAiLimits, validateAiLimits } from '../src/lib/ai-limits.ts'
import { canonicalBudgetUuid, usdAmount, usdMicros } from '../src/lib/ai-budget.ts'
import { handleAdmin, saveAiLimits, saveSettings, validateSettings } from '../src/lib/admin.ts'
import { database } from './storage.mjs'

const SESSION = '11111111-1111-4111-8111-111111111111'
const BUILDER = '22222222-2222-4222-8222-222222222222'
const policy = () => ({
  schema: 1,
  revision: 4,
  currency: 'USD',
  mode: 'session',
  sessions: { [SESSION]: 10_000_000 },
  builders: { [BUILDER]: 1_000_000 },
})
const rejected = (action, status = 400) =>
  assert.throws(action, (error) => error instanceof Response && error.status === status)
function temp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bf-ai-limits-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('USD input is exact in integer microUSD and refuses rounding, exponent notation and overflow', () => {
  for (const [text, amount] of [
    ['0', 0],
    ['0.000001', 1],
    ['0,100001', 100001],
    ['1.234567', 1234567],
    ['1000000', 1_000_000_000_000],
  ]) {
    assert.equal(usdMicros(text), amount)
    assert.equal(usdMicros(usdAmount(amount)), amount)
  }
  for (const text of [
    '',
    '-1',
    '1e3',
    'NaN',
    'Infinity',
    '0.0000001',
    '1.',
    '1000000.000001',
    '9'.repeat(40),
  ])
    assert.throws(() => usdMicros(text))
  assert.equal(canonicalBudgetUuid(BUILDER.replaceAll('-', '').toUpperCase()), BUILDER)
  assert.equal(canonicalBudgetUuid('not-a-player'), null)
})

test('money policy validates closed schema, canonical UUIDs and bounded integer grants', () => {
  assert.deepEqual(validateAiLimits(policy()), policy())
  for (const mutate of [
    (value) => (value.currency = 'EUR'),
    (value) => (value.schema = 2),
    (value) => (value.mode = 'owner'),
    (value) => (value.revision = 0.1),
    (value) => (value.reset = true),
    (value) => (value.builders = null),
    (value) => (value.sessions = []),
    (value) => (value.builders = { [BUILDER.replaceAll('-', '')]: 1 }),
    (value) => (value.builders = { [BUILDER.toUpperCase().replace('2', 'A')]: 1 }),
    (value) =>
      (value.builders = Object.fromEntries(
        Array.from({ length: 257 }, (_, n) => [
          `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
          1,
        ]),
      )),
  ]) {
    const invalid = policy()
    mutate(invalid)
    rejected(() => validateAiLimits(invalid))
  }
  for (const amount of [
    -1,
    0.5,
    NaN,
    Infinity,
    '1',
    1_000_000_000_001,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    rejected(() => validateAiLimits({ ...policy(), builders: { [BUILDER]: amount } }))
})

test('budget has its own optimistic revision; mode-only saves preserve grants and ordinary settings cannot change it', (t) => {
  const directory = temp(t)
  assert.deepEqual(readAiLimits(directory), {
    schema: 1,
    revision: 0,
    currency: 'USD',
    mode: 'session',
    sessions: {},
    builders: {},
  })
  writeFileSync(join(directory, 'ai-limits.json'), JSON.stringify(policy()))
  const saved = saveAiLimits(directory, { expectedRevision: 4, mode: 'builder' })
  assert.equal(saved.revision, 5)
  assert.deepEqual(saved.sessions, policy().sessions)
  assert.deepEqual(saved.builders, policy().builders)
  const before = readFileSync(join(directory, 'ai-limits.json'), 'utf8')
  rejected(() => saveAiLimits(directory, { expectedRevision: 4, mode: 'session' }), 409)
  rejected(() =>
    saveAiLimits(directory, { expectedRevision: 5, mode: 'session', builders: { [BUILDER]: 0.1 } }),
  )
  rejected(() => saveAiLimits(directory, { expectedRevision: 5, mode: 'session', reset: true }))
  rejected(() => validateSettings({ expectedRevision: 0, aiLimits: policy() }))
  saveSettings(directory, { expectedRevision: 0, rooms: { maxRooms: 3 } }, 'Admin')
  assert.equal(readFileSync(join(directory, 'ai-limits.json'), 'utf8'), before)
  const revoked = saveAiLimits(directory, {
    expectedRevision: 5,
    mode: 'builder',
    builders: { [BUILDER]: 0 },
  })
  assert.deepEqual(revoked.sessions, saved.sessions)
  assert.equal(revoked.builders[BUILDER], 0)
})

test('corrupt or oversized policy fails closed without overwriting existing bytes', (t) => {
  const directory = temp(t)
  for (const bytes of [
    '{broken',
    JSON.stringify({ ...policy(), currency: 'EUR' }),
    'x'.repeat(65_537),
  ]) {
    writeFileSync(join(directory, 'ai-limits.json'), bytes)
    rejected(() => readAiLimits(directory), 503)
    rejected(() => saveAiLimits(directory, { expectedRevision: 0, mode: 'session' }), 503)
    assert.equal(readFileSync(join(directory, 'ai-limits.json'), 'utf8'), bytes)
  }
})

test('only the owner can read or raise budgets; admins and below are refused and audited', async (t) => {
  const directory = temp(t),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  const owner = '1'.repeat(32),
    admin = '2'.repeat(32),
    moderator = '3'.repeat(32),
    builder = '4'.repeat(32)
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: owner,
    BLOCKFIELD_SETTINGS_DIR: directory,
    BLOCKFIELD_ADMIN_DIR: directory,
  })
  for (const [uuid, role] of [
    [admin, 'admin'],
    [moderator, 'moderator'],
    [builder, 'builder'],
  ])
    await store.setStaff(uuid, 'Tester', role, 'seed')
  writeFileSync(
    join(directory, 'members.json'),
    JSON.stringify([{ draslId: builder, name: 'Tester', role: 'admin' }]),
  )
  const call = async (actor, method, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${actor}:Tester`
    const url = new URL('http://site/api/admin/ai-limits'),
      request = new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    return handleAdmin(
      { request, url, cookies: { get: () => undefined } },
      'ai-limits',
      store,
    ).catch((error) => error)
  }
  for (const actor of [admin, moderator, builder]) {
    assert.equal((await call(actor, 'GET')).status, 403)
    assert.equal(
      (
        await call(actor, 'PUT', {
          expectedRevision: 0,
          mode: 'builder',
          builders: { [BUILDER]: 10_000_000 },
        })
      ).status,
      403,
    )
  }
  assert.equal(readAiLimits(directory).revision, 0)
  assert.equal((await call(owner, 'GET')).status, 200)
  const response = await call(owner, 'PUT', {
    expectedRevision: 0,
    mode: 'builder',
    builders: { [BUILDER]: 1_250_000 },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).policy.revision, 1)
  const before = readFileSync(join(directory, 'ai-limits.json'), 'utf8')
  assert.equal((await call(owner, 'PUT', { expectedRevision: 0, mode: 'session' })).status, 409)
  assert.equal(
    (
      await call(owner, 'PUT', {
        expectedRevision: 1,
        mode: 'session',
        sessions: { [SESSION]: 0.5 },
      })
    ).status,
    400,
  )
  assert.equal(readFileSync(join(directory, 'ai-limits.json'), 'utf8'), before)
  const audit = await store.auditLog(20)
  assert.equal(audit.filter((entry) => entry.action === 'ai-limits' && !entry.ok).length, 5)
  assert.equal(audit.filter((entry) => entry.action === 'ai-limits' && entry.ok).length, 1)
  const granted = audit.find((entry) => entry.action === 'ai-limits' && entry.ok)
  // Grant amounts are owner-only and admins read the audit log: entries keep the mode only.
  assert.deepEqual(JSON.parse(granted.detail), { mode: 'builder' })
  // Rows written before the redaction still carry full bodies on disk: the audit
  // feed must project them to the redacted shape for every reader, including admins.
  const legacy = { expectedRevision: 1, mode: 'builder', builders: { [BUILDER]: 1_250_000 } }
  const legacyId = await store.auditPending({
    actorUuid: owner,
    actorName: 'Tester',
    role: 'owner',
    action: 'ai-limits',
    target: 'revision 1',
    detail: legacy,
    ok: false,
    error: null,
  })
  await store.auditFinalize(legacyId, {
    actorUuid: owner,
    actorName: 'Tester',
    role: 'owner',
    action: 'ai-limits',
    target: 'revision 1',
    detail: legacy,
    ok: true,
    error: null,
  })
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${admin}:Tester`
  const feed = await handleAdmin(
    {
      request: new Request(new URL('http://site/api/admin/audit'), { method: 'GET' }),
      url: new URL('http://site/api/admin/audit'),
      cookies: { get: () => undefined },
    },
    'audit',
    store,
  ).catch((error) => error)
  assert.equal(feed.status, 200)
  const legacyEntry = (await feed.json()).entries.find(
    (entry) => entry.action === 'ai-limits' && entry.target === 'revision 1',
  )
  assert.deepEqual(legacyEntry.detail, { mode: 'builder' })
})
