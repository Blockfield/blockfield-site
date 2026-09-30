import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAdmin, readMapCatalog, writeRequest } from '../src/lib/admin.ts'
import { database } from './storage.mjs'

const FIRST = 'a'.repeat(64),
  SECOND = 'b'.repeat(64),
  FOREIGN = 'c'.repeat(64),
  CANDIDATE = 'd'.repeat(32)
const COPY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OWNER = '1'.repeat(32),
  BUILDER = '2'.repeat(32)
const version = (mapId, versionDigest, parent = null) => ({
  schema: 1,
  mapId,
  kind: 'arena',
  versionDigest,
  parent,
  createdAt: 10,
  author: { name: 'Builder' },
  source: 'candidate',
  sourceId: CANDIDATE,
  note: '',
  worldDigest: FIRST,
  changed: ['world/region/r.0.0.mca'],
  deleted: [],
  fileCount: 2,
})
const fixture = () => ({
  schema: 1,
  maps: [
    {
      mapId: 'custom_arena',
      kind: 'arena',
      mapJson: { id: 'custom_arena', name: 'Custom arena' },
      head: {
        schema: 1,
        mapId: 'custom_arena',
        kind: 'arena',
        versionDigest: SECOND,
        generation: 2,
        bundle: '/ssd/maps/custom_arena/versions/' + SECOND,
        activatedAt: 20,
        activatedBy: { name: 'Owner' },
      },
      versions: [version('custom_arena', SECOND, FIRST), version('custom_arena', FIRST)],
    },
    {
      mapId: 'other',
      kind: 'arena',
      mapJson: { id: 'other' },
      head: null,
      versions: [version('other', FOREIGN)],
    },
    {
      mapId: 'lobby',
      kind: 'lobby',
      mapJson: { id: 'lobby', kind: 'lobby' },
      head: null,
      versions: [],
    },
    {
      mapId: 'limbo',
      kind: 'limbo',
      mapJson: { id: 'limbo', kind: 'limbo' },
      head: null,
      versions: [],
    },
  ],
})
const temp = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bf-map-api-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const write = (directory, name, value) =>
  writeFileSync(join(directory, name + '.json'), JSON.stringify(value))
const rejected = (action) =>
  assert.throws(action, (error) => error instanceof Response && error.status === 400)
function seed(directory) {
  write(directory, 'maps', fixture())
  write(directory, 'session', { schema: 1, id: COPY, maps: ['custom_arena', 'lobby'] })
  write(directory, 'status', {
    schema: 1,
    phase: 'workshop',
    desired: { profile: 'workshop', session: COPY },
  })
  write(directory, 'candidates', {
    schema: 1,
    candidates: [
      { id: CANDIDATE, mapId: 'custom_arena', status: 'pending', versionDigest: SECOND },
      { id: 'e'.repeat(32), mapId: 'lobby', status: 'pending' },
    ],
  })
}

