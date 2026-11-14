import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isCustomProviderId,
  isWorkshopAiBaseUrl,
  isWorkshopAiKey,
  isWorkshopAiModel,
  isWorkshopAiProvider,
  isWorkshopAiProviderId,
  workshopAiKeyLine,
  workshopAiKeyStatusFile,
} from '../src/lib/workshop-ai.ts'
import {
  parseWorkshopAiKeyStatus,
  readWorkshopAiSettings,
  validateWorkshopAiKey,
  validateWorkshopAiSettings,
} from '../src/lib/workshop-ai-policy.ts'
import { handleAdmin, prepareWorkshopRequest, saveWorkshopAiSettings } from '../src/lib/admin.ts'
import { database } from './storage.mjs'

const SECRET = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789-AB'
const LEAK = (text) => !JSON.stringify(text).includes(SECRET)
const settings = () => ({
  schema: 1,
  revision: 2,
  enabled: true,
  provider: 'vercel-gateway',
  generationProvider: 'openrouter',
  transcriptionProvider: 'my-proxy',
  providers: [{ id: 'my-proxy', label: 'Мой прокси', baseUrl: 'https://proxy.example.com/v1' }],
  generationModel: 'other/custom-model',
  transcriptionModel: 'other/stt-9',
  cleanupModel: 'other/cleanup-1',
  cleanupProvider: 'my-proxy',
  maxBlocks: 1024,
  blocksPerTick: 512,
  minimumBuildTicks: 60,
  applyBudgetMs: 4,
  hourlyRequestLimit: 100,
  hourlyPlayerRequestLimit: 10,
  maxHourlyBuilders: 32,
  generationMaxPricePromptUsdPerM: 0.5,
  generationMaxPriceCompletionUsdPerM: 1.5,
})
const rejected = (action, status = 400) =>
  assert.throws(action, (error) => error instanceof Response && error.status === status)
