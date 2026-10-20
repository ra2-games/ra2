import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../.agents/skills/ra2-battle-control/scripts/ra2ctl.mts', import.meta.url));

it.each(['victory', 'defeat', 'unknown'])(
  'carries native %s from status through compact and raw CLI monitoring',
  async (outcome) => {
    const result = {
      sessionId: '12345678-1111-2222-3333-444444444444',
      frame: 567,
      player: 3,
      outcome,
      source: 'native-game-loop',
    };
    const status = {
      pageId: 'page',
      phase: 'running',
      runtime: {
        page: 'GUI:MultiplayerScore',
        battlefield: { ready: false },
        battleResult: result,
      },
    };
    const methods: string[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      methods.push(request.method);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: request.id, result: status }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const run = (...args: string[]) =>
      exec(process.execPath, ['--import', 'tsx', script, '--port', String(port), '--channel', 'test', ...args]);
    try {
      expect(JSON.parse((await run('ui.status')).stdout)).toMatchObject({
        runtime: { battleResult: { session: '12345678', outcome } },
      });
      expect(JSON.parse((await run('monitor', '--params', '{"durationMs":1000}')).stdout)).toMatchObject({
        event: 'battle-ended',
        outcome,
        result: { session: '12345678', frame: 567, player: 3, source: 'native-game-loop' },
      });
      expect(JSON.parse((await run('monitor', '--raw')).stdout)).toMatchObject({
        event: 'battle-ended',
        outcome,
        result,
      });
      expect(methods).toEqual(['ui.status', 'ui.status', 'ui.status']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each(['stop', 'continue'])('binds CLI orders and reports nonzero status with onRejected=%s', async (onRejected) => {
  const commands: Record<string, unknown>[] = [];
  const sessionId = '12345678-1111-2222-3333-444444444444';
  let frame = 1;
  const entities = Array.from({ length: 8 }, (_, id) => ({ id: String(id), kind: 'vehicle', owner: 0, health: 300 }));
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    let result: unknown;
    if (request.method === 'observe') result = { sessionId, frame: frame++, entities };
    else if (request.method === 'command') {
      commands.push(request.params);
      result = { state: 'pending' };
    } else if (request.method === 'commandStatus') {
      result = { state: commands.length === 2 ? 'rejected' : 'submitted' };
    } else if (request.method === 'ui.status') {
      result = { pageId: 'page', runtime: { battlefield: { ready: true } } };
    } else throw new Error(`Unexpected method ${request.method}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: request.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const run = (...args: string[]) =>
    exec(process.execPath, ['--import', 'tsx', script, '--port', String(port), '--channel', 'test', ...args]);
  try {
    const compact = JSON.parse((await run('observe')).stdout);
    expect(compact).toMatchObject({ session: '12345678' });
    expect(compact).not.toHaveProperty('sessionId');
    expect(compact.entities).toEqual({
      columns: ['id', 'kind', 'owner', 'health'],
      rows: entities.map((entity) => Object.values(entity)),
    });
    const ready = JSON.parse((await run('wait-ready')).stdout);
    expect(ready).toMatchObject({ event: 'battle-ready', observation: { session: '12345678' } });
    expect(commands).toHaveLength(0);
    const raw = JSON.parse((await run('observe', '--raw')).stdout);
    expect(raw.result.sessionId).toBe(sessionId);
    expect(raw.result.entities).toEqual(entities);
    let output = '';
    try {
      await run(
        'batch',
        '--params',
        JSON.stringify({
          onRejected,
          orders: [
            { action: 'produce', type: 'E1' },
            { action: 'attack', unit: '1', target: '2' },
            { action: 'stop', unit: '1' },
          ],
        }),
      );
    } catch (error) {
      expect(error).toMatchObject({ code: 1 });
      output = (error as { stdout: string }).stdout;
    }
    expect(commands).toHaveLength(onRejected === 'stop' ? 2 : 3);
    expect(commands.every((c) => c.sessionId === sessionId && typeof c.commandId === 'string')).toBe(true);
    expect(commands[1]!.observedFrame).toBeGreaterThan(commands[0]!.observedFrame as number);
    expect(commands[0]!.commandId).not.toBe(commands[1]!.commandId);
    const partial = JSON.parse(output);
    if (onRejected === 'stop') {
      expect(partial).toMatchObject({ state: 'interrupted', failed: 1, remaining: 1 });
      expect(partial.completed).toBe(1);
      expect(partial.error).toContain(commands[1]!.commandId);
    } else {
      expect(partial).toMatchObject({ state: 'completed-with-rejections', completed: 2, rejected: [{ index: 1 }] });
      expect(partial.rejected[0].error).toContain(commands[1]!.commandId);
    }
    await expect(run('start')).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('already running') });
    await expect(run('build-plan', '--params', JSON.stringify({ steps: [] }))).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('Provide 1..8 building steps'),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('submits exit-battle once and polls its receipt after the native battlefield disappears', async () => {
  const requests: { method: string; params?: Record<string, unknown> }[] = [];
  let left = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    let result: unknown;
    let error: string | undefined;
    if (request.method === 'observe') {
      if (left) error = 'Battlefield is not active';
      else result = { sessionId: 'battle', frame: 100, entities: [] };
    } else if (request.method === 'command') {
      left = true;
      result = { state: 'pending' };
    } else if (request.method === 'commandStatus') result = { state: 'submitted' };
    else error = 'Unexpected method';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: request.id, result, error }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const run = (...args: string[]) =>
    exec(process.execPath, ['--import', 'tsx', script, '--port', String(port), '--channel', 'test', ...args]);
  try {
    expect(JSON.parse((await run('exit-battle')).stdout)).toEqual({ state: 'submitted' });
    const commands = requests.filter((request) => request.method === 'command');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.params).toMatchObject({ sessionId: 'battle', observedFrame: 100, action: 'exit-battle' });
    expect(requests.at(-1)).toMatchObject({ method: 'commandStatus', params: commands[0]!.params });
    await expect(run('exit-battle')).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('Battlefield is not active'),
    });
    expect(requests.filter((request) => request.method === 'command')).toHaveLength(1);
    await expect(run('exit-battle', '--params', '{"action":"sell"}')).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('action override'),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
