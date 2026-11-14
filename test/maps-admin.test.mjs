import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAdmin, parseMapCatalog, prepareWorkshopRequest } from '../src/lib/admin.ts'
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
const defaultSession = () => ({
  schema: 1,
  id: COPY,
  maps: ['custom_arena'],
  branches: { custom_arena: BRANCH },
})
const defaultStatus = () => ({
  schema: 1,
  phase: 'workshop',
  gate: 'builders',
  desired: { profile: 'workshop', session: COPY },
})
const defaultCandidates = () => ({
  schema: 1,
  candidates: [
    { id: CANDIDATE, mapId: 'custom_arena', status: 'pending', versionDigest: SECOND },
    { id: 'e'.repeat(32), mapId: 'lobby', status: 'pending' },
  ],
})
async function fakeWorkshopCp(t) {
  const docs = {
    maps: fixture(),
    session: defaultSession(),
    status: defaultStatus(),
    candidates: defaultCandidates(),
  }
  const results = {}
  const posts = []
  const settingsDocs = {
    disabledMapIds: { initialized: false, revision: 0, value: { disabledMapIds: [] } },
  }
  let seq = 1
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const settingsMatch = url.pathname.match(/^\/v2\/settings\/([^/]+)\/\*$/)
    if (settingsMatch) {
      const namespace = decodeURIComponent(settingsMatch[1])
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const entry = settingsDocs[namespace]
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown_namespace' }))
          return
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...entry, hash: `h${entry.revision}` }))
          return
        }
        if (req.method === 'PATCH') {
          const parsed = JSON.parse(body)
          if (parsed.expectedRevision !== entry.revision) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'revision_conflict' }))
            return
          }
          entry.initialized = true
          entry.revision += 1
          entry.value = { ...entry.value, ...(parsed.patch ?? {}) }
          res.writeHead(202, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ operationId: randomUUID(), revision: entry.revision }))
          return
        }
        res.writeHead(405)
        res.end()
      })
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v2/workshop/')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        const operationId = randomUUID()
        const kind = url.pathname.slice('/v2/workshop/'.length)
        posts.push({ id: operationId, kind, body: parsed })
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ operationId, revision: null, status: 'accepted' }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v2/workshop/state') {
      const names = (url.searchParams.get('names') ?? '').split(',').filter(Boolean)
      const documents = {}
      for (const name of names) {
        if (name in docs && docs[name] !== undefined) {
          documents[name] = { name, revision: seq, seq, updatedAt: 1, value: docs[name] }
        } else if (name.startsWith('result:')) {
          const opId = name.slice('result:'.length)
          if (opId in results) {
            documents[name] = { name, revision: seq, seq, updatedAt: 1, value: results[opId] }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ seq, documents }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return {
    server,
    docs,
    results,
    posts,
    env: () => ({
      BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
      BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
      BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: '12345678-1234-4234-8234-123456789012',
    }),
    unpack: (id) => {
      const post = posts.find((entry) => entry.id === id)
      assert.ok(post, `missing CP post ${id}`)
      if (post.kind === 'map')
        return { kind: post.body.mapOp, ...post.body.args, actor: post.body.actor }
      return { kind: post.kind, ...post.body }
    },
  }
}

test('map catalog validates immutable history and binds selected copy to stable workshop status', () => {
  assert.equal(parseMapCatalog(null).available, false)
  const session = defaultSession()
  const statusDoc = defaultStatus()
  assert.deepEqual(parseMapCatalog(fixture(), session, statusDoc).session, {
    schema: 1,
    id: COPY,
    maps: ['custom_arena'],
    branches: { custom_arena: BRANCH },
  })
  assert.equal(
    parseMapCatalog(fixture(), { ...session, startedBy: null }, statusDoc).session.id,
    COPY,
    'bootstrap editor has no human starter',
  )
  assert.equal(
    parseMapCatalog(fixture(), { ...session, startedBy: null }, statusDoc).session.startedBy,
    null,
  )
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
    assert.equal(parseMapCatalog(fixture(), session, status).available, true)
    assert.equal(Object.hasOwn(parseMapCatalog(fixture(), session, status), 'session'), false)
  }
  assert.equal(
    parseMapCatalog(fixture(), session, {
      schema: 1,
      phase: 'workshop',
      gate: 'builders',
      desired: { profile: 'workshop', session: COPY },
      game: { phase: 'UNAVAILABLE', gate: 'closed', release: null },
    }).session.id,
    COPY,
    'Game outage does not replace the editor copy',
  )
  assert.equal(
    parseMapCatalog(fixture(), session, {
      schema: 1,
      phase: 'sleeping',
      gate: 'sleeping',
      desired: { profile: 'workshop', session: COPY },
    }).session.id,
    COPY,
    'a sleeping editor can still commit',
  )
  for (const maps of [['unknown'], ['custom_arena', 'custom_arena'], []]) {
    assert.equal(
      Object.hasOwn(
        parseMapCatalog(fixture(), { schema: 1, id: COPY, maps }, statusDoc),
        'session',
      ),
      false,
    )
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
    assert.equal(parseMapCatalog(catalog, session, statusDoc).available, false)
  }
})

