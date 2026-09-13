import { account, drasl, fail, readJson, route, texture, token } from '../../../lib/account';

export const { PUT, DELETE } = texture('skin');

export const PATCH = route(async ({ request, cookies }) => {
  const { model } = await readJson(request) ?? {};
  if (model !== 'classic' && model !== 'slim') return fail(400, 'Неизвестная модель скина.');
  const auth = token(cookies);
  const { uuid } = account(await drasl('/user', { token: auth }));
  const player = await drasl(`/players/${uuid}`, { method: 'PATCH', token: auth, body: { skinModel: model } });
  return Response.json(account({ username: player.name, players: [player] }));
});
