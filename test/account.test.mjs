import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MOJANG_MISS_CAP,
  credentials,
  drasl,
  draslError,
  importMojangSkin,
  mojangMiss,
  pngError,
  readJson,
  readPng,
  rememberMojangMiss,
  route,
  sameOrigin,
  session,
} from '../src/lib/account.ts'
import { statsStore } from '../src/lib/stats.ts'
import { after, singletonDatabase } from './storage.mjs'

after(await singletonDatabase())
import { POST as logout } from '../src/pages/api/account/logout.ts'
import { POST as login } from '../src/pages/api/account/login.ts'
import { POST as password } from '../src/pages/api/account/password.ts'
import { GET as me } from '../src/pages/api/account/me.ts'

const png = (width, height, size = 33) => {
  const bytes = new Uint8Array(size)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

const rejection = (fn) => {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('ожидалась ошибка')
}

const stubFetch = (impl) => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init })
    return impl(url, init)
  }
  return {
    seen,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test('никнейм и пароль проверяются до похода в Drasl', async () => {
  assert.deepEqual(credentials({ username: 'Steve_42', password: '12345678' }), {
    username: 'Steve_42',
    password: '12345678',
  })
  for (const username of ['ab', 'a'.repeat(17), 'bad name', 'Стив', 42]) {
    const error = rejection(() => credentials({ username, password: '12345678' }))
    assert.equal(error.status, 400, String(username))
    assert.match((await error.json()).error, /3–16 символов/)
  }
  assert.equal(rejection(() => credentials({ username: 'Steve', password: '1234567' })).status, 400)
  assert.equal(rejection(() => credentials(null)).status, 400)
})

test('скин — PNG до 1 МиБ размером 64×64 или 64×32, плащ — любой PNG', () => {
  assert.equal(pngError(png(64, 64), true), null)
  assert.equal(pngError(png(64, 32), true), null)
  assert.match(pngError(png(64, 48), true), /64×64/)
  assert.match(pngError(png(128, 128), true), /64×64/)
  assert.equal(pngError(png(64, 32), false), null)
  assert.match(pngError(new TextEncoder().encode('GIF89a not a png at all!!'), false), /PNG/)
  assert.match(pngError(png(64, 64, 1_048_577), true), /1 МиБ/)
})

test('AVIF uploads are rejected even when labelled PNG', async () => {
  const body = Buffer.from(
    '00000020667479706176696600000000617669666d6966316d69616600000000',
    'hex',
  )
  for (const type of ['image/avif', 'image/png']) {
    const request = new Request('http://site/api/account/skin', {
      method: 'PUT',
      headers: { 'content-type': type },
      body,
    })
    await assert.rejects(
      readPng(request, true),
      (error) => error instanceof Response && error.status === 400,
    )
  }
})

test('тело без Content-Length обрывается на лимите, а не читается целиком', async () => {
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024))
    },
  })
  const request = new Request('http://site/api/account/login', {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { 'content-type': 'application/json' },
  })
  const error = await readJson(request).then(
    () => assert.fail('ожидалась ошибка'),
    (e) => e,
  )
  assert.equal(error.status, 413)
})

test('изменяющий запрос принимается только с Origin этого же хоста', async () => {
  const request = (headers) =>
    new Request('http://blockfield.pro/api/account/login', { method: 'POST', headers })
  assert.equal(
    sameOrigin(request({ origin: 'https://blockfield.pro', host: 'blockfield.pro' })),
    true,
    'за nginx протоколы расходятся',
  )
  assert.equal(
    sameOrigin(request({ origin: 'https://evil.example', host: 'blockfield.pro' })),
    false,
  )
  assert.equal(sameOrigin(request({ origin: 'https://blockfield.pro.evil.example' })), false)
  assert.equal(sameOrigin(request({ origin: 'null' })), false)
  assert.equal(sameOrigin(request({})), false, 'без Origin не пускаем')

  let called = false
  const handler = route(async () => {
    called = true
    return new Response()
  })
  const response = await handler({ request: request({ origin: 'https://evil.example' }) })
  assert.equal(response.status, 403)
  assert.equal(called, false)
})