test('CP wire includes exact copies, explicit heads and archived rollback targets', () => {
  const actor = { uuid: OWNER, name: 'Owner', role: 'owner' },
    maps = new Set(['custom_arena'])
  const candidate = prepareWorkshopRequest(
    actor,
    { kind: 'candidate', mapId: 'custom_arena', workingCopyId: COPY, expectedHead: SECOND },
    maps,
  )
  assert.equal(candidate.fields.args.workingCopyId, COPY)
  const commitReview = prepareWorkshopRequest(
    actor,
    {
      kind: 'candidate',
      mapId: 'custom_arena',
      workingCopyId: COPY,
      expectedHead: SECOND,
      commit: true,
      note: 'Укрытия у точки',
    },
    maps,
  )
  assert.equal(commitReview.fields.args.note, 'Укрытия у точки')
  const snapshotCreate = prepareWorkshopRequest(
    actor,
    { kind: 'snapshot-create', mapId: 'custom_arena', name: 'before-final', versionDigest: FIRST },
    maps,
  )
  assert.equal(snapshotCreate.fields.args.name, 'before-final')
  const snapshotDelete = prepareWorkshopRequest(
    actor,
    { kind: 'snapshot-delete', mapId: 'custom_arena', name: 'before-final' },
    maps,
  )
  assert.equal(snapshotDelete.fields.mapOp, 'snapshot-delete')
  const snapshots = prepareWorkshopRequest(
    actor,
    { kind: 'snapshots', mapId: 'custom_arena' },
    maps,
  )
  assert.equal(snapshots.fields.mapOp, 'snapshots')
  const commit = prepareWorkshopRequest(
    actor,
    {
      kind: 'commit',
      mapId: 'custom_arena',
      workingCopyId: COPY,
      expectedHead: SECOND,
      note: 'Укрытия',
    },
    maps,
  )
  assert.equal(commit.fields.args.expectedHead, SECOND)
  const publish = prepareWorkshopRequest(actor, {
    kind: 'publish',
    candidateId: CANDIDATE,
    expectedHead: null,
  })
  assert.equal(publish.fields.args.expectedHead, null)
  const rollback = prepareWorkshopRequest(
    actor,
    { kind: 'rollback', mapId: 'custom_arena', versionDigest: FIRST, expectedHead: SECOND },
    maps,
  )
  assert.deepEqual(
    [rollback.fields.args.versionDigest, rollback.fields.args.expectedHead],
    [FIRST, SECOND],
  )
  for (const body of [
    { kind: 'rollback', mapId: 'custom_arena' },
    { kind: 'rollback', mapId: 'custom_arena', versionDigest: FIRST },
    { kind: 'rollback', mapId: 'custom_arena', versionDigest: FIRST, expectedHead: false },
    { kind: 'candidate', mapId: 'custom_arena', workingCopyId: '../draft' },
    { kind: 'candidate', mapId: 'custom_arena', workingCopyId: COPY },
    { kind: 'candidate', mapId: 'custom_arena', expectedHead: SECOND },
    {
      kind: 'candidate',
      mapId: 'custom_arena',
      workingCopyId: COPY,
      expectedHead: SECOND,
      commit: true,
    },
    { kind: 'commit', mapId: 'custom_arena', workingCopyId: COPY, expectedHead: SECOND },
    {
      kind: 'snapshot-create',
      mapId: 'custom_arena',
      name: 'main',
      versionDigest: FIRST,
    },
    { kind: 'snapshot-create', mapId: 'custom_arena', name: 'before-final' },
    { kind: 'snapshot-delete', mapId: 'custom_arena', name: '../outside' },
    { kind: 'publish', candidateId: CANDIDATE, expectedHead: 'latest' },
  ])
    rejected(() => prepareWorkshopRequest(actor, body, maps))
})

