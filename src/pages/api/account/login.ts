import { account, credentials, drasl, importMojangSkin, readJson, route, startSession } from '../../../lib/account';

export const POST = route(async ({ request, cookies }) => {
  const logged = await drasl('/login', { method: 'POST', body: credentials(await readJson(request)) });
  startSession(cookies, logged.apiToken);
  return Response.json(account(await importMojangSkin(logged.apiToken, logged.user)));
});
