import { credentials, drasl, fail, readJson, route, token } from '../../../lib/account'

export const POST = route(async ({ request, cookies }) => {
  const auth = token(cookies)
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
  await drasl('/user', { method: 'PATCH', token: auth, body: { password } })
  return new Response(null, { status: 204 })
})
