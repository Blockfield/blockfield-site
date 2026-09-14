import net from 'node:net';

const AUTH = 3, COMMAND = 2;

function packet(id: number, type: number, body: string): Buffer {
  const text = Buffer.from(body, 'utf8'), frame = Buffer.alloc(14 + text.length);
  frame.writeInt32LE(10 + text.length, 0); frame.writeInt32LE(id, 4); frame.writeInt32LE(type, 8); text.copy(frame, 12);
  return frame;
}

/**
 * Source RCON over one connection: authenticate, run commands in order, return one output per command.
 * Minecraft splits long output into several packets and never marks the last one, so after the first reply
 * packet an empty packet of an unknown type is sent; its reply ("Unknown request …") ends that command's output.
 * Vanilla RCON reads one packet per socket read and drops the connection otherwise: never write two packets at once.
 */
export function rcon(commands: string[], { host, port, password, timeout = 5000 }: { host: string; port: number; password: string; timeout?: number }): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const outputs: string[] = [];
    let data = Buffer.alloc(0), step = 0, current = '', authed = false, sentinel = false;
    const finish = (error?: Error) => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(outputs); };
    const timer = setTimeout(() => finish(new Error('RCON timeout')), timeout);
    const send = () => {
      if (step >= commands.length) return finish();
      current = ''; sentinel = false;
      socket.write(packet(10 + step * 2, COMMAND, commands[step]));
    };
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('RCON connection closed')));
    socket.on('connect', () => socket.write(packet(1, AUTH, password)));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 1_048_576) return finish(new Error('RCON response too large'));
      while (data.length >= 4) {
        const length = data.readInt32LE(0);
        if (length < 10 || length > 65_536) return finish(new Error('Invalid RCON packet'));
        if (data.length < length + 4) return;
        const id = data.readInt32LE(4), type = data.readInt32LE(8), body = data.subarray(12, length + 2).toString('utf8');
        data = data.subarray(length + 4);
        if (id === -1) return finish(new Error('RCON authentication failed'));
        // Source servers may send an empty value packet before the auth reply; only the auth reply (type 2, id 1) starts commands.
        if (!authed) { if (type === COMMAND && id === 1) { authed = true; send(); } continue; }
        if (id === 10 + step * 2) {
          current += body;
          if (!sentinel) { sentinel = true; socket.write(packet(11 + step * 2, 100, '')); }
        }
        else if (id === 11 + step * 2) { outputs.push(current); step++; send(); }
      }
    });
  });
}
