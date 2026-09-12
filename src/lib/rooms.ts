import net from 'node:net';

export type Room = { id: string; name: string; mode: string; map: string; phase: string; players: number; joinable: boolean };
export type RoomStatus = { available: boolean; checkedAt: number; rooms: Room[] };
export const phases: Record<string, string> = { IDLE: 'Ожидание игроков', VOTING: 'Голосование', PREPARING: 'Подготовка', GAME: 'Бой', MATCH_END: 'Матч завершён' };
export const roomId = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function parseRooms(value: any): RoomStatus {
  if (!value || !Number.isFinite(value.checkedAt) || Math.abs(Date.now() - value.checkedAt) > 30_000 || !Array.isArray(value.rooms)) throw new Error('Room status unavailable');
  const rooms = value.rooms.filter((r: any) => r && roomId.test(r.id) && typeof r.name === 'string' && typeof r.mode === 'string' && typeof r.map === 'string' && r.phase in phases && Number.isInteger(r.players) && r.players >= 0 && typeof r.joinable === 'boolean').slice(0, 100);
  if (rooms.length !== value.rooms.length) throw new Error('Invalid room status');
  return { available: true, checkedAt: value.checkedAt, rooms };
}
export function varint(value: number): Buffer {
  const bytes = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
export function readVarint(data: Buffer, offset = 0): [number, number] | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= data.length) return null;
    const byte = data[offset + i];
    value |= (byte & 127) << (7 * i);
    if (!(byte & 128)) return [value, offset + i + 1];
  }
  throw new Error('Invalid varint');
}
export function queryRooms(host: string, port: number): Promise<RoomStatus> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = Buffer.alloc(0);
    const finish = (error?: Error, value?: RoomStatus) => {
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Server timeout')), 4000);
    socket.on('error', (e) => finish(e));
    socket.on('end', () => finish(new Error('Incomplete response')));
    socket.on('connect', () => {
      const address = Buffer.from(host);
      const targetPort = Buffer.alloc(2); targetPort.writeUInt16BE(port);
      const handshake = Buffer.concat([Buffer.from([0]), varint(767), varint(address.length), address, targetPort, Buffer.from([1])]);
      socket.write(Buffer.concat([varint(handshake.length), handshake, Buffer.from([1, 0])]));
    });
    socket.on('data', (chunk) => {
      try {
        data = Buffer.concat([data, chunk]);
        if (data.length > 1_048_576) throw new Error('Response too large');
        const frame = readVarint(data);
        if (!frame) return;
        if (frame[0] < 1 || frame[0] > 1_048_576) throw new Error('Invalid frame');
        if (data.length < frame[1] + frame[0]) return;
        const packet = data.subarray(frame[1], frame[1] + frame[0]);
        const id = readVarint(packet);
        if (!id || id[0] !== 0) throw new Error('Invalid packet');
        const length = readVarint(packet, id[1]);
        if (!length || length[0] < 0 || length[1] + length[0] !== packet.length) throw new Error('Invalid JSON length');
        finish(undefined, parseRooms(JSON.parse(packet.subarray(length[1]).toString()).blockfield));
      } catch (e) { finish(e as Error); }
    });
  });
}
let cache: RoomStatus = { available: false, checkedAt: 0, rooms: [] };
let until = 0;
let inflight: Promise<RoomStatus> | undefined;
export function currentRooms(): Promise<RoomStatus> {
  if (Date.now() < until) return Promise.resolve(cache);
  return inflight ??= queryRooms(process.env.BLOCKFIELD_SERVER_HOST || 'minecraft.play.nether.pp.ua', Number(process.env.BLOCKFIELD_SERVER_PORT || 25565))
    .catch(() => ({ available: false, checkedAt: Date.now(), rooms: [] }))
    .then((value) => { cache = value; until = Date.now() + 5000; return value; })
    .finally(() => { inflight = undefined; });
}
