import { account, drasl, importMojangSkin, route, session } from '../../../lib/account';

export const GET = route(async ({ cookies }) => {
  const headers = { 'Cache-Control': 'no-store' };
  const value = cookies.get(session)?.value;
  if (!value) return Response.json({ account: null }, { headers });
  try {
    return Response.json({ account: account(await importMojangSkin(value, await drasl('/user', { token: value }))) }, { headers });
  } catch (error) {
    if (!(error instanceof Response) || error.status !== 401) throw error;
    cookies.delete(session, { path: '/' });
    return Response.json({ account: null }, { headers });
  }
});
