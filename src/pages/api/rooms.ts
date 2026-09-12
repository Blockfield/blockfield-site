import { currentRooms } from '../../lib/rooms';
export async function GET() {
  return Response.json(await currentRooms(), { headers: { 'Cache-Control': 'no-store' } });
}
