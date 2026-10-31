import {
  account,
  credentials,
  drasl,
  fail,
  readJson,
  route,
  sessionToken,
  startSession,
} from '../../../lib/account.ts'
import { statsStore } from '../../../lib/stats.ts'

export const POST = route(async ({ request, cookies }) => {
  const auth = await sessionToken(cookies)
  const body = await readJson(request)
  const { username, uuid } = account(await drasl('/user', { token: auth }))
  const { password } = credentials({ username, password: body?.password })
  if (typeof body?.current !== 'string') return fail(400, 'Введите текущий пароль.')
  // Drasl не спрашивает старый пароль, поэтому проверяем его сами: украденная сессия не должна давать сменить пароль.
  await drasl('/login', { method: 'POST', body: { username, password: body.current } }).catch(
    (error) => {
      throw error instanceof Response && error.status === 401
        ? fail(400, 'Текущий пароль указан неверно.')
        : error
    },
  )
  // Смена пароля rotate'ит API-токен и убивает все сессии пользователя на сайте:
  // украденные копии умирают везде, текущая — перевыпускается ниже.
  await drasl('/user', { method: 'PATCH', token: auth, body: { password, resetApiToken: true } })
  const store = await statsStore()
  await store.deleteUserSessions(uuid)
  const logged = await drasl('/login', { method: 'POST', body: { username, password } })
  await startSession(cookies, store, logged.apiToken, uuid)
  return new Response(null, { status: 204 })
})