function temp(t, prefix = 'bf-workshop-ai-') {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('settings validate a closed schema with one shape check per model, never a list', () => {
  assert.deepEqual(validateWorkshopAiSettings(settings()), settings())
  assert.ok(isWorkshopAiModel('a/b'))
  assert.ok(!isWorkshopAiModel('no-slash'))
  assert.ok(isWorkshopAiProvider('openrouter'))
  assert.ok(isWorkshopAiProvider('vercel-gateway'))
  assert.ok(!isWorkshopAiProvider('direct'))
  assert.ok(isWorkshopAiProviderId('my-proxy'))
  assert.ok(!isWorkshopAiProviderId('My_Proxy'))
  assert.ok(!isWorkshopAiProviderId('openrouter!'))
  assert.ok(isCustomProviderId('my-proxy'))
  assert.ok(!isCustomProviderId('openrouter'))
  assert.ok(!isCustomProviderId('vercel-gateway'))
  assert.ok(!isCustomProviderId('ai'))
  assert.ok(!isCustomProviderId('ai-gateway'))
  assert.ok(!isCustomProviderId('../x'))
  assert.ok(isWorkshopAiBaseUrl('https://proxy.example.com/v1'))
  assert.ok(!isWorkshopAiBaseUrl('http://proxy.example.com/v1'))
  assert.ok(!isWorkshopAiBaseUrl('https://user@proxy.example.com/v1'))
  assert.ok(!isWorkshopAiBaseUrl('https://proxy.example.com/v1?key=1'))
  assert.ok(!isWorkshopAiBaseUrl('https://proxy.example.com/v1#frag'))
  assert.ok(!isWorkshopAiBaseUrl(`https://proxy.example.com/${'x'.repeat(200)}`))
  assert.equal(workshopAiKeyStatusFile('openrouter'), 'ai-key.json')
  assert.equal(workshopAiKeyStatusFile('vercel-gateway'), 'ai-gateway-key.json')
  assert.equal(workshopAiKeyStatusFile('my-proxy'), 'my-proxy-key.json')
  // Any well-shaped model works, including ones no old allowlist knew.
  assert.ok(isWorkshopAiModel('typesafe/jev-1.13'))
  assert.ok(isWorkshopAiModel('other/stt-9'))
  assert.ok(isWorkshopAiKey(SECRET))
  assert.ok(!isWorkshopAiKey('too short'))
  for (const mutate of [
    (value) => (value.schema = 2),
    (value) => (value.revision = -1),
    (value) => (value.revision = 1.5),
    (value) => (value.enabled = 'yes'),
    (value) => delete value.enabled,
    (value) => (value.extra = true),
    (value) => delete value.provider,
    (value) => (value.provider = 'direct'),
    (value) => (value.generationModel = 'no-slash-here'),
    (value) => (value.generationModel = `a/${'x'.repeat(128)}`),
    (value) => (value.generationModel = 'a/b c'),
    (value) => (value.transcriptionModel = ''),
    (value) => (value.transcriptionModel = 42),
    (value) => (value.maxBlocks = 0),
    (value) => (value.maxBlocks = 32769),
    (value) => (value.blocksPerTick = 16385),
    (value) => (value.minimumBuildTicks = 39),
    (value) => (value.applyBudgetMs = 21),
    (value) => (value.hourlyRequestLimit = 0),
    (value) => (value.hourlyPlayerRequestLimit = 1_000_001),
    (value) => (value.maxHourlyBuilders = 4097),
    (value) => (value.generationMaxPricePromptUsdPerM = -0.1),
    (value) => (value.generationMaxPriceCompletionUsdPerM = '0.2'),
    (value) => (value.generationModel = 'vendor:x/model'),
    (value) => (value.providers = 'nope'),
    (value) => (value.providers = [{ id: 'Bad_Id', label: 'X', baseUrl: 'https://x.example.com' }]),
    (value) =>
      (value.providers = [{ id: 'openrouter', label: 'X', baseUrl: 'https://x.example.com' }]),
    (value) => (value.providers = [{ id: 'ai', label: 'X', baseUrl: 'https://x.example.com' }]),
    (value) =>
      (value.providers = [{ id: 'ai-gateway', label: 'X', baseUrl: 'https://x.example.com' }]),
    (value) =>
      (value.providers = [
        { id: 'a', label: 'A', baseUrl: 'https://a.example.com' },
        { id: 'a', label: 'B', baseUrl: 'https://b.example.com' },
      ]),
    (value) => (value.providers = [{ id: 'a', label: '', baseUrl: 'https://a.example.com' }]),
    (value) => (value.providers = [{ id: 'a', label: 'A', baseUrl: 'http://a.example.com' }]),
    (value) =>
      (value.providers = [{ id: 'a', label: 'A', baseUrl: 'https://a.example.com/?key=1' }]),
    (value) =>
      (value.providers = Array.from({ length: 9 }, (_, index) => ({
        id: `p${index}`,
        label: `P${index}`,
        baseUrl: 'https://x.example.com',
      }))),
    (value) => (value.generationProvider = 'ghost'),
    (value) => (value.transcriptionProvider = 'ghost'),
    (value) => (value.cleanupProvider = 'ghost'),
    (value) => (value.cleanupModel = 'bad model!'),
  ]) {
    const invalid = settings()
    mutate(invalid)
    rejected(() => validateWorkshopAiSettings(invalid))
  }
  // Native ids stay rejected on presets and on malformed input.
  for (const mutate of [
    (value) => (value.generationModel = 'gpt-4o-mini'),
    (value) => {
      value.transcriptionProvider = 'openrouter'
      value.transcriptionModel = 'gpt-4o-mini'
    },
    (value) => {
      value.cleanupProvider = 'openrouter'
      value.cleanupModel = 'gpt-4o-mini'
    },
    (value) => (value.transcriptionModel = 'has space'),
    (value) => (value.transcriptionModel = 'bad!chars'),
    (value) => (value.transcriptionModel = 'x'.repeat(101)),
  ]) {
    const native = settings()
    mutate(native)
    rejected(() => validateWorkshopAiSettings(native))
  }
})

test('custom providers accept native model ids keyed by the selected provider', () => {
  // The fixture routes transcription and cleanup through the custom registry entry.
  const transcriptionNative = settings()
  transcriptionNative.transcriptionModel = 'gpt-4o-mini'
  assert.equal(validateWorkshopAiSettings(transcriptionNative).transcriptionModel, 'gpt-4o-mini')
  const cleanupNative = settings()
  cleanupNative.cleanupModel = 'gpt-4o-mini'
  assert.equal(validateWorkshopAiSettings(cleanupNative).cleanupModel, 'gpt-4o-mini')
  const generationNative = settings()
  generationNative.generationProvider = 'my-proxy'
  generationNative.generationModel = 'gpt-4o-mini'
  assert.equal(validateWorkshopAiSettings(generationNative).generationModel, 'gpt-4o-mini')
  // Custom providers still accept the previous vendor/name shape, including long ids.
  const legacyLong = settings()
  legacyLong.transcriptionModel = `vendor/${'x'.repeat(112)}`
  assert.equal(
    validateWorkshopAiSettings(legacyLong).transcriptionModel,
    `vendor/${'x'.repeat(112)}`,
  )
})

test('missing file returns defaults with revision 0; corrupt or oversized files fail closed', (t) => {
  const directory = temp(t)
  assert.deepEqual(readWorkshopAiSettings(directory), {
    schema: 1,
    revision: 0,
    enabled: false,
    provider: 'openrouter',
    generationProvider: 'openrouter',
    transcriptionProvider: 'openrouter',
    providers: [],
    generationModel: 'meta/muse-spark-1.3-contributor',
    transcriptionModel: 'openai/whisper-1',
    cleanupModel: '',
    cleanupProvider: 'openrouter',
    maxBlocks: 16384,
    blocksPerTick: 2048,
    minimumBuildTicks: 80,
    applyBudgetMs: 8,
    hourlyRequestLimit: 360,
    hourlyPlayerRequestLimit: 60,
    maxHourlyBuilders: 256,
    generationMaxPricePromptUsdPerM: 0.1,
    generationMaxPriceCompletionUsdPerM: 0.2,
  })
  for (const bytes of [
    '{broken',
    JSON.stringify({ ...settings(), provider: 'direct' }),
    'x'.repeat(4097),
  ]) {
    writeFileSync(join(directory, 'workshop-ai-settings.json'), bytes)
    rejected(() => readWorkshopAiSettings(directory), 503)
    rejected(
      () =>
        saveWorkshopAiSettings(
          directory,
          {
            expectedRevision: 0,
            enabled: false,
            generationModel: 'a/b',
            transcriptionModel: 'openai/whisper-1',
          },
          () => false,
        ),
      503,
    )
    assert.equal(readFileSync(join(directory, 'workshop-ai-settings.json'), 'utf8'), bytes)
  }
})

test('old files without provider/limits/caps load with defaults filled in', (t) => {
  const directory = temp(t)
  writeFileSync(
    join(directory, 'workshop-ai-settings.json'),
    JSON.stringify({
      schema: 1,
      revision: 3,
      enabled: true,
      generationModel: 'vendor/model:free',
      // Retired guard-model keys (ws#53) load and are dropped.
      guardModel: 'typesafe/jev-1.13',
      guardProvider: 'vercel-gateway',
      inputGuardEnabled: true,
      transcriptionModel: 'openai/whisper-1',
    }),
  )
  const loaded = readWorkshopAiSettings(directory)
  assert.equal(loaded.revision, 3)
  assert.equal(loaded.provider, 'openrouter')
  assert.equal(loaded.generationProvider, 'openrouter')
  assert.equal(loaded.transcriptionProvider, 'openrouter')
  assert.deepEqual(loaded.providers, [])
  assert.equal(loaded.cleanupModel, '')
  assert.equal(loaded.cleanupProvider, 'openrouter')
  assert.equal(loaded.maxBlocks, 16384)
  assert.equal(loaded.hourlyRequestLimit, 360)
  assert.equal(loaded.generationMaxPricePromptUsdPerM, 0.1)
  assert.equal(loaded.generationMaxPriceCompletionUsdPerM, 0.2)
  for (const key of ['guardModel', 'guardProvider', 'inputGuardEnabled'])
    assert.ok(!(key in loaded), key)
  // Unknown future keys are ignored, not a 503.
  writeFileSync(
    join(directory, 'workshop-ai-settings.json'),
    JSON.stringify({ schema: 1, revision: 4, enabled: false, frobnicator: true }),
  )
  assert.equal(readWorkshopAiSettings(directory).revision, 4)
})

test('pre-registry files follow the legacy provider; cleanup follows transcription', (t) => {
  const directory = temp(t)
  writeFileSync(
    join(directory, 'workshop-ai-settings.json'),
    JSON.stringify({ ...settings(), revision: 5, provider: 'vercel-gateway' }),
  )
  // A stored doc that predates per-model fields resolves them from the legacy provider.
  const stored = JSON.parse(readFileSync(join(directory, 'workshop-ai-settings.json'), 'utf8'))
  for (const key of [
    'generationProvider',
    'transcriptionProvider',
    'providers',
    'cleanupModel',
    'cleanupProvider',
  ])
    delete stored[key]
  writeFileSync(join(directory, 'workshop-ai-settings.json'), JSON.stringify(stored))
  const loaded = readWorkshopAiSettings(directory)
  assert.equal(loaded.generationProvider, 'vercel-gateway')
  assert.equal(loaded.transcriptionProvider, 'vercel-gateway')
  assert.equal(loaded.cleanupProvider, 'vercel-gateway')
  assert.equal(loaded.cleanupModel, '')
  // Direct validation fills the same fallbacks for callers without stored values.
  const direct = validateWorkshopAiSettings({
    schema: 1,
    revision: 0,
    enabled: false,
    provider: 'openrouter',
    generationModel: 'a/b',
    transcriptionModel: 'a/d',
    maxBlocks: 1,
    blocksPerTick: 1,
    minimumBuildTicks: 40,
    applyBudgetMs: 1,
    hourlyRequestLimit: 1,
    hourlyPlayerRequestLimit: 1,
    maxHourlyBuilders: 1,
    generationMaxPricePromptUsdPerM: 0,
    generationMaxPriceCompletionUsdPerM: 0,
  })
  assert.equal(direct.generationProvider, 'openrouter')
  assert.equal(direct.cleanupProvider, 'openrouter')
  assert.equal(direct.cleanupModel, '')
  assert.deepEqual(direct.providers, [])
})

test('settings save uses optimistic revision and rejects unknown keys', (t) => {
  const directory = temp(t)
  const body = {
    expectedRevision: 0,
    enabled: true,
    provider: 'openrouter',
    // An admin tab opened before ws#53 still sends the retired guard keys: accepted, dropped.
    inputGuardEnabled: true,
    generationModel: 'provider/gen-model',
    guardModel: 'other/guard-2',
    transcriptionModel: 'other/stt-9',
    maxBlocks: 1024,
    blocksPerTick: 512,
    minimumBuildTicks: 60,
    applyBudgetMs: 4,
    hourlyRequestLimit: 100,
    hourlyPlayerRequestLimit: 10,
    maxHourlyBuilders: 32,
    generationMaxPricePromptUsdPerM: 0.5,
    generationMaxPriceCompletionUsdPerM: 1.5,
  }
  rejected(() => saveWorkshopAiSettings(directory, body, () => false), 400)
  const saved = saveWorkshopAiSettings(directory, body, () => true)
  assert.equal(saved.revision, 1)
  assert.equal(saved.enabled, true)
  assert.equal(saved.provider, 'openrouter')
  for (const key of ['guardModel', 'guardProvider', 'inputGuardEnabled'])
    assert.ok(!(key in saved), key)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'workshop-ai-settings.json'), 'utf8')), {
    ...saved,
  })
  rejected(
    () => saveWorkshopAiSettings(directory, { ...body, expectedRevision: 0 }, () => true),
    409,
  )
  rejected(() =>
    saveWorkshopAiSettings(directory, { ...body, expectedRevision: 1, extra: 1 }, () => true),
  )
  rejected(() =>
    saveWorkshopAiSettings(
      directory,
      { ...body, expectedRevision: 1, provider: 'direct' },
      () => true,
    ),
  )
  assert.equal(
    JSON.parse(readFileSync(join(directory, 'workshop-ai-settings.json'), 'utf8')).revision,
    1,
  )
})