test('ошибки Drasl переводятся, неизвестные показываются как есть', () => {
  assert.equal(draslError(400, 'That username is taken.'), 'Этот никнейм уже занят.')
  assert.equal(draslError(401, 'Incorrect password.'), 'Неверный никнейм или пароль.')
  assert.equal(draslError(401, 'User not found.'), 'Неверный никнейм или пароль.')
  assert.match(draslError(400, 'Invalid password: must be longer than 8 characters'), /не короче 8/)
  assert.match(draslError(400, 'Error using that skin: unexpected EOF'), /скина/)
  assert.match(draslError(429, 'rate limit exceeded'), /Слишком много/)
  assert.equal(draslError(400, 'Something new.'), 'Something new.')
  assert.match(draslError(500), /недоступен/)
})

test('запрос к Drasl несёт токен, а ошибка не раскрывает его', async () => {
  process.env.DRASL_URL = 'http://drasl.test/'
  const stub = stubFetch(async () =>
    Response.json({ message: 'Unknown API token' }, { status: 401 }),
  )
  try {
    const error = await drasl('/user', { token: 'secret-token' }).then(
      () => assert.fail('ожидалась ошибка'),
      (e) => e,
    )
    assert.equal(stub.seen[0].url, 'http://drasl.test/drasl/api/v3/user')
    assert.equal(stub.seen[0].init.headers.Authorization, 'Bearer secret-token')
    assert.equal(error.status, 401)
    const body = await error.text()
    assert.match(body, /Сессия истекла/)
    assert.doesNotMatch(body, /secret-token/)
  } finally {
    stub.restore()
    delete process.env.DRASL_URL
  }
  const down = stubFetch(async () => {
    throw new TypeError('fetch failed')
  })
  try {
    const error = await drasl('/login', { method: 'POST', body: {} }).catch((e) => e)
    assert.equal(error.status, 502)
  } finally {
    down.restore()
  }
})

test('скин с Mojang подтягивается только в пустой лицензионный аккаунт', async () => {
  process.env.DRASL_URL = 'http://drasl.test'
  const user = (username, skinUrl = null) => ({
    username,
    players: [{ uuid: `uuid-${username}`, name: username, skinUrl, capeUrl: null }],
  })
  const textures = Buffer.from(
    JSON.stringify({
      textures: {
        SKIN: { url: 'http://textures.minecraft.net/texture/abc', metadata: { model: 'slim' } },
      },
    }),
  ).toString('base64')
  const stub = stubFetch(async (url, init) => {
    if (url === 'https://api.mojang.com/users/profiles/minecraft/Alex')
      return Response.json({ id: 'a'.repeat(32), name: 'alex' })
    if (url === 'https://api.mojang.com/users/profiles/minecraft/Nobody')
      return new Response(null, { status: 204 })
    if (url === `https://sessionserver.mojang.com/session/minecraft/profile/${'a'.repeat(32)}`)
      return Response.json({ properties: [{ name: 'textures', value: textures }] })
    if (url === 'http://textures.minecraft.net/texture/abc') return new Response(png(64, 64))
    if (url === 'http://drasl.test/drasl/api/v3/players/uuid-Alex' && init.method === 'PATCH')
      return Response.json({})
    if (url === 'http://drasl.test/drasl/api/v3/user')
      return Response.json(user('Alex', 'http://drasl.test/texture/skin/x.png'))
    assert.fail(`неожиданный запрос ${url}`)
  })
  try {
    const refreshed = await importMojangSkin('token', user('Alex'))
    const patch = JSON.parse(stub.seen.find(({ init }) => init?.method === 'PATCH').init.body)
    assert.equal(patch.skinBase64, Buffer.from(png(64, 64)).toString('base64'))
    assert.equal(patch.skinModel, 'slim')
    assert.equal(patch.capeBase64, undefined)
    assert.equal(refreshed.players[0].skinUrl, 'http://drasl.test/texture/skin/x.png')

    stub.seen.length = 0
    const custom = user('Alex', 'http://drasl.test/texture/skin/mine.png')
    assert.equal(await importMojangSkin('token', custom), custom)
    assert.equal(stub.seen.length, 0, 'при своём скине Mojang не трогаем')

    const pirate = user('Nobody')
    assert.equal(await importMojangSkin('token', pirate), pirate)
    assert.equal(await importMojangSkin('token', pirate), pirate)
    assert.equal(stub.seen.length, 1, 'без PATCH, а повтор берётся из кэша')
  } finally {
    stub.restore()
    delete process.env.DRASL_URL
  }
})

const jar = (value) => {
  const calls = {}
  return {
    calls,
    get: (name) => (name === session && value !== undefined ? { value } : undefined),
    set: (name, v, opts) => {
      calls.set = [name, v, opts]
    },
    delete: (name, opts) => {
      calls.delete = [name, opts]
    },
  }
}
const sameSite = (url, body) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(url).origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

