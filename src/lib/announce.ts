import { createHash, timingSafeEqual } from 'node:crypto';
import { fail } from './account.ts';
import { rcon } from './rcon.ts';

// The text is fixed here so the deploy token can never turn into an arbitrary RCON command.
export const RESTART_NOTICE = 'tellraw @a {"text":"[Сервер] Через несколько минут сервер перезапустится для обновления.","color":"yellow"}';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Called by the modpack Deploy workflow right before it rolls the game server. */
export async function handleDeployAnnounce(request: Request, env: Record<string, string | undefined> = process.env, send = rcon): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'POST only.');
  const token = env.BLOCKFIELD_DEPLOY_ANNOUNCE_TOKEN;
  if (!token || !env.BLOCKFIELD_RCON_HOST || !env.BLOCKFIELD_RCON_PASSWORD) return fail(503, 'Анонс не настроен.');
  if (!timingSafeEqual(sha256(request.headers.get('authorization') ?? ''), sha256(`Bearer ${token}`))) return fail(401, 'Неверный токен.');
  try {
    await send([RESTART_NOTICE], { host: env.BLOCKFIELD_RCON_HOST, port: Number(env.BLOCKFIELD_RCON_PORT || 25575), password: env.BLOCKFIELD_RCON_PASSWORD });
  } catch (error) {
    console.error('Deploy announce failed', (error as Error).message);
    return fail(502, 'Игровой сервер не отвечает.');
  }
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
