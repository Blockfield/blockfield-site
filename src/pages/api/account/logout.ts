import { closeSession, route, session } from '../../../lib/account.ts'
import { statsStore } from '../../../lib/stats.ts'

// Выход удаляет эту сессию, если она ещё жива, и всегда забывает cookie:
// остальные устройства живут, повторный выход — тоже успех. Drasl-токен живёт
// (ценой сброса умирал бы и лаунчер): его rotate'ит смена пароля.
export const POST = route(async ({ cookies }) => {
  await closeSession(await statsStore(), cookies)
  cookies.delete(session, { path: '/' })
  return new Response(null, { status: 204 })
})