test('boot validates the session secret while sessions exist', async (t) => {
  const { StatsStore: Open } = await import('../src/lib/stats.ts')
  const { databaseUrl } = await import('./storage.mjs')
  const { sealTokenRaw } = await import('../src/lib/session-crypto.ts')
  const saved = process.env.BLOCKFIELD_SESSION_SECRET
  t.after(() => {
    if (saved === undefined) delete process.env.BLOCKFIELD_SESSION_SECRET
    else process.env.BLOCKFIELD_SESSION_SECRET = saved
  })
  const url = await databaseUrl(t)
  process.env.BLOCKFIELD_SESSION_SECRET = 'a'.repeat(64)
  const first = await Open.open(url)
  await first.insertSession(
    '0'.repeat(32),
    sealTokenRaw('tok', Buffer.from('a'.repeat(64), 'hex')),
    'u',
    Date.now(),
  )
  await first.close()
  delete process.env.BLOCKFIELD_SESSION_SECRET
  await assert.rejects(Open.open(url), /BLOCKFIELD_SESSION_SECRET/, 'missing secret fails fast')
  process.env.BLOCKFIELD_SESSION_SECRET = 'short'
  await assert.rejects(Open.open(url), /BLOCKFIELD_SESSION_SECRET/, 'malformed secret fails fast')
  process.env.BLOCKFIELD_SESSION_SECRET = 'b'.repeat(64)
  const warn = t.mock.method(console, 'error', () => {})
  const second = await Open.open(url)
  t.after(() => second.close())
  assert.equal(warn.mock.calls.length, 1, 'one rotation notice')
  assert.match(String(warn.mock.calls[0].arguments[0]), /session secret changed/)
})

test('middleware fails the deploy, not the first login, without the secret', async (t) => {
  const { onRequest } = await import('../src/middleware.ts')
  const saved = process.env.BLOCKFIELD_SESSION_SECRET
  t.after(() => {
    if (saved === undefined) delete process.env.BLOCKFIELD_SESSION_SECRET
    else process.env.BLOCKFIELD_SESSION_SECRET = saved
  })
  let next = false
  delete process.env.BLOCKFIELD_SESSION_SECRET
  const refused = await onRequest({}, async () => {
    next = true
    return new Response('ok')
  }).then(
    (r) => r,
    (e) => e,
  )
  assert.equal(next, false)
  assert.equal(refused.status, 503)
  process.env.BLOCKFIELD_SESSION_SECRET = 'c'.repeat(64)
  const ok = await onRequest({}, async () => new Response('ok'))
  assert.equal(await ok.text(), 'ok')
})

test('Drasl tokens are encrypted at rest: the DB never holds plaintext', async () => {
  process.env.BLOCKFIELD_SESSION_SECRET = '2'.repeat(64)
  process.env.DRASL_URL = 'http://drasl.test'
  const user = { username: 'Alex', players: [{ uuid: 'a'.repeat(32), name: 'Alex' }] }
  const stub = stubFetch(async (url) => {
    if (String(url).endsWith('/login'))
      return Response.json({ apiToken: 'stable-drasl-token', user })
    return Response.json(user)
  })
  try {
    const jarred = jar()
    await login({
      request: sameSite('http://site/api/account/login', {
        username: 'Alex',
        password: 'password-1',
      }),
      cookies: jarred,
    })
    const id = jarred.calls.set[1]
    const db = await statsStore()
    const row = await db.getSession(id)
    assert.ok(row && !String(row.token).includes('stable-drasl-token'), 'ciphertext at rest')
    const meAfter = await me({
      request: new Request('http://site/api/account/me'),
      cookies: jar(id),
    })
    assert.equal((await meAfter.json()).account.username, 'Alex', 'sealed sessions still work')
  } finally {
    stub.restore()
    delete process.env.DRASL_URL
  }
})

