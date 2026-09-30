import {
  account,
  credentials,
  drasl,
  importMojangSkin,
  readJson,
  route,
  startSession,
} from '../../../lib/account'

export const POST = route(async ({ request, cookies }) => {
  const { username, password } = credentials(await readJson(request))
  const created = await drasl('/users', {
    method: 'POST',
    body: { username, password, playerName: username, requestApiToken: true },
  })
  startSession(cookies, created.apiToken)
  return Response.json(account(await importMojangSkin(created.apiToken, created.user)))
})