test('map catalog validates immutable history and binds selected copy to stable workshop status', (t) => {
  const directory = temp(t)
  assert.equal(readMapCatalog(directory).available, false)
  seed(directory)
  assert.deepEqual(readMapCatalog(directory).session, {
    schema: 1,
    id: COPY,
    maps: ['custom_arena', 'lobby'],
  })
  for (const status of [
    { schema: 1, phase: 'game', desired: { profile: 'game', session: COPY } },
    {
      schema: 1,
      phase: 'workshop',
      desired: { profile: 'workshop', session: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    },
    { schema: 2, phase: 'workshop', desired: { profile: 'workshop', session: COPY } },
  ]) {
    write(directory, 'status', status)
    assert.equal(readMapCatalog(directory).available, true)
    assert.equal(Object.hasOwn(readMapCatalog(directory), 'session'), false)
  }
  seed(directory)
  for (const maps of [['unknown'], ['custom_arena', 'custom_arena'], []]) {
    write(directory, 'session', { schema: 1, id: COPY, maps })
    assert.equal(Object.hasOwn(readMapCatalog(directory), 'session'), false)
  }
  for (const mutate of [
    (catalog) => {
      catalog.schema = 2
    },
    (catalog) => {
      catalog.maps[0].mapJson.id = 'other'
    },
    (catalog) => {
      catalog.maps[1].mapId = 'custom_arena'
    },
    (catalog) => {
      catalog.maps[0].head.versionDigest = FOREIGN
    },
    (catalog) => {
      catalog.maps[0].versions[0].parent = FOREIGN
    },
    (catalog) => {
      catalog.maps[0].versions[0].files = {}
    },
    (catalog) => {
      catalog.maps[0].versions[0].fileCount = -1
    },
  ]) {
    const catalog = fixture()
    mutate(catalog)
    write(directory, 'maps', catalog)
    assert.equal(readMapCatalog(directory).available, false)
  }
})

test('inbox wire includes exact copies, explicit heads and archived rollback targets', (t) => {
  const directory = temp(t),
    actor = { uuid: OWNER, name: 'Owner', role: 'owner' },
    maps = new Set(['custom_arena'])
  const candidate = writeRequest(
    directory,
    actor,
    { kind: 'candidate', mapId: 'custom_arena', workingCopyId: COPY },
    maps,
  )
  assert.equal(JSON.parse(readFileSync(join(directory, candidate + '.json'))).workingCopyId, COPY)
  const publish = writeRequest(directory, actor, {
    kind: 'publish',
    candidateId: CANDIDATE,
    expectedHead: null,
  })
  assert.equal(JSON.parse(readFileSync(join(directory, publish + '.json'))).expectedHead, null)
  const rollback = writeRequest(
    directory,
    actor,
    { kind: 'rollback', mapId: 'custom_arena', versionDigest: FIRST, expectedHead: SECOND },
    maps,
  )
  const result = JSON.parse(readFileSync(join(directory, rollback + '.json')))
  assert.deepEqual([result.versionDigest, result.expectedHead], [FIRST, SECOND])
  for (const body of [
    { kind: 'rollback', mapId: 'custom_arena' },
    { kind: 'rollback', mapId: 'custom_arena', versionDigest: FIRST },
    { kind: 'rollback', mapId: 'custom_arena', versionDigest: FIRST, expectedHead: false },
    { kind: 'candidate', mapId: 'custom_arena', workingCopyId: '../draft' },
    { kind: 'publish', candidateId: CANDIDATE, expectedHead: 'latest' },
  ])
    rejected(() => writeRequest(directory, actor, body, maps))
  assert.equal(readdirSync(directory).length, 3)
})

test('map API reads without mutation, derives browser copy, and refuses stale or foreign history writes', async (t) => {
  const directory = temp(t),
    inbox = temp(t),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    BLOCKFIELD_ADMIN_DIR: directory,
    BLOCKFIELD_INBOX_DIR: inbox,
  })
  await store.setStaff(BUILDER, 'Builder', 'builder', 'seed')
  seed(directory)
  const call = async (method, path, body, actor = OWNER) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${actor}:Tester`
    const url = new URL('http://site/api/admin/' + path)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, store).catch(
      (error) => error,
    )
  }
  const response = await call('GET', 'maps', undefined, BUILDER)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).maps.length, 4)
  assert.equal((await store.auditLog(5)).length, 0)
  assert.deepEqual(readdirSync(inbox), [])
  assert.equal(
    (await call('POST', 'candidates/create', { mapId: 'custom_arena' }, BUILDER)).status,
    403,
  )
  const created = await call('POST', 'candidates/create', {
    mapId: 'custom_arena',
    workingCopyId: 'malicious-client-uuid',
  })
  assert.equal(created.status, 200)
  const id = (await created.json()).id,
    pending = JSON.parse(readFileSync(join(inbox, id + '.json')))
  assert.equal(pending.workingCopyId, COPY)
  assert.equal(
    (
      await call(
        'POST',
        'candidates/export',
        { candidateId: CANDIDATE, mapId: 'custom_arena' },
        BUILDER,
      )
    ).status,
    403,
  )
  assert.equal(
    (await call('POST', 'candidates/export', { candidateId: CANDIDATE, mapId: 'other' })).status,
    400,
  )
  const exported = await call('POST', 'candidates/export', {
    candidateId: CANDIDATE,
    mapId: 'custom_arena',
  })
  assert.equal(exported.status, 200)
  const exportId = (await exported.json()).id
  assert.equal(JSON.parse(readFileSync(join(inbox, exportId + '.json'))).kind, 'export')
  assert.equal((await call('POST', 'candidates/create', { mapId: 'other' })).status, 409)
  assert.equal((await call('POST', 'candidates/publish', { candidateId: CANDIDATE })).status, 400)
  assert.equal(
    (await call('POST', 'candidates/publish', { candidateId: CANDIDATE, expectedHead: FIRST }))
      .status,
    409,
  )
  assert.equal(
    (await call('POST', 'candidates/publish', { candidateId: CANDIDATE, expectedHead: SECOND }))
      .status,
    200,
  )
  assert.equal(
    (await call('POST', 'candidates/publish', { candidateId: 'e'.repeat(32), expectedHead: null }))
      .status,
    200,
  )
  assert.equal(
    (
      await call('POST', 'candidates/rollback', {
        mapId: 'custom_arena',
        versionDigest: FOREIGN,
        expectedHead: SECOND,
      })
    ).status,
    400,
  )
  assert.equal(
    (await call('POST', 'candidates/rollback', { mapId: 'custom_arena', versionDigest: FIRST }))
      .status,
    400,
  )
  assert.equal(
    (
      await call('POST', 'candidates/rollback', {
        mapId: 'custom_arena',
        versionDigest: FIRST,
        expectedHead: FIRST,
      })
    ).status,
    409,
  )
  assert.equal(
    (
      await call('POST', 'candidates/rollback', {
        mapId: 'custom_arena',
        versionDigest: FIRST,
        expectedHead: SECOND,
      })
    ).status,
    200,
  )
  assert.equal(
    (
      await call('POST', 'maps/rollback', {
        mapId: 'custom_arena',
        versionDigest: FIRST,
        expectedHead: SECOND,
      })
    ).status,
    200,
  )
  const catalog = fixture()
  catalog.maps.find((map) => map.mapId === 'limbo').versions = [
    { ...version('limbo', FOREIGN), kind: 'limbo' },
  ]
  write(directory, 'maps', catalog)
  assert.equal(
    (await call('POST', 'maps/export-limbo', { versionDigest: FOREIGN }, BUILDER)).status,
    403,
  )
  for (const versionDigest of [FIRST, '../draft', null])
    assert.equal((await call('POST', 'maps/export-limbo', { versionDigest })).status, 400)
  const limboExport = await call('POST', 'maps/export-limbo', { versionDigest: FOREIGN })
  assert.equal(limboExport.status, 200)
  const limboId = (await limboExport.json()).id,
    limboRequest = JSON.parse(readFileSync(join(inbox, limboId + '.json')))
  assert.deepEqual(
    [limboRequest.kind, limboRequest.versionDigest, limboRequest.actor.draslId],
    ['limbo-export', FOREIGN, OWNER],
  )
  assert.equal(readMapCatalog(directory).maps.find((map) => map.mapId === 'limbo').head, null)
  const before = readdirSync(inbox).length
  rmSync(join(directory, 'maps.json'))
  const unavailable = await (await call('GET', 'maps')).json()
  assert.equal(unavailable.available, false)
  assert.equal(Object.hasOwn(unavailable, 'maps'), false)
  assert.equal((await call('POST', 'candidates/create', { mapId: 'custom_arena' })).status, 503)
  assert.equal(readdirSync(inbox).length, before)
})

test('native downloads use the mounted package cache and require accepted checksum metadata', async (t) => {
  const directory = temp(t),
    packages = temp(t),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Tester`,
    BLOCKFIELD_ADMIN_DIR: directory,
    BLOCKFIELD_MAP_PACKAGES_DIR: packages,
  })
  const bytes = Buffer.from('checksum-verified derived package'),
    sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(packages, sha256 + '.zip'), bytes)
  const candidate = {
    id: CANDIDATE,
    mapId: 'custom_arena',
    status: 'accepted',
    sha256,
    native: true,
  }
  const download = () => {
    const url = new URL(`http://site/api/admin/candidates/download?id=${CANDIDATE}`)
    return handleAdmin(
      { request: new Request(url), url, cookies: { get: () => undefined } },
      'candidates/download',
      store,
    ).catch((error) => error)
  }
  write(directory, 'candidates', { schema: 1, candidates: [candidate] })
  const response = await download()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Checksum-Sha256'), sha256)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  for (const change of [{ status: 'pending' }, { sha256: null }]) {
    write(directory, 'candidates', { schema: 1, candidates: [{ ...candidate, ...change }] })
    assert.equal((await download()).status, 404)
  }
  write(directory, 'candidates', { schema: 1, candidates: [candidate] })
  rmSync(join(packages, sha256 + '.zip'))
  assert.equal((await download()).status, 503)
})
