import { closeSession, route, session } from '../../../lib/account.ts'
import { statsStore } from '../../../lib/stats.ts'

// Выход удаляет только эту сессию: остальные устройства живут, Drasl-токен живёт,
// чужой или просроченный cookie ничего не меняет на сервере.
export const POST = route(async ({ cookies }) => {
  await closeSession(await statsStore(), cookies)
  cookies.delete(session, { path: '/' })
  return new Response(null, { status: 204 })
})
