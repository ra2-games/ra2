import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';

// Deliberately avoid the project encoder: an independent client constructs frames from the public specification to verify distribution without the repository or game modules.
function frame(header: Record<string, unknown>, payload = Buffer.alloc(0)): Buffer {
  const text = (value: unknown) => {
    const bytes = Buffer.from(String(value));
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(bytes.length);
    return Buffer.concat([prefix, bytes]);
  };
  if (header.t === 'hello')
    return Buffer.concat([
      Buffer.from([1]),
      text(header.room),
      Buffer.from(String(header.exe), 'hex'),
      text(header.nonce),
      payload,
    ]);
  if (header.t !== 'datagram') throw new Error('unsupported test frame');
  const bytes = Buffer.alloc(13);
  bytes[0] = 5;
  bytes.writeUInt32BE(Number(header.src), 1);
  bytes.writeUInt32BE(Number(header.dest), 5);
  bytes.writeUInt16BE(Number(header.sport), 9);
  bytes.writeUInt16BE(Number(header.dport), 11);
  return Buffer.concat([bytes, payload]);
}
function next(socket: EventEmitter, type: string): Promise<{ header: Record<string, unknown>; payload: Buffer }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`未收到 ${type}`));
    }, 3000);
    function cleanup() {
      clearTimeout(timer);
      socket.off('message', receive);
    }
    function receive(data: Buffer) {
      if (data[0]! < 1 || data[0]! > 8) {
        cleanup();
        reject(new Error('invalid binary protocol'));
        return;
      }
      if (type === 'welcome' && data[0] === 2) {
        const length = data.readUInt16BE(1);
        const addr = data.readUInt32BE(3 + length);
        cleanup();
        resolve({ header: { t: 'welcome', addr }, payload: Buffer.alloc(0) });
      } else if (type === 'datagram' && data[0] === 5) {
        cleanup();
        resolve({
          header: {
            v: 3,
            t: 'datagram',
            src: data.readUInt32BE(1),
            dest: data.readUInt32BE(5),
            sport: data.readUInt16BE(9),
            dport: data.readUInt16BE(11),
          },
          payload: data.subarray(13),
        });
      }
    }
    socket.on('message', receive);
  });
}
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

it.each([
  ['/ra2', '/ra2'],
  ['/custom-room', '/custom-room'],
])(
  '分发包独立启动、路径 %s 转发、附加延迟与源地址覆写',
  async (first, second) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-package-'));
    let child: ChildProcess | undefined;
    const sockets: (EventEmitter & { send: (frame: Buffer) => void })[] = [];
    const signals: WebSocket[] = [];
    try {
      await promisify(execFile)('sh', ['scripts/build-server.sh', directory], {
        cwd: resolve(import.meta.dirname, '..'),
        timeout: 20000,
      });
      expect(await readFile(join(directory, 'LICENSE'), 'utf8')).toContain('GNU GENERAL PUBLIC LICENSE');
      expect(await readFile(join(directory, 'licenses/ws/LICENSE'), 'utf8')).toContain('Permission');
      expect(JSON.parse(await readFile(join(directory, 'licenses/ws/package.json'), 'utf8')).name).toBe('ws');
      expect(await readFile(join(directory, 'RELAY_PROTOCOL.md'), 'utf8')).toContain('13-byte header');
      const help = await promisify(execFile)(process.execPath, ['gameRelay.cjs', '--help'], { cwd: directory });
      expect(help.stdout).toContain('默认 0.0.0.0');
      for (const args of [
        ['--port', '0'],
        ['--port', '65536'],
        ['--max-connections', '0'],
        ['--unknown'],
        ['--host', ''],
        ['--faults', '{"lossRate":2}'],
        ['--delay-ms', '-1'],
        ['--delay-ms', 'NaN'],
        ['--delay-ms', '60001'],
        ['--delay-ms', '1', '--faults', '{"delayMs":2}'],
      ]) {
        await expect(
          promisify(execFile)(process.execPath, ['gameRelay.cjs', ...args], { cwd: directory, timeout: 3000 }),
        ).rejects.toMatchObject({ code: 1 });
      }
      const port = await freePort();
      child = spawn(
        process.execPath,
        ['gameRelay.cjs', '--host', '127.0.0.1', '--port', String(port), '--delay-ms', '80'],
        {
          cwd: directory,
          env: {
            ...process.env,
            NODE_PATH: '',
            RELAY_HOST: 'invalid.invalid',
            RELAY_PORT: 'invalid',
            RA2_RELAY_PORT: 'invalid',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`relay 启动超时：${output}`)), 5000);
        child!.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child!.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`relay 退出 ${code}：${output}`));
        });
        child!.stderr!.on('data', (chunk) => {
          output += chunk;
        });
        child!.stdout!.on('data', (chunk) => {
          output += chunk;
          if (output.includes(`请在游戏中输入 relay：127.0.0.1:${port}`)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const key = createHash('sha256').update('independent-game/protocol-v1').digest('hex');
      let sourceAddress: unknown;
      for (const [index, endpoint] of [first, second].entries()) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}?clientId=client-${index}`);
        signals.push(socket);
        sockets.push(socket);
        await once(socket, 'open');
        const ready = next(socket, 'welcome');
        socket.send(
          frame({ t: 'hello', room: 'independent-game', exe: key, nonce: `n${index}` }, Buffer.from([index])),
        );
        const welcome = await ready;
        if (index === 0) sourceAddress = welcome.header.addr;
      }
      const received = next(sockets[1]!, 'datagram');
      const sentAt = performance.now();
      sockets[0]!.send(
        frame({ t: 'datagram', src: 123, sport: 12, dest: 0xffffffff, dport: 34 }, Buffer.from([0, 255, 7])),
      );
      expect(await received).toEqual({
        header: { v: 3, t: 'datagram', src: sourceAddress, sport: 12, dest: 0xffffffff, dport: 34 },
        payload: Buffer.from([0, 255, 7]),
      });
      expect(performance.now() - sentAt).toBeGreaterThanOrEqual(65);
      expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toMatchObject({
        ok: true,
        transport: 'websocket',
        players: 2,
      });
    } finally {
      for (const signal of signals) signal.terminate();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const force = setTimeout(() => child?.kill('SIGKILL'), 4000);
        try {
          await exited;
        } finally {
          clearTimeout(force);
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
