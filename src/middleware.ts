import type { MiddlewareHandler } from 'astro'
import { sessionKey } from './lib/account.ts'

// A missing or malformed session secret must fail the deploy, not the first login:
// every request (including the health check) answers 503, so the new container
// never goes healthy and the old build keeps serving.
export const onRequest: MiddlewareHandler = async (_context, next) => {
  sessionKey()
  return next()
}
