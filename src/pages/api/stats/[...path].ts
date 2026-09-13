import type { APIContext } from 'astro';
import { handleStatsRequest } from '../../../lib/stats';
export const prerender = false;
export function ALL({ request }: APIContext) { return handleStatsRequest(request); }
