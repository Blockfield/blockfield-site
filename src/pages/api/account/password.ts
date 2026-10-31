import {
  credentials,
  drasl,
  fail,
  readJson,
  route,
  sessionHash,
  sessionToken,
  startSession,
} from '../../../lib/account.ts'
import { statsStore } from '../../../lib/stats.ts'

export const POST = route(async ({ request, cookies }) => {
  const auth = await sessionToken(cookies)
  const body = await readJson(request)
  const { username } = await drasl('/user', { token: auth })
  const { password } = credentials({ username, password: body?.password })
  if (typeof body?.current !== 'string') return fail(400, 'Введите текущий пароль.')
  // Drasl не спрашивает старый пароль, поэтому проверяем его сами: украденная cookie не должна давать сменить пароль.
  await drasl('/login', { method: 'POST', body: { username, password: body.current } }).catch(
    (error) => {
      throw error instanceof Response && error.status === 401
        ? fail(400, 'Текущий пароль указан неверно.')
        : error
    },
  )
  // Смена пароля rotate'ит API-токен: все украденные копии умирают и в Drasl, и на сайте.
  await drasl('/user', { method: 'PATCH', token: auth, body: { password, resetApiToken: true } })
  const store = await statsStore()
  await store.revokeSession(sessionHash(auth))
  const logged = await drasl('/login', { method: 'POST', body: { username, password } })
  startSession(cookies, logged.apiToken)
  return new Response(null, { status: 204 })
})