test('sessions fail closed without the secret, and die on rotation', async () => {
  process.env.DRASL_URL = 'http://drasl.test'
  const user = { username: 'Alex', players: [{ uuid: 'a'.repeat(32), name: 'Alex' }] }
  const stub = stubFetch(async (url) => {
    if (String(url).endsWith('/login'))
      return Response.json({ apiToken: 'stable-drasl-token', user })
    return Response.json(user)
  })
  const loginAs = async (cookies) =>
    login({
      request: sameSite('http://site/api/account/login', {
        username: 'Alex',
        password: 'password-1',
      }),
      cookies,
    })
  try {
    delete process.env.BLOCKFIELD_SESSION_SECRET
    assert.equal((await loginAs(jar())).status, 503, 'no secret, no sessions')
    process.env.BLOCKFIELD_SESSION_SECRET = '3'.repeat(64)
    const cookies = jar()
    assert.equal((await loginAs(cookies)).status, 200)
    const id = cookies.calls.set[1]
    process.env.BLOCKFIELD_SESSION_SECRET = '4'.repeat(64)
    const gone = await me({
      request: new Request('http://site/api/account/me'),
      cookies: jar(id),
    })
    assert.deepEqual(await gone.json(), { account: null }, 'rotation expires old sessions')
  } finally {
    process.env.BLOCKFIELD_SESSION_SECRET = '1'.repeat(64)
    stub.restore()
    delete process.env.DRASL_URL
  }
})
process.env.BLOCKFIELD_SESSION_SECRET = '1'.repeat(64)
process.env.DRASL_URL = 'http://drasl.test'
test('site sessions: login mints an opaque id per device; logout kills only that device', async () => {
  process.env.BLOCKFIELD_SESSION_SECRET = '1'.repeat(64)
  process.env.DRASL_URL = 'http://drasl.test'
  const user = { username: 'Alex', players: [{ uuid: 'a'.repeat(32), name: 'Alex' }] }
  const stub = stubFetch(async (url, init) => {
    if (url === 'http://drasl.test/drasl/api/v3/login' && init.method === 'POST')
      return Response.json({ apiToken: 'stable-drasl-token', user })
    if (url === 'http://drasl.test/drasl/api/v3/user') return Response.json(user)
    assert.fail(`неожиданный запрос ${init?.method} ${url}`)
  })
  try {
    const loginAs = async (cookies) =>
      login({
        request: sameSite('http://site/api/account/login', {
          username: 'Alex',
          password: 'password-1',
        }),
        cookies,
      })
    const meAs = async (id) =>
      (await me({ request: new Request('http://site/api/account/me'), cookies: jar(id) })).json()
    const a = jar(),
      b = jar()
    assert.equal((await loginAs(a)).status, 200)
    assert.equal((await loginAs(b)).status, 200)
    const [idA, idB] = [a.calls.set[1], b.calls.set[1]]
    for (const id of [idA, idB]) assert.match(id, /^[0-9a-f]{32}$/)
    assert.notEqual(idA, idB)
    assert.notEqual(idA, 'stable-drasl-token', 'cookie must not carry the Drasl token')
    assert.equal((await meAs(idA)).account.username, 'Alex')
    assert.equal((await meAs(idB)).account.username, 'Alex')
    assert.ok(
      stub.seen
        .filter(({ url }) => String(url).endsWith('/user'))
        .every(({ init }) => init.headers.Authorization === 'Bearer stable-drasl-token'),
      'Drasl sees the mapped token, never the cookie',
    )
    assert.equal(
      (
        await logout({
          request: sameSite('http://site/api/account/logout'),
          cookies: jar(idA),
        })
      ).status,
      204,
    )
    assert.equal((await meAs(idA)).account, null, 'device A is dead')
    assert.equal((await meAs(idB)).account.username, 'Alex', 'device B survives')
    const c = jar()
    assert.equal((await loginAs(c)).status, 200, 'logout then login works')
    assert.equal((await meAs(c.calls.set[1])).account.username, 'Alex')
  } finally {
    stub.restore()
    delete process.env.DRASL_URL
  }
})

test('logout always clears the cookie and writes nothing without a valid session', async () => {
  process.env.BLOCKFIELD_SESSION_SECRET = '1'.repeat(64)
  const db = await statsStore()
  const before = await db.countSessions()
  for (const value of [undefined, 'nope', 'x'.repeat(200)]) {
    const cookies = jar(value)
    const response = await logout({
      request: sameSite('http://site/api/account/logout'),
      cookies,
    })
    assert.equal(response.status, 204, JSON.stringify(value))
    assert.deepEqual(cookies.calls.delete, [session, { path: '/' }], 'stale cookies are cleared')
  }
  assert.equal(await db.countSessions(), before, 'no unauthenticated inserts')
  const stub = stubFetch(async () => assert.fail('в Drasl ходить не должны'))
  try {
    const response = await me({
      request: new Request('http://site/api/account/me'),
      cookies: jar('x'.repeat(200)),
    })
    assert.deepEqual(await response.json(), { account: null })
  } finally {
    stub.restore()
  }
})