test('map API reads without mutation, derives browser copy, and refuses stale or foreign history writes', async (t) => {
  const cp = await fakeWorkshopCp(t),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    ...cp.env(),
  })
  await store.setStaff(BUILDER, 'Builder', 'builder', 'seed')
  await store.setStaffMaps(BUILDER, ['other'])
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
  assert.deepEqual(cp.posts, [])
  assert.equal(
    (await call('POST', 'candidates/create', { mapId: 'custom_arena' }, BUILDER)).status,
    403,
  )
  // A stale form pins its own copy: a foreign or missing working copy, or a moved
  // head, is refused before anything is posted.
  const queuedBeforeStale = cp.posts.length
  for (const body of [
    { mapId: 'custom_arena', workingCopyId: 'malicious-client-uuid', expectedHead: SECOND },
    { mapId: 'custom_arena', expectedHead: SECOND },
    { mapId: 'custom_arena', workingCopyId: COPY },
    { mapId: 'custom_arena', workingCopyId: COPY, expectedHead: FIRST },
  ])
    assert.equal((await call('POST', 'candidates/create', body)).status, 409)
  assert.equal(cp.posts.length, queuedBeforeStale)
  const created = await call('POST', 'candidates/create', {
    mapId: 'custom_arena',
    workingCopyId: COPY,
    expectedHead: SECOND,
  })
  assert.equal(created.status, 200)
  const id = (await created.json()).id,
    pending = cp.unpack(id)
  assert.equal(pending.workingCopyId, COPY)
  assert.equal(pending.expectedHead, SECOND)
  assert.equal(pending.commit, undefined)
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
  assert.equal(cp.unpack(exportId).kind, 'export')
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
  cp.docs.maps = catalog
  assert.equal(
    (await call('POST', 'maps/export-limbo', { versionDigest: FOREIGN }, BUILDER)).status,
    403,
  )
  for (const versionDigest of [FIRST, '../draft', null])
    assert.equal((await call('POST', 'maps/export-limbo', { versionDigest })).status, 400)
  const limboExport = await call('POST', 'maps/export-limbo', { versionDigest: FOREIGN })
  assert.equal(limboExport.status, 200)
  const limboId = (await limboExport.json()).id,
    limboRequest = cp.unpack(limboId)
  assert.deepEqual(
    [limboRequest.kind, limboRequest.versionDigest, limboRequest.actor.draslId],
    ['limbo-export', FOREIGN, OWNER],
  )
  assert.equal(
    parseMapCatalog(cp.docs.maps, cp.docs.session, cp.docs.status).maps.find(
      (map) => map.mapId === 'limbo',
    ).head,
    null,
  )
  const before = cp.posts.length
  delete cp.docs.maps
  const unavailable = await (await call('GET', 'maps')).json()
  assert.equal(unavailable.available, false)
  assert.equal(Object.hasOwn(unavailable, 'maps'), false)
  assert.equal((await call('POST', 'candidates/create', { mapId: 'custom_arena' })).status, 503)
  assert.equal(cp.posts.length, before)
})

test('native downloads use the mounted package cache and require accepted checksum metadata', async (t) => {
  const cp = await fakeWorkshopCp(t),
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
    ...cp.env(),
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
  cp.docs.candidates = { schema: 1, candidates: [candidate] }
  const response = await download()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Checksum-Sha256'), sha256)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  for (const change of [{ status: 'pending' }, { sha256: null }]) {
    cp.docs.candidates = { schema: 1, candidates: [{ ...candidate, ...change }] }
    assert.equal((await download()).status, 404)
  }
  cp.docs.candidates = { schema: 1, candidates: [candidate] }
  rmSync(join(packages, sha256 + '.zip'))
  assert.equal((await download()).status, 503)
})

