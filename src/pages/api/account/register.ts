import { account, credentials, drasl, readJson, route, startSession } from '../../../lib/account';

export const POST = route(async ({ request, cookies }) => {
  const { username, password } = credentials(await readJson(request));
  const created = await drasl('/users', { method: 'POST', body: { username, password, playerName: username, requestApiToken: true } });
  startSession(cookies, created.apiToken);
  return Response.json(account(created.user));
});
