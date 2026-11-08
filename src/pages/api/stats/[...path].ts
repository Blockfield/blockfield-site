import type { APIContext } from 'astro'
import { route } from '../../../lib/account'
import { handleAdmin } from '../../../lib/admin'
import { handleStatsRequest } from '../../../lib/stats'
export const prerender = false
const hitreg = route((context) => handleAdmin(context, 'hitreg'))
export function ALL(context: APIContext) {
  // The hit-reg report is staff-only: it goes through the admin guard (session, role, `stats` permission).
  return context.params.path === 'hitreg' ? hitreg(context) : handleStatsRequest(context.request)
}
