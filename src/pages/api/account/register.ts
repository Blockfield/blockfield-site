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
  const { username, password } = credentials(await readJson(request))
  const created = await drasl('/users', {
    method: 'POST',
    body: { username, password, playerName: username, requestApiToken: true },
  })
  const user = account(await importMojangSkin(created.apiToken, created.user))
  await startSession(cookies, await statsStore(), created.apiToken, user.uuid)
  return Response.json(user)
})