test('linear map catalog keeps snapshots beside the head and still reads old branches', () => {
  const session = defaultSession()
  const statusDoc = defaultStatus()
  const catalog = fixture()
  catalog.maps[0].versions[0].parents = [FIRST]
  catalog.maps[0].snapshots = [
    {
      schema: 1,
      mapId: 'custom_arena',
      name: 'before-final',
      versionDigest: FIRST,
      generation: 1,
      createdAt: 10,
      createdBy: { name: 'Builder' },
    },
  ]
  catalog.sessions = [
    { schema: 1, id: COPY, maps: ['custom_arena'], branches: { custom_arena: BRANCH } },
  ]
  assert.deepEqual(parseMapCatalog(catalog, session, statusDoc).sessions, catalog.sessions)
  assert.deepEqual(
    parseMapCatalog(catalog, session, statusDoc).maps[0].snapshots,
    catalog.maps[0].snapshots,
  )
  // A rollout catalog without branches or snapshots reads the same way.
  const linear = structuredClone(catalog)
  delete linear.maps[0].branches
  delete linear.sessions
  assert.equal(parseMapCatalog(linear, session, statusDoc).available, true)
  assert.equal(parseMapCatalog(linear, session, statusDoc).maps[0].snapshots.length, 1)
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
      value.maps[0].snapshots[0].name = 'main'
    },
    (value) => {
      value.maps[0].snapshots[0].versionDigest = FOREIGN
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
    assert.equal(parseMapCatalog(invalid, session, statusDoc).available, false)
  }
})

