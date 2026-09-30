import { route } from '../../../lib/account'
import { handleAdmin } from '../../../lib/admin'

export const prerender = false
export const ALL = route(async (context) => handleAdmin(context, context.params.path ?? ''))
