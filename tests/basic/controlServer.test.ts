import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { request as httpRequest } from 'node:http';
import { startControlServer } from '@ra2vm/control/server';
import { ControlClient } from '@ra2vm/control/client';

const origin = 'https://127.0.0.1:15174';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const server = await startControlServer({ port: 0, origins: [origin], requestTimeoutMs: 100 });
  cleanups.push(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const connect = async (channel: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/connect?channel=${channel}`, { origin });
    cleanups.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once('message', () => resolve());
      socket.once('error', reject);
    });
    return socket;
  };
  const request = (channel: string, id = 'caller-id') =>
    fetch(`${base}/channels/${channel}/request`, {
      method: 'POST',
      body: JSON.stringify({ id, method: 'observe' }),
    });
  return { base, connect, request };
}

it('lets the client recover a delivered game rejection through the real HTTP/WebSocket route', async () => {
  const { connect, base } = await setup();
  const socket = await connect('recovery');
  const requests: { method: string; params?: { sessionId: string; commandId: string } }[] = [];
  socket.on('message', (data) => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    socket.send(
      JSON.stringify({
        id: request.id,
        ...(request.method === 'command'
          ? { error: 'Target is not visible in the current viewport' }
          : { result: request.method === 'observe' ? { sessionId: 'match', frame: 100 } : { state: 'unknown' } }),
      }),
    );
  });
  const client = new ControlClient(Number(new URL(base).port), 'recovery');
  await expect(client.command('attack', { unit: 'tank', target: 'gone' }, 'match')).rejects.toMatchObject({
    state: 'rejected',
  });
  expect(requests.map((r) => r.method)).toEqual(['observe', 'command', 'commandStatus']);
  expect(requests[2]!.params).toMatchObject({ sessionId: 'match', commandId: requests[1]!.params!.commandId });
});

it('routes to the channel owner and correlates concurrent caller IDs independently', async () => {
  const { connect, request, base } = await setup();
  for (const name of ['alpha', 'bravo']) {
    const socket = await connect(name);
    socket.on('message', (data) => {
      const { id } = JSON.parse(data.toString());
      socket.send(JSON.stringify({ id, result: name }));
    });
  }
  const replies = await Promise.all(['alpha', 'bravo', 'alpha'].map(async (name) => (await request(name)).json()));
  expect(replies).toEqual(['alpha', 'bravo', 'alpha'].map((result) => ({ id: 'caller-id', result })));
  expect(await (await fetch(`${base}/channels`)).json()).toEqual({ channels: ['alpha', 'bravo'] });
});

it('rejects disconnected channels, times out unanswered requests, and never replays them', async () => {
  const { connect, request } = await setup();
  expect((await request('missing')).status).toBe(409);
  const socket = await connect('alpha');
  expect((await request('alpha')).status).toBe(504);
  socket.on('message', () => socket.close());
  expect((await request('alpha')).status).toBe(409);
});

it('rejects duplicate channel registration and untrusted browser HTTP access', async () => {
  const { connect, base } = await setup();
  await connect('alpha');
  await expect(connect('alpha')).rejects.toThrow();
  expect((await fetch(`${base}/channels`, { headers: { Origin: origin } })).status).toBe(403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(`${base}/channels`, { headers: { Host: 'untrusted.invalid' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(403);
});
