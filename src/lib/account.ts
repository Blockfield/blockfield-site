import type { APIContext, APIRoute, AstroCookies } from 'astro'
import { createHash } from 'node:crypto'
import { statsStore, type StatsStore } from './stats.ts'

export const nickname = /^[A-Za-z0-9_]{3,16}$/
export const session = 'bf_session'
const unavailable = 'Сервер аккаунтов недоступен. Попробуйте позже.'
const taken = 'Этот никнейм уже занят.'
const badLogin = 'Неверный никнейм или пароль.'
const messages: Record<string, string> = {
  'That username is taken.': taken,
  "That username is in use as the name of another user's player.": taken,
  'That player name is taken.': taken,
  "That player name is in use as another user's username.": taken,
  'Incorrect password.': badLogin,
  'User not found.': badLogin,
  'Unknown API token': 'Сессия истекла. Войдите снова.',
  'Account is locked.': 'Аккаунт заблокирован.',
  'That account is locked.': 'Аккаунт заблокирован.',
  'Invalid skin model.': 'Неизвестная модель скина.',
  'Password registration is not allowed.': 'Регистрация сейчас закрыта.',
  'Creating a new player is not allowed.': 'Регистрация сейчас закрыта.',
  'Setting a skin texture is not allowed.': 'Загрузка скинов сейчас отключена.',
  'Setting a cape texture is not allowed.': 'Загрузка плащей сейчас отключена.',
}
const prefixes: [string, string][] = [
  ['Invalid password:', 'Пароль должен быть не короче 8 символов.'],
  ['Invalid username:', 'Никнейм: 3–16 символов, латинские буквы, цифры и _.'],
  ['Invalid player name:', 'Никнейм: 3–16 символов, латинские буквы, цифры и _.'],
  ['Error using that skin', 'Файл скина не подходит: нужен PNG 64×64 или 64×32.'],
  ['Error using that cape', 'Файл плаща не подходит: нужен PNG 64×32.'],
  ['skin size must be', 'Файл скина не подходит: нужен PNG 64×64 или 64×32.'],
  ['cape size must be', 'Файл плаща не подходит: нужен PNG 64×32.'],
]

export function draslError(status: number, message?: unknown): string {
  if (status === 429) return 'Слишком много попыток. Подождите минуту.'
  if (typeof message !== 'string' || !message) return unavailable
  return (
    messages[message] ?? prefixes.find(([prefix]) => message.startsWith(prefix))?.[1] ?? message
  )
}

export const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })

export async function drasl(
  path: string,
  { method = 'GET', token, body }: { method?: string; token?: string; body?: unknown } = {},
): Promise<any> {
  const base = (process.env.DRASL_URL || 'https://skins.blockfield.pro').replace(/\/+$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${base}/drasl/api/v3${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw fail(502, unavailable)
  })
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw fail(
      response.status === 401
        ? 401
        : response.status === 429
          ? 429
          : response.status >= 500
            ? 502
            : 400,
      draslError(response.status, data?.message),
    )
  return data
}

// Сравниваем только хост: за nginx Astro видит http, а браузер присылает Origin с https.
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  try {
    return (
      !!origin &&
      new URL(origin).host === (request.headers.get('host') ?? new URL(request.url).host)
    )
  } catch {
    return false
  }
}

export function credentials(body: any): { username: string; password: string } {
  if (typeof body?.username !== 'string' || !nickname.test(body.username))
    throw fail(400, 'Никнейм: 3–16 символов, латинские буквы, цифры и _.')
  if (typeof body.password !== 'string' || body.password.length < 8)
    throw fail(400, 'Пароль должен быть не короче 8 символов.')
  return { username: body.username, password: body.password }
}

// Content-Length может отсутствовать (chunked), поэтому лимит считаем по мере чтения, а не после.
async function readBody(request: Request, max: number, message: string): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of (request.body ?? []) as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > max) throw fail(413, message)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJson(request: Request, max = 4096): Promise<any> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw fail(415, 'Ожидался JSON.')
  const text = (await readBody(request, max, 'Слишком большой запрос.')).toString()
  try {
    return JSON.parse(text)
  } catch {
    throw fail(400, 'Некорректный запрос.')
  }
}

export function pngError(bytes: Uint8Array, skin: boolean): string | null {
  if (bytes.length > 1_048_576) return 'Файл больше 1 МиБ.'
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (
    bytes.length < 24 ||
    signature.some((byte, i) => bytes[i] !== byte) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR'
  )
    return 'Нужен файл PNG.'
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (skin && !(view.getUint32(16) === 64 && [64, 32].includes(view.getUint32(20))))
    return 'Скин должен быть 64×64 или 64×32 пикселя.'
  return null
}

export async function readPng(request: Request, skin: boolean): Promise<string> {
  if (
    request.headers.get('content-type') !== 'image/png' ||
    Number(request.headers.get('content-length')) > 1_048_576
  )
    throw fail(400, 'Нужен файл PNG до 1 МиБ.')
  const bytes = new Uint8Array(await readBody(request, 1_048_576, 'Файл больше 1 МиБ.'))
  const error = pngError(bytes, skin)
  if (error) throw fail(400, error)
  return Buffer.from(bytes).toString('base64')
}

