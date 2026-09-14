import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { rcon } from '../src/lib/rcon.ts';

const frame = (id, type, body) => {
  const text = Buffer.from(body), out = Buffer.alloc(14 + text.length);
  out.writeInt32LE(10 + text.length, 0); out.writeInt32LE(id, 4); out.writeInt32LE(type, 8); text.copy(out, 12);
  return out;
};

// Behaves like Minecraft: auth reply type 2, long output split in 4 KiB chunks, "Unknown request" for other types.
function fakeServer(t, { password = 'secret', silent = false } = {}) {
  const seen = [];
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
        const length = data.readInt32LE(0), id = data.readInt32LE(4), type = data.readInt32LE(8), body = data.subarray(12, length + 2).toString();
        data = data.subarray(length + 4);
        if (silent) continue;
        if (type === 3) socket.write(frame(body === password ? id : -1, 2, ''));
        else if (type === 2) {
          seen.push(body);
          const output = body === 'big' ? 'x'.repeat(9000) : `ran ${body}`;
          for (let i = 0; i < output.length; i += 4096) socket.write(frame(id, 0, output.slice(i, i + 4096)));
        } else socket.write(frame(id, 0, `Unknown request ${type.toString(16)}`));
      }
    });
  });
  t.after(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen })));
}

test('RCON authenticates, runs commands in order and joins multi-packet output', async t => {
  const { port, seen } = await fakeServer(t);
  const outputs = await rcon(['list', 'big', 'say hi'], { host: '127.0.0.1', port, password: 'secret' });
  assert.deepEqual(seen, ['list', 'big', 'say hi']);
  assert.equal(outputs[0], 'ran list'); assert.equal(outputs[1].length, 9000); assert.equal(outputs[2], 'ran say hi');
});

test('RCON wrong password fails without running commands', async t => {
  const { port, seen } = await fakeServer(t);
  await assert.rejects(rcon(['stop'], { host: '127.0.0.1', port, password: 'wrong' }), /authentication failed/);
  assert.deepEqual(seen, []);
});

test('RCON silent server times out', async t => {
  const { port } = await fakeServer(t, { silent: true });
  await assert.rejects(rcon(['list'], { host: '127.0.0.1', port, password: 'secret', timeout: 200 }), /timeout/);
});