test('password change kills every session and re-logs in', async () => {
  process.env.BLOCKFIELD_SESSION_SECRET = '1'.repeat(64)
  process.env.DRASL_URL = 'http://drasl.test'
  const user = { username: 'Alex', players: [{ uuid: 'a'.repeat(32), name: 'Alex' }] }
  const stub = stubFetch(async (url, init) => {
    if (url === 'http://drasl.test/drasl/api/v3/user' && (!init.method || init.method === 'GET'))
      return Response.json(user)
    if (url === 'http://drasl.test/drasl/api/v3/login' && init.method === 'POST') {
      const body = JSON.parse(init.body)
      if (body.password === 'current-pass-1')
        return Response.json({ apiToken: 'stable-drasl-token', user })
      if (body.password === 'new-pass-22') return Response.json({ apiToken: 'rotated-token', user })
      return Response.json({ message: 'Incorrect password.' }, { status: 401 })
    }
    if (url === 'http://drasl.test/drasl/api/v3/user' && init.method === 'PATCH') {
      const body = JSON.parse(init.body)
      assert.equal(body.password, 'new-pass-22')
      assert.equal(body.resetApiToken, true, 'старый токен должен умереть в Drasl')
      return Response.json({})
    }
    assert.fail(`неожиданный запрос ${init?.method} ${url}`)
  })
  try {
    const loginAs = async (cookies) =>
      login({
        request: sameSite('http://site/api/account/login', {
          username: 'Alex',
          password: 'current-pass-1',
        }),
        cookies,
      })
    const meAs = async (id) =>
      (await me({ request: new Request('http://site/api/account/me'), cookies: jar(id) })).json()
    const a = jar(),
      b = jar()
    await loginAs(a)
    await loginAs(b)
    const [idA, idB] = [a.calls.set[1], b.calls.set[1]]
    const changed = jar(idA)
    const response = await password({
      request: sameSite('http://site/api/account/password', {
        current: 'current-pass-1',
        password: 'new-pass-22',
      }),
      cookies: changed,
    })
    assert.equal(response.status, 204)
    const idNew = changed.calls.set[1]
    assert.match(idNew, /^[0-9a-f]{32}$/)
    assert.equal((await meAs(idA)).account, null, 'first device is dead')
    assert.equal((await meAs(idB)).account, null, 'second device is dead')
    assert.equal((await meAs(idNew)).account.username, 'Alex', 'fresh session works')
  } finally {
    stub.restore()
    delete process.env.DRASL_URL
  }
})

test('site sessions are capped per user', async () => {
  process.env.BLOCKFIELD_SESSION_SECRET = '1'.repeat(64)
  process.env.DRASL_URL = 'http://drasl.test'
  const user = { username: 'Alex', players: [{ uuid: 'a'.repeat(32), name: 'Alex' }] }
  const stub = stubFetch(async (url) => {
    if (String(url).endsWith('/login')) return Response.json({ apiToken: 't', user })
    return Response.json(user)
  })
  try {
    const db = await statsStore()
    const first = jar()
    await login({
      request: sameSite('http://site/api/account/login', {
        username: 'Alex',
        password: 'password-1',
      }),
      cookies: first,
    })
    for (let i = 0; i < 25; i++)
      await login({
        request: sameSite('http://site/api/account/login', {
          username: 'Alex',
          password: 'password-1',
        }),
        cookies: jar(),
      })
    assert.ok((await db.countSessions()) <= 20, 'table stays bounded')
    const dead = await me({
      request: new Request('http://site/api/account/me'),
      cookies: jar(first.calls.set[1]),
    })
    assert.deepEqual((await dead.json()).account, null, 'oldest session was evicted')
  } finally {
    stub.restore()
    delete process.env.DRASL_URL
  }
})

test('промахи Mojang не растут без границ: старые вытесняются, TTL живёт', () => {
  const now = Date.now()
  for (let i = 0; i < MOJANG_MISS_CAP + 500; i++) rememberMojangMiss(`nick${i}`, now)
  assert.equal(mojangMiss('nick0', now), false, 'самый старый вытеснен')
  assert.equal(mojangMiss(`nick${MOJANG_MISS_CAP + 499}`, now), true, 'свежий на месте')
  assert.equal(
    mojangMiss(`nick${MOJANG_MISS_CAP + 499}`, now + 600_001),
    false,
    'просрочка снова идёт в Mojang',
  )
})