test('scoped linear endpoints bind commits and reviews; snapshots replace branches', async (t) => {
  const cp = await fakeWorkshopCp(t),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    ...cp.env(),
  })
  await store.setStaff(BUILDER, 'Builder', 'builder', 'seed')
  await store.setStaffMaps(BUILDER, ['custom_arena'])
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
    return cp.unpack(id)
  }
  const created = await readRequest(
    await call('POST', 'maps/snapshots', {
      mapId: 'custom_arena',
      name: 'layout-b',
      versionDigest: FIRST,
      actor: { role: 'owner' },
    }),
  )
  assert.deepEqual(
    [created.kind, created.actor.draslId, created.name],
    ['snapshot-create', BUILDER, 'layout-b'],
  )
  assert.equal(
    (
      await call('POST', 'maps/snapshots', {
        mapId: 'other',
        name: 'layout-b',
        versionDigest: FOREIGN,
      })
    ).status,
    403,
  )
  // A catalog without snapshots seeds one; deleting it posts a CP removal.
  const seeded = fixture()
  seeded.maps[0].snapshots = [
    {
      schema: 1,
      mapId: 'custom_arena',
      name: 'layout-b',
      versionDigest: FIRST,
      generation: 1,
      createdAt: 10,
      createdBy: { name: 'Builder' },
    },
  ]
  cp.docs.maps = seeded
  assert.equal(
    (
      await call('POST', 'maps/snapshots', {
        mapId: 'custom_arena',
        name: 'layout-b',
        versionDigest: SECOND,
      })
    ).status,
    409,
  )
  const deleted = await readRequest(
    await call('POST', 'maps/snapshots', {
      mapId: 'custom_arena',
      action: 'delete',
      name: 'layout-b',
    }),
  )
  assert.deepEqual([deleted.kind, deleted.name], ['snapshot-delete', 'layout-b'])
  assert.equal(
    (
      await call('POST', 'maps/snapshots', {
        mapId: 'custom_arena',
        action: 'delete',
        name: 'nope',
      })
    ).status,
    404,
  )
  cp.docs.maps = fixture()
  assert.equal((await call('POST', 'maps/branches', { mapId: 'custom_arena' })).status, 404)
  assert.equal((await call('POST', 'maps/merge-preview', { mapId: 'custom_arena' })).status, 404)
  const commit = {
    mapId: 'custom_arena',
    workingCopyId: COPY,
    expectedHead: SECOND,
    note: 'Move capture point',
  }
  for (const changes of [{ workingCopyId: OWNER }, { expectedHead: FIRST }])
    assert.equal((await call('POST', 'maps/commit', { ...commit, ...changes })).status, 409)
  const queuedBeforeLongNote = cp.posts.length
  assert.equal(
    (await call('POST', 'maps/commit', { ...commit, note: 'x'.repeat(201) })).status,
    400,
  )
  assert.equal(cp.posts.length, queuedBeforeLongNote)
  const saved = await readRequest(await call('POST', 'maps/commit', commit))
  assert.deepEqual([saved.kind, saved.expectedHead, saved.note], ['commit', SECOND, commit.note])
  assert.equal((await call('POST', 'candidates/create', { mapId: 'custom_arena' })).status, 409)
  assert.equal(
    (
      await call('POST', 'candidates/create', {
        mapId: 'custom_arena',
        workingCopyId: OWNER,
        expectedHead: SECOND,
      })
    ).status,
    409,
  )
  const review = await readRequest(
    await call('POST', 'candidates/create', {
      mapId: 'custom_arena',
      workingCopyId: COPY,
      expectedHead: SECOND,
    }),
  )
  assert.deepEqual(
    [review.kind, review.expectedHead, review.workingCopyId],
    ['candidate', SECOND, COPY],
  )
  assert.equal(
    (await call('POST', 'candidates/create', { mapId: 'custom_arena', expectedHead: FIRST }))
      .status,
    409,
  )
  const saveReview = await readRequest(
    await call('POST', 'candidates/create', {
      mapId: 'custom_arena',
      workingCopyId: COPY,
      expectedHead: SECOND,
      commit: true,
      note: 'Укрытия',
    }),
  )
  assert.deepEqual(
    [saveReview.kind, saveReview.commit, saveReview.note],
    ['candidate', true, 'Укрытия'],
  )
  // An already saved version goes for review without another commit.
  const resend = await readRequest(
    await call('POST', 'candidates/create', {
      mapId: 'custom_arena',
      workingCopyId: COPY,
      expectedHead: SECOND,
      commit: false,
    }),
  )
  assert.deepEqual([resend.kind, resend.commit], ['candidate', false])
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
  cp.docs.candidates = {
    schema: 1,
    candidates: [
      {
        id: CANDIDATE,
        mapId: 'custom_arena',
        versionDigest: FIRST,
        targetHead: SECOND,
        status: 'pending',
      },
    ],
  }
  const publish = { candidateId: CANDIDATE, expectedHead: SECOND }
  assert.equal((await call('POST', 'candidates/publish', publish)).status, 403)
  assert.equal(
    (await call('POST', 'candidates/publish', { ...publish, force: true }, OWNER)).status,
    200,
  )
  assert.equal(
    (await call('POST', 'candidates/publish', { ...publish, expectedHead: FIRST }, OWNER)).status,
    409,
  )
  assert.equal(
    (await readRequest(await call('POST', 'candidates/publish', publish, OWNER))).expectedHead,
    SECOND,
  )
})

test('saved drafts are paged through CP and resume preserves their immutable selection', async (t) => {
  const cp = await fakeWorkshopCp(t),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    ...cp.env(),
  })
  await store.setStaff(BUILDER, 'Builder', 'builder', 'seed')
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
    request = cp.unpack(id)
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
    resumedRequest = cp.unpack(resumedId)
  assert.equal(resumedRequest.sessionId, COPY)
  assert.equal(Object.hasOwn(resumedRequest, 'maps'), false)
  assert.equal(Object.hasOwn(resumedRequest, 'branches'), false)
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
  cp.results[id] = { schema: 1, id, ok: true, payload }
  assert.deepEqual(
    (await (await call('GET', 'request?id=' + id, undefined, BUILDER)).json()).result.payload,
    payload,
  )
  cp.results[id] = { schema: 1, id: resumedId, ok: true, payload }
  assert.equal((await call('GET', 'request?id=' + id)).status, 503)
})

