import {
  account,
  credentials,
  drasl,
  importMojangSkin,
  readJson,
  route,
  startSession,
} from '../../../lib/account.ts'
import { statsStore } from '../../../lib/stats.ts'

export const POST = route(async ({ request, cookies }) => {
  const logged = await drasl('/login', {
    method: 'POST',
    body: credentials(await readJson(request)),
  })
  const user = account(await importMojangSkin(logged.apiToken, logged.user))
  await startSession(cookies, await statsStore(), logged.apiToken, user.uuid)
  return Response.json(user)
})