export function account(user: any) {
  const player = user?.players?.find((p: any) => p.name === user.username) ?? user?.players?.[0]
  return {
    username: user?.username,
    uuid: player?.uuid,
    skinUrl: player?.skinUrl ?? null,
    capeUrl: player?.capeUrl ?? null,
    skinModel: player?.skinModel === 'slim' ? 'slim' : 'classic',
  }
}

const noMojangSkin = new Map<string, number>()
const MOJANG_MISS_TTL = 600_000
/** Miss entries are per login nickname, so the cache is capped: insertion order evicts the oldest. */
export const MOJANG_MISS_CAP = 5000
export const mojangMiss = (key: string, now = Date.now()) => (noMojangSkin.get(key) ?? 0) > now
export function rememberMojangMiss(key: string, now = Date.now()) {
  if (!noMojangSkin.has(key)) {
    for (const [known, expiry] of noMojangSkin) {
      if (noMojangSkin.size < MOJANG_MISS_CAP && expiry > now) break
      noMojangSkin.delete(known)
    }
  }
  noMojangSkin.set(key, now + MOJANG_MISS_TTL)
}
const mojang = (url: string) => fetch(url, { signal: AbortSignal.timeout(5000) })

async function mojangTexture(texture: any, skin: boolean): Promise<string | undefined> {
  if (
    typeof texture?.url !== 'string' ||
    !/^https?:\/\/textures\.minecraft\.net\//.test(texture.url)
  )
    return
  const response = await mojang(texture.url)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (response.ok && !pngError(bytes, skin)) return Buffer.from(bytes).toString('base64')
}

// Drasl выдаёт офлайн-UUID, по которым Mojang скины не отдаёт, поэтому лицензионный скин того же ника переносим сами.
export async function importMojangSkin(token: string, user: any): Promise<any> {
  const { username, uuid, skinUrl } = account(user)
  const key = String(username).toLowerCase()
  if (!uuid || skinUrl || mojangMiss(key)) return user
  try {
    const found = await mojang(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`,
    )
    const profile = found.status === 200 ? await found.json() : null
    if (profile?.name?.toLowerCase() !== key || !/^[0-9a-f]{32}$/.test(profile.id)) throw null
    const session = await (
      await mojang(`https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`)
    ).json()
    const { textures } = JSON.parse(
      Buffer.from(
        session.properties.find((p: any) => p.name === 'textures').value,
        'base64',
      ).toString(),
    )
    const skinBase64 = await mojangTexture(textures.SKIN, true)
    if (!skinBase64) throw null
    const player = user.players.find((p: any) => p.uuid === uuid)
    const capeBase64 = player?.capeUrl
      ? undefined
      : await mojangTexture(textures.CAPE, false).catch(() => undefined)
    await drasl(`/players/${uuid}`, {
      method: 'PATCH',
      token,
      body: {
        skinBase64,
        skinModel: textures.SKIN.metadata?.model === 'slim' ? 'slim' : 'classic',
        capeBase64,
      },
    })
    return await drasl('/user', { token })
  } catch {
    // Any failure counts as "no skin" for 10 minutes, so Mojang is not hammered; the map itself is capped.
    rememberMojangMiss(key)
    return user
  }
}

export function startSession(cookies: AstroCookies, token: string) {
  cookies.set(session, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 30 * 86_400,
  })
}

export function token(cookies: AstroCookies): string {
  const value = cookies.get(session)?.value
  if (!value) throw fail(401, 'Войдите в аккаунт.')
  return value
}

/** SHA-256 of a session token: the revocation list stores only hashes, never tokens. */
export const sessionHash = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

/** Cookie session checked against the server-side revocation list; revoked behaves as expired. */
export async function sessionToken(cookies: AstroCookies, store?: StatsStore): Promise<string> {
  const value = token(cookies)
  if (await (store ?? (await statsStore())).isSessionRevoked(sessionHash(value)))
    throw fail(401, 'Сессия истекла. Войдите снова.')
  return value
}

export function route(handler: (context: APIContext) => Promise<Response>): APIRoute {
  return async (context) => {
    if (context.request.method !== 'GET' && !sameOrigin(context.request))
      return fail(403, 'Запрос отклонён: он отправлен не с этого сайта.')
    try {
      return await handler(context)
    } catch (error) {
      if (!(error instanceof Response)) return fail(500, unavailable)
      if (error.status === 401) context.cookies.delete(session, { path: '/' })
      return error
    }
  }
}

export const texture = (kind: 'skin' | 'cape') => ({
  PUT: route(async ({ request, url, cookies }) => {
    const model = url.searchParams.get('model')
    if (kind === 'skin' && model !== 'classic' && model !== 'slim')
      return fail(400, 'Неизвестная модель скина.')
    const base64 = await readPng(request, kind === 'skin')
    const auth = await sessionToken(cookies)
    const { uuid } = account(await drasl('/user', { token: auth }))
    const body = kind === 'skin' ? { skinBase64: base64, skinModel: model } : { capeBase64: base64 }
    const player = await drasl(`/players/${uuid}`, { method: 'PATCH', token: auth, body })
    return Response.json(account({ username: player.name, players: [player] }))
  }),
  DELETE: route(async ({ cookies }) => {
    const auth = await sessionToken(cookies)
    const { uuid } = account(await drasl('/user', { token: auth }))
    await drasl(`/players/${uuid}`, {
      method: 'PATCH',
      token: auth,
      body: kind === 'skin' ? { deleteSkin: true } : { deleteCape: true },
    })
    return new Response(null, { status: 204 })
  }),
})
