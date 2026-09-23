import type { APIContext } from 'astro';
import { handleWorkshopAccess } from '../../../lib/admin';
export const prerender = false;
export async function ALL({ request }: APIContext) {
  try { return await handleWorkshopAccess(request); } catch (error) { if (error instanceof Response) return error; throw error; }
}
