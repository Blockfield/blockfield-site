import { route, session } from '../../../lib/account'

// У Drasl один API-токен на пользователя: resetApiToken разлогинил бы и лаунчер, поэтому только забываем cookie.
export const POST = route(async ({ cookies }) => {
  cookies.delete(session, { path: '/' })
  return new Response(null, { status: 204 })
})
