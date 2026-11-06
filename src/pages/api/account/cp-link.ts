import {
  account,
  drasl,
  fail,
  readJson,
  route,
  sealToken,
  sessionId,
  sessionToken,
} from '../../../lib/account.ts'
import { statsStore } from '../../../lib/stats.ts'

// Привязка центральной сессии: сотрудник вставляет токен из файла операциониста,
// сайт проверяет его в CP и хранит запечатанным рядом с сессией. Дальше роль этой
// сессии читается из CP, а выход отзывает и её. Drasl↔CP-связку заводит операционист
// вне сайта: здесь владение токеном и есть личность.
export const POST = route(async ({ request, cookies }) => {
  const store = await statsStore()
  const auth = await sessionToken(cookies, store)
  const { username, uuid } = account(await drasl('/user', { token: auth }))
  const body = await readJson(request, 4096)
  const token =
    typeof body?.token === 'string' && body.token.length >= 8 && body.token.length <= 8192
      ? body.token
      : null
  if (!token) return fail(400, 'Вставьте токен из файла операциониста.')
  const { cpStaffConfigured, readMeCp } = await import('../../../lib/cp.ts')
  if (!cpStaffConfigured()) return fail(503, 'Привязка центра не настроена на сайте.')
  let me
  try {
    me = await readMeCp(token)
  } catch (error) {
    if ((error as { status?: number })?.status === 403)
      return fail(403, 'Центр отклонил токен. Проверьте файл операциониста.')
    return fail(502, 'Control-plane недоступен. Попробуйте позже.')
  }
  await store.setSessionCp(sessionId(cookies), sealToken(token))
  await store.audit({
    actorUuid: String(uuid ?? ''),
    actorName: String(username ?? ''),
    role: 'none',
    action: 'cp-link',
    target: me.accountId,
    detail: { owner: me.owner },
    ok: true,
    error: null,
  })
  return Response.json({ linked: true, accountId: me.accountId })
})

export const DELETE = route(async ({ cookies }) => {
  const store = await statsStore()
  const auth = await sessionToken(cookies, store)
  const { username, uuid } = account(await drasl('/user', { token: auth }))
  await store.setSessionCp(sessionId(cookies), null)
  await store.audit({
    actorUuid: String(uuid ?? ''),
    actorName: String(username ?? ''),
    role: 'none',
    action: 'cp-unlink',
    target: null,
    detail: null,
    ok: true,
    error: null,
  })
  return new Response(null, { status: 204 })
})
