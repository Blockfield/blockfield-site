import { route, session, sessionHash } from '../../../lib/account.ts'
import { statsStore } from '../../../lib/stats.ts'

// Выход отзывает сессию на сервере: украденная cookie умирает вместе с выходом.
// Drasl-токен при этом жив (ценой сброса умирал бы и лаунчер): его rotate'ит смена пароля.
export const POST = route(async ({ cookies }) => {
  const value = cookies.get(session)?.value
  if (value) await (await statsStore()).revokeSession(sessionHash(value))
  cookies.delete(session, { path: '/' })
  return new Response(null, { status: 204 })
})
