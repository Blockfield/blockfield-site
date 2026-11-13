import { createHash, timingSafeEqual } from 'node:crypto'
import { fail } from './account.ts'
import { cpModerationConfigured, postAnnounceCp } from './cp.ts'

const sha256 = (value: string) => createHash('sha256').update(value).digest()

/**
 * Called by the modpack Deploy workflow right before it rolls the game server.
 * The deploy token can only trigger CP `moderation.announce`, whose text is
 * fixed in the game, so it can never become an arbitrary command.
 */
export async function handleDeployAnnounce(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  send: () => Promise<unknown> = () => postAnnounceCp(),
): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'POST only.')
  const token = env.BLOCKFIELD_DEPLOY_ANNOUNCE_TOKEN
  if (!token || !cpModerationConfigured(env)) return fail(503, 'Анонс не настроен.')
  if (
    !timingSafeEqual(sha256(request.headers.get('authorization') ?? ''), sha256(`Bearer ${token}`))
  )
    return fail(401, 'Неверный токен.')
  try {
    await send()
  } catch (error) {
    console.error('Deploy announce failed', (error as Error).message)
    return fail(502, 'Control-plane не принял анонс.')
  }
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
