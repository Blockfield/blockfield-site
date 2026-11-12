import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Renewer, persist, renewAt } from '../src/lib/cp-renew.ts'

const DAY = 86_400_000
const KEY = 'BLOCKFIELD_CP_GATE_TOKEN'

function fake(times) {
  const { rejected = '', statePath } = times
  const calls = []
  let stateAtConfirm = null
  const call = async (method, path, token) => {
    calls.push(`${path} ${token}`)
    if (token === rejected) return { status: 401, body: {} }
    if (path === '/v2/me')
      return {
        status: 200,
        body: {
          issuedAt: new Date(times.issued).toISOString(),
          expiresAt: new Date(times.expires).toISOString(),
        },
      }
    if (path === '/v2/credentials/renew')
      return { status: 201, body: { token: `next-${token}`, expiresAt: 'later' } }
    try {
      stateAtConfirm = readFileSync(statePath, 'utf8')
    } catch {
      stateAtConfirm = null
    }
    return { status: 200, body: {} }
  }
  return { calls, call, confirmed: () => stateAtConfirm }
}

function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-renew-'))
  const statePath = options.statePath ?? join(dir, 'nested', 'state.json')
  const now = { value: options.now ?? Date.parse('2026-11-12T00:00:00Z') }
  const times = { ...options, statePath }
  const cp = fake(times)
  const env = { [KEY]: 'env', ...(options.env ?? {}) }
  const renewer = new Renewer({
    call: cp.call,
    env,
    statePath,
    now: () => now.value,
    log: () => {},
  })
  return { renewer, cp, env, statePath, now, times }
}

test('renew window: 7 days ahead, a quarter of a short lifetime', async () => {
  assert.equal(renewAt(0, 30 * DAY), 23 * DAY)
  assert.equal(renewAt(0, 8 * 60_000), 6 * 60_000)
  const now = Date.parse('2026-11-12T00:00:00Z')
  const {
    renewer,
    cp,
    env,
    now: clock,
  } = setup({ issued: now - 22 * DAY, expires: now + 8 * DAY, now })
  renewer.load()
  assert.equal(await renewer.tick(KEY), 3_600_000)
  assert.deepEqual(cp.calls, ['/v2/me env'])
  clock.value += DAY
  assert.equal(await renewer.tick(KEY), 0)
  assert.equal(env[KEY], 'next-env')
})

test('persists the successor before confirming it', async () => {
  const now = Date.parse('2026-11-12T00:00:00Z')
  const { renewer, cp, env, statePath, times } = setup({
    issued: now - 29 * DAY,
    expires: now + DAY,
    now,
  })
  renewer.load()
  await renewer.tick(KEY)
  Object.assign(times, { issued: now, expires: now + 30 * DAY })
  await renewer.tick(KEY)
  assert.deepEqual(cp.calls.slice(0, 4), [
    '/v2/me env',
    '/v2/credentials/renew env',
    '/v2/credentials/renew/confirm next-env',
    '/v2/me next-env',
  ])
  assert.equal(JSON.parse(cp.confirmed())[KEY].token, 'next-env')
  assert.equal(statSync(statePath).mode & 0o777, 0o600)
  assert.equal(env[KEY], 'next-env')
})

test('restart reads the state file and confirms it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-renew-'))
  const statePath = join(dir, 'state.json')
  await persist(statePath, KEY, 'next-env', 'env')
  const now = Date.now()
  const { renewer, cp, env } = setup({ statePath, issued: now, expires: now + 30 * DAY, now })
  renewer.load()
  assert.equal(env[KEY], 'next-env')
  await renewer.tick(KEY)
  assert.deepEqual(cp.calls, ['/v2/credentials/renew/confirm next-env', '/v2/me next-env'])
})

test('falls back to env without state, for a re-issued env token, or on rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-renew-'))
  const statePath = join(dir, 'state.json')
  const now = Date.now()
  const opts = { statePath, issued: now, expires: now + 30 * DAY, now }
  let s = setup(opts)
  s.renewer.load()
  assert.equal(s.env[KEY], 'env')
  await persist(statePath, KEY, 'next-old', 'old-env')
  s = setup(opts)
  s.renewer.load()
  assert.equal(s.env[KEY], 'env')
  writeFileSync(statePath, 'not json')
  s = setup(opts)
  s.renewer.load()
  assert.equal(s.env[KEY], 'env')
  await persist(statePath, KEY, 'next-env', 'env')
  s = setup({ ...opts, rejected: 'next-env' })
  s.renewer.load()
  assert.equal(s.env[KEY], 'next-env')
  await s.renewer.tick(KEY)
  assert.equal(s.env[KEY], 'env')
})

test('a CP without renewal support is checked hourly, not hammered', async () => {
  const env = { [KEY]: 'env' }
  const renewer = new Renewer({
    call: async () => ({ status: 200, body: { client: 'site-gate' } }),
    env,
    statePath: join(mkdtempSync(join(tmpdir(), 'cp-renew-')), 's.json'),
    now: Date.now,
    log: () => {},
  })
  renewer.load()
  assert.equal(await renewer.tick(KEY), 3_600_000)
  assert.equal(env[KEY], 'env')
})