test('map creation and rename require authoritative lead access, stable revision and exact copy; test mode belongs to frozen review', async (t) => {
  const cp = await fakeWorkshopCp(t),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    ...cp.env(),
  })
  await store.setStaff(BUILDER, 'Tester', 'builder', 'seed')
  const LEAD = '3'.repeat(32),
    ADMIN = '4'.repeat(32)
  await store.setStaff(LEAD, 'Tester', 'moderator', 'seed')
  await store.setStaff(ADMIN, 'Tester', 'admin', 'seed')
  const status = {
    schema: 1,
    phase: 'workshop',
    gate: 'builders',
    revision: 4,
    desired: { profile: 'workshop', session: COPY },
  }
  cp.docs.status = status
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
    return cp.unpack((await response.json()).id)
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
  cp.docs.status = { ...status, phase: 'STARTING', gate: 'closed' }
  assert.equal((await call('maps/create', create)).status, 409)
  cp.docs.status = status
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
  cp.docs.candidates = {
    schema: 1,
    candidates: [
      {
        id: CANDIDATE,
        mapId: 'custom_arena',
        status: 'pending',
        versionDigest: FIRST,
        targetHead: null,
        supportedModes: ['tdm', 'training'],
      },
    ],
  }
  const mode = { profile: 'test', candidateId: CANDIDATE, modeId: 'training', expectedRevision: 4 }
  assert.equal((await call('mode', mode, BUILDER)).status, 403)
  assert.equal((await call('mode', mode, LEAD)).status, 403, 'mode switch is admin-only')
  assert.equal((await read(await call('mode', mode, ADMIN))).modeId, 'training')
  assert.equal((await call('mode', { ...mode, modeId: 'campaign' })).status, 400)
  assert.equal((await call('mode', { ...mode, modeId: 'unknown' })).status, 400)
  const catalog = fixture()
  catalog.maps[0].head = null
  catalog.maps[0].branches = [ref('custom_arena', BRANCH, FIRST)]
  catalog.maps[0].snapshots = [
    {
      schema: 1,
      mapId: 'custom_arena',
      name: 'before-final',
      versionDigest: FIRST,
      generation: 1,
      createdAt: 10,
      createdBy: { name: 'Builder' },
    },
  ]
  cp.docs.maps = catalog
  const snapshot = { mapId: 'custom_arena', name: 'before-final', versionDigest: FIRST }
  assert.equal((await read(await call('maps/snapshots', snapshot))).versionDigest, FIRST)
  assert.equal(
    (await call('maps/snapshots', { mapId: 'custom_arena', name: 'before-final' })).status,
    400,
  )
  assert.equal(
    (await read(await call('candidates/publish', { candidateId: CANDIDATE, expectedHead: null })))
      .expectedHead,
    null,
  )
  cp.docs.maps = fixture()
  assert.equal(
    (await call('candidates/publish', { candidateId: CANDIDATE, expectedHead: SECOND })).status,
    409,
  )
})

test('published availability is admin-only, preserves settings/history and refuses stale or malformed updates', async (t) => {
  const cp = await fakeWorkshopCp(t),
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
    ...cp.env(),
    BLOCKFIELD_CP_SETTINGS_TOKEN: 'settings-t',
    BLOCKFIELD_SETTINGS_DIR: settingsDir,
  })
  await store.setStaff(BUILDER, 'Tester', 'builder', 'seed')
  const LEAD = '3'.repeat(32),
    ADMIN = '4'.repeat(32)
  await store.setStaff(LEAD, 'Tester', 'moderator', 'seed')
  await store.setStaff(ADMIN, 'Tester', 'admin', 'seed')
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
  const disabledRes = await (await call('PUT', 'maps/availability', body, ADMIN)).json()
  const disabled = disabledRes.settings
  assert.equal(disabled.revision, 5)
  assert.deepEqual(disabled.disabledMapIds, ['custom_arena', 'future-map-id'])
  for (const key of ['kits', 'fixedModeKits', 'gunBalance', 'lobby'])
    assert.deepEqual(disabled[key], initial[key])
  const bytes = readFileSync(join(settingsDir, 'settings.json'), 'utf8')
  assert.equal((await call('PUT', 'maps/availability', body)).status, 409)
  assert.equal(readFileSync(join(settingsDir, 'settings.json'), 'utf8'), bytes)
  assert.equal(cp.posts.length, 0)
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
      await call('PUT', 'maps/availability', {
        ...body,
        enabled: true,
        expectedRevision: 5,
        cpRevisions: disabledRes.cpRevisions,
      })
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

