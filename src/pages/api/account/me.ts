import {
  account,
  drasl,
  importMojangSkin,
  route,
  session,
  sessionToken,
} from '../../../lib/account.ts'
import { statsStore } from '../../../lib/stats.ts'

export const GET = route(async ({ cookies }) => {
  const headers = { 'Cache-Control': 'no-store' }
  const value = cookies.get(session)?.value
  if (!value) return Response.json({ account: null }, { headers })
  try {
    // Отозванная сессия выглядит истёкшей: cookie забываем, в Drasl не ходим.
    const auth = await sessionToken(cookies, await statsStore())
    return Response.json(
      { account: account(await importMojangSkin(auth, await drasl('/user', { token: auth }))) },
      { headers },
    )
  } catch (error) {
    if (!(error instanceof Response) || error.status !== 401) throw error
    cookies.delete(session, { path: '/' })
    return Response.json({ account: null }, { headers })
  }
})
