import type { APIContext } from 'astro'
import { handleWorkshopSubmit } from '../../../lib/admin'
export const prerender = false
export async function ALL({ request }: APIContext) {
  try {
    return await handleWorkshopSubmit(request)
  } catch (error) {
    if (error instanceof Response) return error
    throw error
  }
}