test('stale-copy way out: snapshot preserves the draft, fresh copy restarts from the head', async (t) => {
  const cp = await fakeWorkshopCp(t),
    environment = { ...process.env },
    store = await database(t),
    MODERATOR = '3'.repeat(32)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    ...cp.env(),
  })
  await store.setStaff(BUILDER, 'Builder', 'builder', 'seed')
  await store.setStaffMaps(BUILDER, ['custom_arena'])
  await store.setStaff(MODERATOR, 'Moderator', 'moderator', 'seed')
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
  const readRequest = async (response) => {
    assert.equal(response.status, 200)
    const { id } = await response.json()
    return cp.unpack(id)
  }
  const snapshotBody = { mapId: 'custom_arena', name: 'stale-draft', workingCopyId: COPY }
  assert.equal((await call('POST', 'maps/snapshot-copy', snapshotBody)).status, 403)
  assert.equal((await call('POST', 'maps/snapshot-copy', snapshotBody, MODERATOR)).status, 403)
  assert.equal(
    (await call('POST', 'maps/snapshot-copy', { ...snapshotBody, name: 'main' }, OWNER)).status,
    400,
  )
  assert.equal(
    (await call('POST', 'maps/snapshot-copy', { ...snapshotBody, workingCopyId: OWNER }, OWNER))
      .status,
    409,
  )
  const snapshot = await readRequest(await call('POST', 'maps/snapshot-copy', snapshotBody, OWNER))
  assert.deepEqual(
    [snapshot.kind, snapshot.mapId, snapshot.name, snapshot.workingCopyId],
    ['snapshot-copy', 'custom_arena', 'stale-draft', COPY],
  )
  // checkout-fresh sends the panel copy; the server mints the new copy id.
  const fresh = await readRequest(
    await call('POST', 'maps/checkout-fresh', { mapId: 'custom_arena', workingCopyId: COPY }),
  )
  assert.equal(fresh.kind, 'checkout-fresh')
  assert.equal(fresh.mapId, 'custom_arena')
  assert.match(
    fresh.workingCopyId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  assert.notEqual(fresh.workingCopyId, COPY)
  assert.equal(
    (await call('POST', 'maps/checkout-fresh', { mapId: 'custom_arena', workingCopyId: OWNER }))
      .status,
    409,
  )
  assert.equal(
    (await call('POST', 'maps/checkout-fresh', { mapId: 'other', workingCopyId: COPY })).status,
    403,
  )
  const maps = new Set(['custom_arena'])
  assert.throws(
    () =>
      prepareWorkshopRequest(
        { uuid: MODERATOR, name: 'Moderator', role: 'moderator' },
        { kind: 'snapshot-copy', mapId: 'custom_arena', name: 'x', workingCopyId: COPY },
        maps,
      ),
    (error) => error instanceof Response && error.status === 403,
  )
  rejected(() =>
    prepareWorkshopRequest(
      { uuid: OWNER, name: 'Owner', role: 'owner' },
      { kind: 'snapshot-copy', mapId: 'custom_arena', name: '../outside', workingCopyId: COPY },
      maps,
    ),
  )
  const direct = prepareWorkshopRequest(
    { uuid: BUILDER, name: 'Builder', role: 'builder' },
    { kind: 'checkout-fresh', mapId: 'custom_arena' },
    maps,
  )
  assert.equal(direct.fields.mapOp, 'checkout-fresh')
  rejected(() =>
    prepareWorkshopRequest(
      { uuid: BUILDER, name: 'Builder', role: 'builder' },
      { kind: 'checkout-fresh', mapId: 'unknown' },
      maps,
    ),
  )
})
