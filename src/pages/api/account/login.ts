import { account, credentials, drasl, readJson, route, startSession } from '../../../lib/account';

export const POST = route(async ({ request, cookies }) => {
  const logged = await drasl('/login', { method: 'POST', body: credentials(await readJson(request)) });
  startSession(cookies, logged.apiToken);
  return Response.json(account(logged.user));
});
