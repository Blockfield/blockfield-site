import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAdmin, readMapCatalog, writeRequest } from '../src/lib/admin.ts'
import { database } from './storage.mjs'

const FIRST = 'a'.repeat(64),
  SECOND = 'b'.repeat(64),
  FOREIGN = 'c'.repeat(64),
  CANDIDATE = 'd'.repeat(32)
const COPY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const BRANCH = 'work-testing'
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
const ref = (mapId, name, versionDigest, generation = 1) => ({
  schema: 1,
  mapId,
  name,
  versionDigest,
  generation,
  workingCopyId: null,
  createdAt: 10,
  createdBy: { draslId: BUILDER, name: 'Builder' },
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
      branches: [ref('custom_arena', 'main', SECOND, 2), ref('custom_arena', BRANCH, FIRST)],
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
  write(directory, 'session', {
    schema: 1,
    id: COPY,
    maps: ['custom_arena'],
    branches: { custom_arena: BRANCH },
  })
  write(directory, 'status', {
    schema: 1,
    phase: 'workshop',
    gate: 'builders',
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
    maps: ['custom_arena'],
    branches: { custom_arena: BRANCH },
  })
  write(directory, 'session', {
    schema: 1,
    id: COPY,
    maps: ['custom_arena'],
    branches: { custom_arena: BRANCH },
    startedBy: null,
  })
  assert.equal(readMapCatalog(directory).session.id, COPY, 'bootstrap editor has no human starter')
  assert.equal(readMapCatalog(directory).session.startedBy, null)
  for (const status of [
    { schema: 1, phase: 'game', desired: { profile: 'game', session: COPY } },
    {
      schema: 1,
      phase: 'workshop',
      desired: { profile: 'workshop', session: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    },
    { schema: 2, phase: 'workshop', desired: { profile: 'workshop', session: COPY } },
    {
      schema: 1,
      phase: 'workshop',
      gate: 'closed',
      desired: { profile: 'workshop', session: COPY },
    },
    { schema: 1, phase: 'test', gate: 'testers', desired: { profile: 'test', session: COPY } },
  ]) {
    write(directory, 'status', status)
    assert.equal(readMapCatalog(directory).available, true)
    assert.equal(Object.hasOwn(readMapCatalog(directory), 'session'), false)
  }
  seed(directory)
  write(directory, 'status', {
    schema: 1,
    phase: 'workshop',
    gate: 'builders',
    desired: { profile: 'workshop', session: COPY },
    game: { phase: 'UNAVAILABLE', gate: 'closed', release: null },
  })
  assert.equal(
    readMapCatalog(directory).session.id,
    COPY,
    'Game outage does not replace the editor copy',
  )
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
  await store.setStaffMaps(BUILDER, ['other'])
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
  assert.equal(pending.branch, BRANCH)
  assert.equal(pending.expectedBranchHead, FIRST)
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

test('Git map catalog retains merge parents and archived branch selections, rejecting malformed refs', (t) => {
  const directory = temp(t)
  seed(directory)
  const catalog = fixture()
  catalog.maps[0].versions[0].parents = [FIRST]
  catalog.sessions = [
    { schema: 1, id: COPY, maps: ['custom_arena'], branches: { custom_arena: BRANCH } },
  ]
  write(directory, 'maps', catalog)
  assert.deepEqual(readMapCatalog(directory).sessions, catalog.sessions)
  for (const mutate of [
    (value) => {
      value.maps[0].versions[0].parents = [FOREIGN]
    },
    (value) => {
      value.maps[0].branches[0].versionDigest = FIRST
    },
    (value) => {
      value.maps[0].branches[1].name = '../outside'
    },
    (value) => {
      value.maps[0].branches[1].workingCopyId = 'not-a-copy'
    },
    (value) => {
      value.sessions[0].branches.custom_arena = 'main'
    },
    (value) => {
      value.sessions[0].maps = ['other']
    },
  ]) {
    const invalid = structuredClone(catalog)
    mutate(invalid)
    write(directory, 'maps', invalid)
    assert.equal(readMapCatalog(directory).available, false)
  }
})

test('scoped Git endpoints bind commits and reviews; main requires exact review target and conflict choices', async (t) => {
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
  await store.setStaffMaps(BUILDER, ['custom_arena'])
  seed(directory)
  const call = async (method, path, body, actor = BUILDER) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${actor}:Tester`
    const url = new URL('http://site/api/admin/' + path),
      request = new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, store).catch(
      (error) => error,
    )
  }
  assert.deepEqual((await (await call('GET', 'maps')).json()).editableMaps, ['custom_arena'])
  const readRequest = async (response) => {
    assert.equal(response.status, 200)
    const { id } = await response.json()
    return JSON.parse(readFileSync(join(inbox, id + '.json')))
  }
  const created = await readRequest(
    await call('POST', 'maps/branches', {
      mapId: 'custom_arena',
      branch: 'layout-b',
      versionDigest: FIRST,
      actor: { role: 'owner' },
    }),
  )
  assert.deepEqual(
    [created.kind, created.actor.draslId, created.branch],
    ['branch-create', BUILDER, 'layout-b'],
  )
  assert.equal(
    (
      await call('POST', 'maps/branches', {
        mapId: 'other',
        branch: 'layout-b',
        versionDigest: FOREIGN,
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await call('POST', 'maps/branches', {
        mapId: 'custom_arena',
        branch: 'main',
        versionDigest: FIRST,
      })
    ).status,
    409,
  )
  const commit = {
    mapId: 'custom_arena',
    branch: BRANCH,
    workingCopyId: COPY,
    expectedBranchHead: FIRST,
    note: 'Move capture point',
  }
  for (const changes of [
    { branch: 'layout-b' },
    { workingCopyId: OWNER },
    { expectedBranchHead: SECOND },
  ])
    assert.equal((await call('POST', 'maps/commit', { ...commit, ...changes })).status, 409)
  const queuedBeforeLongNote = readdirSync(inbox).length
  assert.equal(
    (await call('POST', 'maps/commit', { ...commit, note: 'x'.repeat(201) })).status,
    400,
  )
  assert.equal(readdirSync(inbox).length, queuedBeforeLongNote)
  const saved = await readRequest(await call('POST', 'maps/commit', commit))
  assert.deepEqual(
    [saved.kind, saved.expectedBranchHead, saved.note],
    ['commit', FIRST, commit.note],
  )
  const review = await readRequest(
    await call('POST', 'candidates/create', { mapId: 'custom_arena' }),
  )
  assert.deepEqual(
    [review.kind, review.branch, review.expectedBranchHead, review.workingCopyId],
    ['candidate', BRANCH, FIRST, COPY],
  )
  assert.equal(
    (await call('POST', 'candidates/create', { mapId: 'custom_arena', expectedBranchHead: SECOND }))
      .status,
    409,
  )
  assert.equal(
    (await call('POST', 'maps/compare', { mapId: 'custom_arena', before: FIRST, after: FOREIGN }))
      .status,
    400,
  )
  assert.equal(
    (
      await readRequest(
        await call('POST', 'maps/compare', { mapId: 'custom_arena', before: FIRST, after: SECOND }),
      )
    ).kind,
    'compare',
  )
  const choices = {
    'world/region/r.0.0.mca': 'ours',
    'world/entities/c.-1.0.mcc': 'theirs',
    'map.json#/name': 'theirs',
  }
  const preview = await readRequest(
    await call('POST', 'maps/merge-preview', {
      mapId: 'custom_arena',
      versionDigest: FIRST,
      expectedHead: SECOND,
      resolutions: choices,
    }),
  )
  assert.deepEqual(preview.resolutions, choices)
  const manyChoices = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, index) => [`world/region/r.${index}.0.mca`, 'ours']),
  )
  assert.ok(JSON.stringify(manyChoices).length > 65_536)
  const largeMerge = {
    mapId: 'custom_arena',
    versionDigest: FIRST,
    expectedHead: SECOND,
    resolutions: manyChoices,
  }
  assert.equal(
    Object.keys(
      (await readRequest(await call('POST', 'maps/merge-preview', largeMerge))).resolutions,
    ).length,
    10_000,
  )
  assert.equal(
    (
      await call('POST', 'maps/merge-preview', {
        ...largeMerge,
        resolutions: { ...manyChoices, 'map.json#/overflow': 'ours' },
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await call('POST', 'maps/merge-preview', {
        ...largeMerge,
        padding: 'x'.repeat(8 * 1024 * 1024),
      })
    ).status,
    413,
  )
  assert.equal(
    (
      await call('POST', 'maps/compare', {
        mapId: 'custom_arena',
        before: FIRST,
        after: SECOND,
        padding: 'x'.repeat(65_536),
      })
    ).status,
    413,
  )
  assert.equal(
    (
      await call('POST', 'maps/merge-preview', {
        mapId: 'custom_arena',
        versionDigest: FIRST,
        expectedHead: SECOND,
        resolutions: { '../secret': 'ours' },
      })
    ).status,
    400,
  )
  write(directory, 'candidates', {
    schema: 1,
    candidates: [
      {
        id: CANDIDATE,
        mapId: 'custom_arena',
        versionDigest: FIRST,
        sourceBranch: BRANCH,
        targetHead: SECOND,
        status: 'pending',
      },
    ],
  })
  const publish = { candidateId: CANDIDATE, expectedHead: SECOND, resolutions: choices }
  assert.equal((await call('POST', 'candidates/publish', publish)).status, 403)
  assert.equal(
    (await call('POST', 'candidates/publish', { ...publish, force: true }, OWNER)).status,
    400,
  )
  assert.equal(
    (await call('POST', 'candidates/publish', { ...publish, expectedHead: FIRST }, OWNER)).status,
    409,
  )
  assert.deepEqual(
    (await readRequest(await call('POST', 'candidates/publish', publish, OWNER))).resolutions,
    choices,
  )
  assert.equal(
    Object.keys(
      (
        await readRequest(
          await call('POST', 'candidates/publish', { ...publish, resolutions: manyChoices }, OWNER),
        )
      ).resolutions,
    ).length,
    10_000,
  )
  const noOp = fixture()
  noOp.maps[0].branches[1].versionDigest = SECOND
  write(directory, 'maps', noOp)
  assert.equal((await call('POST', 'candidates/create', { mapId: 'custom_arena' })).status, 409)
})

test('saved drafts are paged through the inbox and resume preserves their immutable selection', async (t) => {
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
    const url = new URL('http://site/api/admin/' + path),
      request = new Request(url, {
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
  const page = await call('POST', 'maps/sessions', { offset: 100, limit: 100 }, BUILDER)
  assert.equal(page.status, 200)
  const { id } = await page.json(),
    request = JSON.parse(readFileSync(join(inbox, id + '.json')))
  assert.deepEqual(
    [request.kind, request.offset, request.limit, request.actor.draslId],
    ['sessions', 100, 100, BUILDER],
  )
  for (const body of [{ offset: -1 }, { offset: 0, limit: 101 }, { offset: '../archive' }])
    assert.equal((await call('POST', 'maps/sessions', body)).status, 400)
  const body = {
    profile: 'workshop',
    session: 'resume',
    sessionId: COPY,
    expectedRevision: 4,
    maps: ['other'],
    branches: { other: 'injected' },
  }
  assert.equal((await call('POST', 'mode', body, BUILDER)).status, 403)
  const resumed = await call('POST', 'mode', body)
  assert.equal(resumed.status, 200)
  const resumedId = (await resumed.json()).id,
    resumedRequest = JSON.parse(readFileSync(join(inbox, resumedId + '.json')))
  assert.equal(resumedRequest.sessionId, COPY)
  assert.equal(Object.hasOwn(resumedRequest, 'maps'), false)
  assert.equal(Object.hasOwn(resumedRequest, 'branches'), false)
  mkdirSync(join(directory, 'results'))
  const payload = {
    mapId: 'custom_arena',
    before: FIRST,
    after: SECOND,
    files: Array.from({ length: 1000 }, (_, index) => ({
      path: `world/region/r.${index}.0.mca`,
      before: FIRST,
      after: SECOND,
      change: 'modified',
    })),
    config: [],
  }
  writeFileSync(
    join(directory, 'results', id + '.json'),
    JSON.stringify({ schema: 1, id, ok: true, payload }),
  )
  assert.deepEqual(
    (await (await call('GET', 'request?id=' + id, undefined, BUILDER)).json()).result.payload,
    payload,
  )
  writeFileSync(
    join(directory, 'results', id + '.json'),
    JSON.stringify({ schema: 1, id: resumedId, ok: true, payload }),
  )
  assert.equal((await call('GET', 'request?id=' + id)).status, 503)
})

test('map creation and rename require authoritative lead access, stable revision and exact copy; test mode belongs to frozen review', async (t) => {
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
  await store.setStaff(BUILDER, 'Tester', 'builder', 'seed')
  const LEAD = '3'.repeat(32),
    ADMIN = '4'.repeat(32)
  await store.setStaff(LEAD, 'Tester', 'moderator', 'seed')
  await store.setStaff(ADMIN, 'Tester', 'admin', 'seed')
  seed(directory)
  const status = {
    schema: 1,
    phase: 'workshop',
    gate: 'builders',
    revision: 4,
    desired: { profile: 'workshop', session: COPY },
  }
  write(directory, 'status', status)
  const call = async (path, body, actor = OWNER) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${actor}:Tester`
    const url = new URL('http://site/api/admin/' + path)
    return handleAdmin(
      {
        request: new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        url,
        cookies: { get: () => undefined },
      },
      path,
      store,
    ).catch((error) => error)
  }
  const read = async (response) => {
    assert.equal(response.status, 200)
    return JSON.parse(readFileSync(join(inbox, (await response.json()).id + '.json')))
  }
  const create = {
    mapId: 'zero_map',
    name: '  Пустая карта  ',
    supportedModes: ['campaign', 'room', 'tdm', 'snipers', 'awp', 'deathmatch', 'training'],
    expectedRevision: 4,
    sessionId: COPY,
    actor: { role: 'owner' },
  }
  assert.equal((await call('maps/create', create, BUILDER)).status, 403)
  for (const actor of [LEAD, ADMIN, OWNER]) {
    const request = await read(await call('maps/create', create, actor))
    assert.equal(request.kind, 'map-create')
    assert.equal(request.name, 'Пустая карта')
    assert.equal(request.actor.draslId, actor)
    assert.notEqual(request.sessionId, COPY)
    assert.match(
      request.sessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    assert.deepEqual(request.supportedModes, create.supportedModes)
  }
  for (const change of [
    { mapId: '_invalid' },
    { mapId: '../world' },
    { name: 'x'.repeat(101) },
    { name: 'bad\nname' },
    { name: '§bad' },
    { supportedModes: [] },
    { supportedModes: ['tdm', 'tdm'] },
    { supportedModes: ['unknown'] },
    { expectedRevision: -1 },
  ])
    assert.equal((await call('maps/create', { ...create, ...change })).status, 400)
  assert.equal((await call('maps/create', { ...create, name: '😀'.repeat(100) })).status, 200)
  assert.equal((await call('maps/create', { ...create, mapId: 'custom_arena' })).status, 409)
  assert.equal((await call('maps/create', { ...create, expectedRevision: 3 })).status, 409)
  write(directory, 'status', { ...status, phase: 'STARTING', gate: 'closed' })
  assert.equal((await call('maps/create', create)).status, 409)
  write(directory, 'status', status)
  const rename = {
    mapId: 'custom_arena',
    name: 'Новое имя',
    workingCopyId: COPY,
    expectedRevision: 4,
  }
  assert.equal((await call('maps/properties', rename, BUILDER)).status, 403)
  assert.equal(
    (
      await call('maps/properties', {
        ...rename,
        workingCopyId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      })
    ).status,
    409,
  )
  assert.deepEqual((await read(await call('maps/properties', rename, LEAD))).name, 'Новое имя')
  write(directory, 'candidates', {
    schema: 1,
    candidates: [
      {
        id: CANDIDATE,
        mapId: 'custom_arena',
        status: 'pending',
        sourceBranch: BRANCH,
        versionDigest: FIRST,
        targetHead: null,
        supportedModes: ['tdm', 'training'],
      },
    ],
  })
  const mode = { profile: 'test', candidateId: CANDIDATE, modeId: 'training', expectedRevision: 4 }
  assert.equal((await call('mode', mode, BUILDER)).status, 403)
  assert.equal((await read(await call('mode', mode, LEAD))).modeId, 'training')
  assert.equal((await call('mode', { ...mode, modeId: 'campaign' })).status, 400)
  assert.equal((await call('mode', { ...mode, modeId: 'unknown' })).status, 400)
  const catalog = fixture()
  catalog.maps[0].head = null
  catalog.maps[0].branches = [ref('custom_arena', BRANCH, FIRST)]
  write(directory, 'maps', catalog)
  const preview = { mapId: 'custom_arena', versionDigest: FIRST, expectedHead: null }
  assert.equal((await read(await call('maps/merge-preview', preview))).expectedHead, null)
  assert.equal(
    (await call('maps/merge-preview', { mapId: 'custom_arena', versionDigest: FIRST })).status,
    400,
  )
  assert.equal(
    (await read(await call('candidates/publish', { candidateId: CANDIDATE, expectedHead: null })))
      .expectedHead,
    null,
  )
  write(directory, 'maps', fixture())
  assert.equal(
    (await call('candidates/publish', { candidateId: CANDIDATE, expectedHead: SECOND })).status,
    409,
  )
})

test('published availability is admin-only, preserves settings/history and refuses stale or malformed updates', async (t) => {
  const directory = temp(t),
    settingsDir = temp(t),
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
    BLOCKFIELD_SETTINGS_DIR: settingsDir,
  })
  await store.setStaff(BUILDER, 'Tester', 'builder', 'seed')
  const LEAD = '3'.repeat(32),
    ADMIN = '4'.repeat(32)
  await store.setStaff(LEAD, 'Tester', 'moderator', 'seed')
  await store.setStaff(ADMIN, 'Tester', 'admin', 'seed')
  seed(directory)
  const initial = {
    schema: 1,
    revision: 4,
    disabledMapIds: ['future-map-id'],
    kits: { retained: { definition: true } },
    fixedModeKits: { room: null },
    gunBalance: { retained: true },
    lobby: { pvpEnabled: false },
  }
  write(settingsDir, 'settings', initial)
  const history = readFileSync(join(directory, 'maps.json'), 'utf8'),
    session = readFileSync(join(directory, 'session.json'), 'utf8')
  const call = async (method, path, body, actor = OWNER) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${actor}:Tester`
    const url = new URL('http://site/api/admin/' + path),
      request = new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, store).catch(
      (error) => error,
    )
  }
  const body = { mapId: 'custom_arena', enabled: false, expectedRevision: 4 }
  for (const actor of [BUILDER, LEAD])
    assert.equal((await call('PUT', 'maps/availability', body, actor)).status, 403)
  for (const mapId of ['other', 'lobby', 'missing'])
    assert.equal((await call('PUT', 'maps/availability', { ...body, mapId })).status, 400)
  const disabled = (await (await call('PUT', 'maps/availability', body, ADMIN)).json()).settings
  assert.equal(disabled.revision, 5)
  assert.deepEqual(disabled.disabledMapIds, ['custom_arena', 'future-map-id'])
  for (const key of ['kits', 'fixedModeKits', 'gunBalance', 'lobby'])
    assert.deepEqual(disabled[key], initial[key])
  const bytes = readFileSync(join(settingsDir, 'settings.json'), 'utf8')
  assert.equal((await call('PUT', 'maps/availability', body)).status, 409)
  assert.equal(readFileSync(join(settingsDir, 'settings.json'), 'utf8'), bytes)
  assert.equal(readFileSync(join(directory, 'maps.json'), 'utf8'), history)
  assert.equal(readFileSync(join(directory, 'session.json'), 'utf8'), session)
  const pending = (await (await call('GET', 'maps', undefined, BUILDER)).json()).availability
  assert.equal(pending.applied, null)
  write(settingsDir, 'applied', {
    revision: 5,
    attemptedRevision: 5,
    errors: [],
    disabledMapIds: disabled.disabledMapIds,
  })
  const observed = (await (await call('GET', 'maps', undefined, BUILDER)).json()).availability
  assert.deepEqual(observed.applied.disabledMapIds, disabled.disabledMapIds)
  const enabled = (
    await (
      await call('PUT', 'maps/availability', { ...body, enabled: true, expectedRevision: 5 })
    ).json()
  ).settings
  assert.deepEqual(enabled.disabledMapIds, ['future-map-id'])
  writeFileSync(join(settingsDir, 'settings.json'), '{corrupt')
  assert.equal(
    (await call('PUT', 'maps/availability', { ...body, expectedRevision: 0 })).status,
    503,
  )
  assert.equal(readFileSync(join(settingsDir, 'settings.json'), 'utf8'), '{corrupt')
})
