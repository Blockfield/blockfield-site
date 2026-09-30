import type { APIContext } from 'astro'
import { handleDeployAnnounce } from '../../lib/announce'
export const prerender = false
export function ALL({ request }: APIContext) {
  return handleDeployAnnounce(request)
}