test('a doc that would overflow the settings file is refused instead of bricking reads', (t) => {
  const directory = temp(t)
  // Field caps fit the request body, but JSON escaping inflates the stored file past 8 KiB.
  const control = '\u0001'
  const providers = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index}`,
    label: `a${control.repeat(79)}`,
    baseUrl: `https://x.example.com/${control.repeat(150)}`,
  }))
  rejected(
    () =>
      saveWorkshopAiSettings(
        directory,
        {
          expectedRevision: 0,
          enabled: false,
          provider: 'openrouter',
          providers,
          generationModel: 'a/b',
          transcriptionModel: 'a/d',
          maxBlocks: 1,
          blocksPerTick: 1,
          minimumBuildTicks: 40,
          applyBudgetMs: 1,
          hourlyRequestLimit: 1,
          hourlyPlayerRequestLimit: 1,
          maxHourlyBuilders: 1,
          generationMaxPricePromptUsdPerM: 0,
          generationMaxPriceCompletionUsdPerM: 0,
        },
        () => true,
      ),
    413,
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

test('ai-key request uses the CP asserted payload and validates keys', () => {
  const actor = { uuid: '1'.repeat(32), name: 'Tester', role: 'admin' }
  const set = prepareWorkshopRequest(actor, { kind: 'ai-key', key: SECRET })
  assert.equal(set.cpKind, 'ai-key')
  assert.equal(set.fields.provider, 'openrouter')
  assert.equal(set.fields.key, SECRET)
  const removed = prepareWorkshopRequest(actor, { kind: 'ai-key', key: null })
  assert.equal(removed.cpKind, 'ai-key')
  assert.equal(removed.fields.provider, 'openrouter')
  assert.equal(removed.fields.key, null)
  rejected(() => prepareWorkshopRequest(actor, { kind: 'ai-key', key: 'short' }))
  rejected(() => prepareWorkshopRequest(actor, { kind: 'ai-key' }))
})

test('key status tolerates the controller document; missing or malformed means unset', () => {
  assert.deepEqual(parseWorkshopAiKeyStatus(null), { set: false })
  assert.deepEqual(
    parseWorkshopAiKeyStatus({
      set: true,
      last4: 'ab12',
      sha256Prefix: 'deadbeef',
      appliedAt: 1728400000000,
    }),
    {
      set: true,
      last4: 'ab12',
      sha256Prefix: 'deadbeef',
      appliedAt: 1728400000000,
    },
  )
  // Newer controller fields never break the site; malformed values mean unset.
  assert.deepEqual(
    parseWorkshopAiKeyStatus({ set: true, last4: 'ab12', ok: true, kind: 'ai-key', next: 1 }),
    { set: true, last4: 'ab12' },
  )
  assert.deepEqual(parseWorkshopAiKeyStatus({ schema: 1, set: true, last4: 'X-y_' }), {
    set: true,
    last4: 'X-y_',
  })
  for (const value of [
    '{broken',
    { set: false },
    { set: true, last4: 'TOOLONG' },
    { set: true, sha256Prefix: 'xyz' },
    { set: true, appliedAt: -1 },
  ]) {
    assert.deepEqual(parseWorkshopAiKeyStatus(value), { set: false })
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

test('owner-only routes: staff below owner are refused, key never leaks, gateway needs no site key', async (t) => {
  const settingsDir = temp(t, 'bf-ai-settings-'),
    environment = { ...process.env },
    store = await database(t)
  const cpState = {
    aiKeys: {},
    results: {},
    posts: [],
    seq: 1,
    settings: { initialized: false, revision: 0, value: {} },
  }
  const mergePatch = (base, patch) => {
    const out = { ...base }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete out[k]
      else if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        out[k] &&
        typeof out[k] === 'object' &&
        !Array.isArray(out[k])
      )
        out[k] = mergePatch(out[k], v)
      else out[k] = v
    }
    return out
  }
  let opCounter = 0
  const cpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/v2/settings/workshop-ai/*') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...cpState.settings, hash: `h${cpState.settings.revision}` }))
          return
        }
        if (req.method === 'PATCH') {
          const parsed = JSON.parse(body)
          if (parsed.expectedRevision !== cpState.settings.revision) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'revision_conflict' }))
            return
          }
          cpState.settings = {
            initialized: true,
            revision: cpState.settings.revision + 1,
            value: mergePatch(cpState.settings.value, parsed.patch ?? {}),
          }
          res.writeHead(202, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              operationId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++opCounter).padStart(12, '0')}`,
              revision: cpState.settings.revision,
            }),
          )
          return
        }
        res.writeHead(405)
        res.end()
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v2/workshop/ai-key') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        cpState.posts.push(parsed)
        const operationId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(++opCounter).padStart(12, '0')}`
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ operationId, revision: null, status: 'accepted' }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v2/workshop/state') {
      const names = (url.searchParams.get('names') ?? '').split(',').filter(Boolean)
      const documents = {}
      if (!names.length || names.includes('ai-keys')) {
        documents['ai-keys'] = {
          name: 'ai-keys',
          revision: cpState.seq,
          seq: cpState.seq,
          updatedAt: 1,
          value: cpState.aiKeys,
        }
      }
      for (const name of names) {
        if (name.startsWith('result:')) {
          const opId = name.slice('result:'.length)
          if (opId in cpState.results) {
            documents[name] = {
              name,
              revision: cpState.seq,
              seq: cpState.seq,
              updatedAt: 1,
              value: cpState.results[opId],
            }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ seq: cpState.seq, documents }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => cpServer.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    cpServer.close()
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
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${cpServer.address().port}`,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_SETTINGS_TOKEN: 'settings-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
  })
  await store.setStaff(admin, 'Tester', 'admin', 'seed')
  await store.setStaff(moderator, 'Tester', 'moderator', 'seed')
  let latestCpRevisions = {}
  const adminBody = (overrides) => ({
    expectedRevision: 0,
    enabled: false,
    provider: 'openrouter',
    generationModel: 'provider/gen',
    transcriptionModel: 'other/stt-9',
    maxBlocks: 1024,
    blocksPerTick: 512,
    minimumBuildTicks: 60,
    applyBudgetMs: 4,
    hourlyRequestLimit: 100,
    hourlyPlayerRequestLimit: 10,
    maxHourlyBuilders: 32,
    generationMaxPricePromptUsdPerM: 0.5,
    generationMaxPriceCompletionUsdPerM: 1.5,
    ...(Object.keys(latestCpRevisions).length ? { cpRevisions: latestCpRevisions } : {}),
    ...overrides,
  })
  const call = async (actor, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${actor}:Tester`
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const res = await handleAdmin(
      { request, url, cookies: { get: () => undefined } },
      path.split('?')[0],
      store,
    ).catch((error) => error)
    if (res.status === 200 && method === 'PUT' && path === 'workshop-ai-settings') {
      const data = await res
        .clone()
        .json()
        .catch(() => null)
      if (data?.cpRevisions) latestCpRevisions = data.cpRevisions
    }
    return res
  }
  for (const [method, path, body] of [
    ['GET', 'workshop-ai-settings', undefined],
    ['PUT', 'workshop-ai-settings', adminBody({})],
    ['GET', 'workshop-ai-key', undefined],
    ['POST', 'workshop-ai-key', { key: SECRET }],
  ]) {
    for (const actor of [admin, moderator]) {
      const response = await call(actor, method, path, body)
      assert.equal(response.status, 403, `${method} ${path} is not owner-only`)
    }
  }
  const initial = await call(owner, 'GET', 'workshop-ai-settings')
  assert.equal(initial.status, 200)
  assert.deepEqual((await initial.json()).settings, {
    schema: 1,
    revision: 0,
    enabled: false,
    provider: 'openrouter',
    generationProvider: 'openrouter',
    transcriptionProvider: 'openrouter',
    providers: [],
    generationModel: 'meta/muse-spark-1.3-contributor',
    transcriptionModel: 'openai/whisper-1',
    cleanupModel: '',
    cleanupProvider: 'openrouter',
    maxBlocks: 16384,
    blocksPerTick: 2048,
    minimumBuildTicks: 80,
    applyBudgetMs: 8,
    hourlyRequestLimit: 360,
    hourlyPlayerRequestLimit: 60,
    maxHourlyBuilders: 256,
    generationMaxPricePromptUsdPerM: 0.1,
    generationMaxPriceCompletionUsdPerM: 0.2,
  })
  const keyless = await call(
    owner,
    'PUT',
    'workshop-ai-settings',
    adminBody({ expectedRevision: 0, enabled: true }),
  )
  assert.equal(keyless.status, 400)
  assert.match((await keyless.json()).error, /ключ OpenRouter/)
  // The gateway key lives in a host file, so enabling it needs no site key.
  // A stale form without per-model keys preserves the stored selections instead:
  // enabling the gateway this way still needs the preserved OpenRouter key.
  const staleGateway = await call(
    owner,
    'PUT',
    'workshop-ai-settings',
    adminBody({ expectedRevision: 0, enabled: true, provider: 'vercel-gateway' }),
  )
  assert.equal(staleGateway.status, 400)
  const gateway = await call(
    owner,
    'PUT',
    'workshop-ai-settings',
    adminBody({
      expectedRevision: 0,
      enabled: true,
      provider: 'vercel-gateway',
      generationProvider: 'vercel-gateway',
      transcriptionProvider: 'vercel-gateway',
    }),
  )
  assert.equal(gateway.status, 200)
  const gatewaySettings = (await gateway.json()).settings
  assert.equal(gatewaySettings.provider, 'vercel-gateway')
  // Explicit per-model keys are stored as sent.
  assert.equal(gatewaySettings.generationProvider, 'vercel-gateway')
  assert.equal(gatewaySettings.cleanupModel, '')
  const saved = await call(owner, 'PUT', 'workshop-ai-settings', adminBody({ expectedRevision: 1 }))
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).settings.revision, 2)
  // Mixed registry: generation on OpenRouter, transcription on a custom endpoint;
  // enabling refuses while the custom key is missing.
  const registry = (overrides) =>
    adminBody({
      expectedRevision: 2,
      enabled: true,
      provider: 'openrouter',
      generationProvider: 'openrouter',
      transcriptionProvider: 'my-proxy',
      providers: [{ id: 'my-proxy', label: 'Proxy', baseUrl: 'https://proxy.example.com/v1' }],
      ...overrides,
    })
  const mixedKeyless = await call(owner, 'PUT', 'workshop-ai-settings', registry({}))
  assert.equal(mixedKeyless.status, 400)
  assert.match((await mixedKeyless.json()).error, /my-proxy/)
  // Unknown referenced providers and bad registry entries fail closed.
  for (const bad of [
    registry({ transcriptionProvider: 'ghost' }),
    registry({ providers: [] }),
    registry({
      providers: [{ id: 'my-proxy', label: 'Proxy', baseUrl: 'http://proxy.example.com/v1' }],
    }),
    registry({ expectedRevision: 2, cleanupModel: 'other/cleanup-1' }),
  ]) {
    const response = await call(owner, 'PUT', 'workshop-ai-settings', bad)
    assert.equal(response.status, 400)
    assert.ok(LEAK(await response.clone().json()))
  }
  // With both referenced keys set, the mixed doc saves; cleanup needs its key too.
  cpState.aiKeys['ai-key.json'] = { schema: 1, set: true, last4: 'ab12' }
  cpState.aiKeys['my-proxy-key.json'] = { schema: 1, set: true, last4: 'cd34' }
  const mixed = await call(owner, 'PUT', 'workshop-ai-settings', registry({}))
  assert.equal(mixed.status, 200)
  const mixedSettings = (await mixed.json()).settings
  assert.equal(mixedSettings.revision, 3)
  assert.equal(mixedSettings.transcriptionProvider, 'my-proxy')
  assert.deepEqual(mixedSettings.providers, [
    { id: 'my-proxy', label: 'Proxy', baseUrl: 'https://proxy.example.com/v1' },
  ])
  const cleanupKeyless = await call(
    owner,
    'PUT',
    'workshop-ai-settings',
    registry({
      expectedRevision: 3,
      cleanupModel: 'other/cleanup-1',
      cleanupProvider: 'second-proxy',
      providers: [
        { id: 'my-proxy', label: 'Proxy', baseUrl: 'https://proxy.example.com/v1' },
        { id: 'second-proxy', label: 'Second', baseUrl: 'https://second.example.com' },
      ],
    }),
  )
  assert.equal(cleanupKeyless.status, 400)
  assert.match((await cleanupKeyless.json()).error, /second-proxy/)
  cpState.aiKeys['second-proxy-key.json'] = { schema: 1, set: true }
  const cleanup = await call(
    owner,
    'PUT',
    'workshop-ai-settings',
    registry({
      expectedRevision: 3,
      cleanupModel: 'other/cleanup-1',
      cleanupProvider: 'second-proxy',
      providers: [
        { id: 'my-proxy', label: 'Proxy', baseUrl: 'https://proxy.example.com/v1' },
        { id: 'second-proxy', label: 'Second', baseUrl: 'https://second.example.com' },
      ],
    }),
  )
  assert.equal(cleanup.status, 200)
  assert.equal((await cleanup.json()).settings.revision, 4)
  // A stale form that omits per-model/registry/cleanup keys preserves them instead
  // of rerouting models to the legacy provider or wiping the registry.
  const stale = await call(
    owner,
    'PUT',
    'workshop-ai-settings',
    adminBody({ expectedRevision: 4, enabled: false }),
  )
  assert.equal(stale.status, 200)
  const staleSettings = (await stale.json()).settings
  assert.equal(staleSettings.revision, 5)
  assert.equal(staleSettings.generationProvider, 'openrouter')
  assert.equal(staleSettings.transcriptionProvider, 'my-proxy')
  assert.equal(staleSettings.cleanupModel, 'other/cleanup-1')
  assert.equal(staleSettings.cleanupProvider, 'second-proxy')
  assert.equal(staleSettings.providers.length, 2)
  // Custom provider keys: owner-only, CP asserted requests, per-id status docs.
  for (const actor of [admin, moderator]) {
    assert.equal(
      (await call(actor, 'GET', 'workshop-ai-provider-key?provider=my-proxy')).status,
      403,
    )
    assert.equal(
      (await call(actor, 'POST', 'workshop-ai-provider-key', { provider: 'my-proxy', key: SECRET }))
        .status,
      403,
    )
  }
  assert.equal((await call(owner, 'GET', 'workshop-ai-provider-key?provider=Bad_Id')).status, 400)
  assert.equal((await call(owner, 'GET', 'workshop-ai-provider-key')).status, 400)
  const customPosted = await call(owner, 'POST', 'workshop-ai-provider-key', {
    provider: 'my-proxy',
    key: SECRET,
  })
  assert.equal(customPosted.status, 200)
  const { id: customId } = await customPosted.json()
  assert.ok(customId)
  const customRequest = cpState.posts.at(-1)
  assert.equal(customRequest.provider, 'my-proxy')
  assert.equal(customRequest.key, SECRET)
  assert.equal(customRequest.actorAccountId, '11111111-1111-1111-1111-111111111111')
  const customStatus = await call(owner, 'GET', 'workshop-ai-provider-key?provider=my-proxy')
  assert.equal(customStatus.status, 200)
  assert.deepEqual((await customStatus.json()).status, {
    set: true,
    last4: 'cd34',
  })
  const customShort = await call(owner, 'POST', 'workshop-ai-provider-key', {
    provider: 'my-proxy',
    key: 'short',
  })
  assert.equal(customShort.status, 400)
  assert.ok(LEAK(await customShort.clone().json()))
  const customBadProvider = await call(owner, 'POST', 'workshop-ai-provider-key', {
    provider: '../x',
    key: SECRET,
  })
  assert.equal(customBadProvider.status, 400)
  assert.ok(LEAK(await customBadProvider.clone().json()))
  // Preset and colliding ids keep their own endpoints: the custom route refuses them,
  // so no inbox request can ever target a preset status file.
  for (const provider of ['openrouter', 'vercel-gateway', 'ai', 'ai-gateway']) {
    const response = await call(owner, 'POST', 'workshop-ai-provider-key', {
      provider,
      key: SECRET,
    })
    assert.equal(response.status, 400)
    assert.ok(LEAK(await response.clone().json()))
  }
  // An id-shaped value that is not a registered provider (e.g. a key pasted into the
  // provider field) is never recorded.
  const idShapedSecret = 'sk-or-v1-0123456789abcdef0123'
  await call(owner, 'POST', 'workshop-ai-provider-key', { provider: idShapedSecret, key: SECRET })
  const customAudit = (await store.auditLog(100)).filter(
    (entry) => entry.action === 'workshop-ai-provider-key',
  )
  assert.ok(customAudit.length >= 1)
  for (const entry of customAudit) {
    assert.ok(LEAK(entry))
    assert.deepEqual(Object.keys(JSON.parse(entry.detail)).sort(), ['provider', 'remove'])
  }
  assert.ok(
    customAudit.some((entry) => entry.ok && JSON.parse(entry.detail).provider === 'my-proxy'),
  )
  // Rejected provider values never reach the audit: only a validated id or null
  // (a bad key with a good id still records the id).
  for (const entry of customAudit.filter((entry) => !entry.ok)) {
    const provider = JSON.parse(entry.detail).provider
    assert.ok(provider === null || isCustomProviderId(provider))
  }
  assert.ok(!customAudit.some((entry) => entry.detail.includes(idShapedSecret)))
  // Limits, models and tariff ceilings are owner-only and admins read the audit
  // log: settings entries keep the operational switches only, never the values.
  for (const entry of (await store.auditLog(50)).filter(
    (entry) => entry.action === 'workshop-ai-settings' && entry.ok,
  ))
    assert.deepEqual(Object.keys(JSON.parse(entry.detail)).sort(), ['enabled', 'provider'])
  // Rows written before the redaction still carry full bodies on disk: the audit
  // feed must project them to the redacted switches for every reader, including admins.
  const legacyBody = adminBody({ expectedRevision: 2 })
  const legacyId = await store.auditPending({
    actorUuid: owner,
    actorName: 'Tester',
    role: 'owner',
    action: 'workshop-ai-settings',
    target: 'revision 3',
    detail: legacyBody,
    ok: false,
    error: null,
  })
  await store.auditFinalize(legacyId, {
    actorUuid: owner,
    actorName: 'Tester',
    role: 'owner',
    action: 'workshop-ai-settings',
    target: 'revision 3',
    detail: legacyBody,
    ok: true,
    error: null,
  })
  const feed = await call(admin, 'GET', 'audit', undefined)
  assert.equal(feed.status, 200)
  const legacyEntry = (await feed.json()).entries.find(
    (entry) => entry.action === 'workshop-ai-settings' && entry.target === 'revision 3',
  )
  assert.deepEqual(legacyEntry.detail, { enabled: false, provider: 'openrouter' })
  assert.equal(
    (await call(owner, 'PUT', 'workshop-ai-settings', adminBody({ expectedRevision: 1 }))).status,
    409,
  )
  const posted = await call(owner, 'POST', 'workshop-ai-key', { key: SECRET })
  assert.equal(posted.status, 200)
  const { id } = await posted.json()
  assert.deepEqual(Object.keys({ id }), ['id'])
  assert.equal(cpState.posts.at(-1).provider, 'openrouter')
  assert.equal(cpState.posts.at(-1).key, SECRET)
  const bad = await call(owner, 'POST', 'workshop-ai-key', { key: 'short' })
  assert.equal(bad.status, 400)
  assert.ok(LEAK(await bad.clone().json()))
  // Pending while the controller has no result yet; corrupt results fail closed.
  // (ai-key.json was set earlier in this test, so the status reads set.)
  const pending = await call(owner, 'GET', 'workshop-ai-key', undefined)
  assert.equal(pending.status, 200)
  assert.deepEqual(await pending.json(), { status: { set: true, last4: 'ab12' }, result: null })
  const pendingId = await call(owner, 'GET', `workshop-ai-key?id=${id}`, undefined)
  assert.deepEqual(await pendingId.json(), {
    status: { set: true, last4: 'ab12' },
    result: null,
  })
  cpState.results[id] = { schema: 1, id, ok: 'yes' }
  assert.equal((await call(owner, 'GET', `workshop-ai-key?id=${id}`, undefined)).status, 503)
  cpState.results[id] = { schema: 1, id, kind: 'ai-key', ok: true, set: true, last4: 'ab12' }
  const done = await call(owner, 'GET', `workshop-ai-key?id=${id}`, undefined)
  assert.equal((await done.json()).result.ok, true)
  assert.equal((await call(owner, 'GET', 'workshop-ai-key?id=nope', undefined)).status, 400)
  // Key tails are owner-only: the generic view-gated result route redacts them for
  // every role, while the owner key-status route keeps the full result.
  cpState.results[id] = {
    schema: 1,
    id,
    kind: 'ai-key',
    ok: true,
    set: true,
    last4: 'ab12',
    sha256Prefix: 'cd34ef56',
  }
  for (const actor of [owner, admin, moderator]) {
    const seen = await call(actor, 'GET', `request?id=${id}`, undefined)
    assert.equal(seen.status, 200)
    const generic = (await seen.json()).result
    assert.ok(!Object.hasOwn(generic, 'last4'))
    assert.ok(!Object.hasOwn(generic, 'sha256Prefix'))
    assert.equal(generic.ok, true)
  }
  const full = await call(owner, 'GET', `workshop-ai-key?id=${id}`, undefined)
  assert.equal((await full.json()).result.last4, 'ab12')
  // The key never lands in settings, responses, errors or audit.
  assert.ok(LEAK(readFileSync(join(settingsDir, 'workshop-ai-settings.json'), 'utf8')))
  for (const entry of await store.auditLog(50)) assert.ok(LEAK(entry))
  const keyAudit = (await store.auditLog(50)).filter((entry) => entry.action === 'workshop-ai-key')
  assert.ok(keyAudit.length >= 1)
  const accepted = keyAudit.filter((entry) => entry.ok)
  assert.ok(accepted.length >= 1)
  // Audit keeps only whether the key was removed, never the key or its tail.
  for (const entry of accepted) assert.deepEqual(JSON.parse(entry.detail), { remove: false })
  cpState.aiKeys['ai-key.json'] = { schema: 1, set: true, last4: 'ab12' }
  const enabled = await call(
    owner,
    'PUT',
    'workshop-ai-settings',
    adminBody({ expectedRevision: 5, enabled: true, provider: 'openrouter' }),
  )
  // With the controller key status set, enabling OpenRouter succeeds.
  assert.equal(enabled.status, 200)
  // The gateway key mirrors the OpenRouter flow, owner-only, with no echo anywhere.
  for (const actor of [admin, moderator]) {
    assert.equal((await call(actor, 'GET', 'workshop-ai-gateway-key')).status, 403)
    assert.equal(
      (await call(actor, 'POST', 'workshop-ai-gateway-key', { key: SECRET })).status,
      403,
    )
  }
  const gatewayPosted = await call(owner, 'POST', 'workshop-ai-gateway-key', { key: SECRET })
  assert.equal(gatewayPosted.status, 200)
  const { id: gatewayId } = await gatewayPosted.json()
  assert.match(gatewayId, /^[0-9a-f-]{36}$/)
  const gatewayRequest = cpState.posts.at(-1)
  assert.equal(gatewayRequest.provider, 'vercel-gateway')
  assert.equal(gatewayRequest.key, SECRET)
  const gatewayStatus = await call(owner, 'GET', 'workshop-ai-gateway-key', undefined)
  assert.equal(gatewayStatus.status, 200)
  assert.deepEqual(await gatewayStatus.json(), { status: { set: false }, result: null })
  const shortGateway = await call(owner, 'POST', 'workshop-ai-gateway-key', { key: 'short' })
  assert.equal(shortGateway.status, 400)
  assert.ok(LEAK(await shortGateway.clone().json()))
  const gatewayAudit = (await store.auditLog(100)).filter(
    (entry) => entry.action === 'workshop-ai-gateway-key',
  )
  assert.ok(gatewayAudit.length >= 1)
  for (const entry of gatewayAudit) {
    assert.ok(LEAK(entry))
    assert.deepEqual(Object.keys(JSON.parse(entry.detail)), ['remove'])
  }
})
