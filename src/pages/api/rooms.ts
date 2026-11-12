import { cachedRooms } from '../../lib/rooms'
export async function GET() {
  return Response.json(await cachedRooms(), { headers: { 'Cache-Control': 'no-store' } })
}
