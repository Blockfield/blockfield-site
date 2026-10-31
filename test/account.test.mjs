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
  sessionHash,
  sessionToken,
} from '../src/lib/account.ts'
import { statsStore } from '../src/lib/stats.ts'
import { database as store } from './storage.mjs'
import { POST as logout } from '../src/pages/api/account/logout.ts'
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

test('сессия отзывается: хэш стабилен, отозванный токен — как истёкший', async (t) => {
  assert.match(sessionHash('tok'), /^[0-9a-f]{64}$/)
  assert.equal(sessionHash('tok'), sessionHash('tok'))
  assert.notEqual(sessionHash('tok'), sessionHash('other'))
  const s = await store(t)
  assert.equal(await sessionToken(jar('fresh'), s), 'fresh')
  await s.revokeSession(sessionHash('stolen'))
  assert.equal(await s.isSessionRevoked(sessionHash('stolen')), true)
  assert.equal(await s.isSessionRevoked(sessionHash('fresh')), false)
  const error = await sessionToken(jar('stolen'), s).then(
    () => assert.fail('ожидалась ошибка'),
    (e) => e,
  )
  assert.equal(error.status, 401)
})

test('logout запоминает хэш сессии и забывает cookie', async () => {
  process.env.BLOCKFIELD_STATS_DB = ':memory:'
  const cookies = jar('site-token')
  const response = await logout({
    request: sameSite('http://site/api/account/logout'),
    cookies,
  })
  assert.equal(response.status, 204)
  assert.deepEqual(cookies.calls.delete, [session, { path: '/' }])
  const db = await statsStore()
  assert.equal(await db.isSessionRevoked(sessionHash('site-token')), true)
  assert.equal(
    await sessionToken(jar('site-token'), db).then(
      () => 'open',
      () => 'closed',
    ),
    'closed',
  )
})

test('смена пароля rotate’ит токен в Drasl и перевыпускает сессию', async () => {
  process.env.BLOCKFIELD_STATS_DB = ':memory:'
  process.env.DRASL_URL = 'http://drasl.test'
  const cookies = jar('old-token')
  const stub = stubFetch(async (url, init) => {
    if (url === 'http://drasl.test/drasl/api/v3/user' && (!init.method || init.method === 'GET'))
      return Response.json({ username: 'Alex', players: [] })
    if (url === 'http://drasl.test/drasl/api/v3/login' && init.method === 'POST') {
      const body = JSON.parse(init.body)
      if (body.password === 'current-pass-1') return Response.json({})
      if (body.password === 'new-pass-22')
        return Response.json({ apiToken: 'fresh-token', user: { username: 'Alex' } })
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
    const response = await password({
      request: sameSite('http://site/api/account/password', {
        current: 'current-pass-1',
        password: 'new-pass-22',
      }),
      cookies,
    })
    assert.equal(response.status, 204)
    assert.equal(cookies.calls.set[0], session)
    assert.equal(cookies.calls.set[1], 'fresh-token')
    const db = await statsStore()
    assert.equal(await db.isSessionRevoked(sessionHash('old-token')), true)
  } finally {
    stub.restore()
    delete process.env.DRASL_URL
  }
})

test('me с отозванной сессией отдаёт null и не ходит в Drasl', async () => {
  process.env.BLOCKFIELD_STATS_DB = ':memory:'
  const db = await statsStore()
  await db.revokeSession(sessionHash('dead-token'))
  const stub = stubFetch(async () => assert.fail('в Drasl ходить не должны'))
  const cookies = jar('dead-token')
  try {
    const response = await me({
      request: new Request('http://site/api/account/me'),
      cookies,
    })
    assert.deepEqual(await response.json(), { account: null })
    assert.deepEqual(cookies.calls.delete, [session, { path: '/' }])
  } finally {
    stub.restore()
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
