import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseRooms, varint, readVarint, queryRooms } from '../src/lib/rooms.ts';
const room = { id: '12345678-1234-1234-1234-123456789abc', name: 'Комната 1', mode: 'Захват точек', map: 'Карта', phase: 'GAME', players: 4, joinable: true };
test('room snapshots distinguish empty, stale and malformed responses', () => {
  assert.deepEqual(parseRooms({ checkedAt: Date.now(), rooms: [] }).rooms, []);
  assert.throws(() => parseRooms({ checkedAt: Date.now() - 60000, rooms: [room] }));
  for (const invalid of [{ ...room, id: '../file' }, { ...room, players: -1 }, { ...room, phase: 'unknown' }]) assert.throws(() => parseRooms({ checkedAt: Date.now(), rooms: [invalid] }));
});
test('varints support fragments and reject overlong input', () => {
  for (const value of [0, 127, 128, 767, 1048576]) assert.equal(readVarint(varint(value))[0], value);
  assert.equal(readVarint(Buffer.from([128])), null);
  assert.throws(() => readVarint(Buffer.from([128, 128, 128, 128, 128])));
});
test('Minecraft status accepts fragmented replies and closes its connection', async () => {
  const server = net.createServer(socket => socket.once('data', () => {
    const json = Buffer.from(JSON.stringify({ blockfield: { checkedAt: Date.now(), rooms: [room] } }));
    const packet = Buffer.concat([Buffer.from([0]), varint(json.length), json]);
    const frame = Buffer.concat([varint(packet.length), packet]);
    socket.write(frame.subarray(0, 1));
    setTimeout(() => socket.end(frame.subarray(1)), 10);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.deepEqual((await queryRooms('127.0.0.1', server.address().port)).rooms, [room]); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
test('restarting game server behind the proxy reports an open lobby', async () => {
  const lobby = net.createServer(socket => socket.once('data', () => {
    const json = Buffer.from(JSON.stringify({ version: { name: 'Velocity' } }));
    const packet = Buffer.concat([Buffer.from([0]), varint(json.length), json]);
    socket.end(Buffer.concat([varint(packet.length), packet]));
  }));
  await new Promise(resolve => lobby.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { BLOCKFIELD_SERVER_HOST: '127.0.0.1', BLOCKFIELD_SERVER_PORT: '1', BLOCKFIELD_LOBBY_HOST: '127.0.0.1', BLOCKFIELD_LOBBY_PORT: String(lobby.address().port) });
  try {
    const { currentRooms } = await import('../src/lib/rooms.ts?lobby');
    const status = await currentRooms();
    assert.equal(status.available, false);
    assert.equal(status.lobby, true);
  } finally { await new Promise(resolve => lobby.close(resolve)); }
});
test('battle data preserves capture state and rejects invalid progress and scores', () => {
  const battle = { red: 720, blue: 685, points: [{ id: 'a', name: 'A', owner: 'BLUE', claiming: 'NONE', capturing: 'RED', progress: 35 }] };
  const parse = value => parseRooms({ checkedAt: Date.now(), rooms: [{ ...room, battle: value }] });
  assert.deepEqual(parse(battle).rooms[0].battle, battle);
  assert.throws(() => parse({ ...battle, red: -1 }));
  assert.throws(() => parse({ ...battle, points: [{ ...battle.points[0], progress: 101 }] }));
  assert.throws(() => parse({ ...battle, points: [{ ...battle.points[0], owner: 'unknown' }] }));
});
