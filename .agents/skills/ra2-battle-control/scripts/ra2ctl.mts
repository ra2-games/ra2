import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { startControlServer } from './server';
import { CHANNEL_PATTERN, CONTROL_PORT } from './protocol';
import { ControlClient } from './client';
import { monitor, waitForBattle } from './monitor';
import { placeBuilding } from './placeBuilding';
import { orderGroup } from './orderGroup';
import { batch } from './batch';
import { buildPlan } from './buildPlan';
import { compactOutput } from './output';
import { screenshot } from './screenshot';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: 'string' },
    port: { type: 'string' },
    origin: { type: 'string', multiple: true },
    params: { type: 'string' },
    output: { type: 'string' },
    raw: { type: 'boolean', default: false },
  },
});
const port = Number(values.port ?? CONTROL_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const [method] = positionals;
const emit = (value: unknown) => console.log(JSON.stringify(values.raw ? value : compactOutput(value)));
if (method === 'serve') {
  const origins = values.origin ?? ['https://localhost:15174', 'https://127.0.0.1:15174'];
  const server = await startControlServer({ port, origins });
  console.log(`ra2ctl listening on 127.0.0.1:${server.port}; allowed origins: ${origins.join(', ')}`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} else if (method === 'screenshot') {
  try {
    emit(await screenshot(new ControlClient(port, values.channel ?? ''), values.output));
  } catch (error) {
    emit({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
} else if (method === 'start') {
  try {
    const client = new ControlClient(port, values.channel ?? '');
    const status = await client.request<{ pageId: string; runtime?: { battlefield?: { ready: boolean } } }>(
      'ui.status',
    );
    if (status.runtime?.battlefield?.ready) throw new Error('A battle is already running; start will not replace it');
    emit(
      await client.request('ui.quickStart', {
        commandId: randomUUID(),
        expectedPageId: status.pageId,
        replaceSession: true,
      }),
    );
  } catch (error) {
    emit({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
} else if (
  [
    'monitor',
    'wait-ready',
    'place-building',
    'order-group',
    'look',
    'act',
    'batch',
    'build-plan',
    'exit-battle',
  ].includes(method ?? '')
) {
  try {
    const client = new ControlClient(port, values.channel ?? '');
    const params = values.params ? JSON.parse(values.params) : {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Object params required');
    if (method === 'exit-battle') {
      if (params.action !== undefined) throw new Error('exit-battle does not accept an action override');
      params.action = 'exit-battle';
    }
    if (!['monitor', 'wait-ready'].includes(method!) && typeof params.sessionId !== 'string')
      params.sessionId = (await client.observe()).sessionId;
    if (method === 'build-plan') {
      const result = await buildPlan(client, params, emit);
      emit(result);
      if (result.state !== 'completed') process.exitCode = 1;
    } else if (method === 'batch') {
      const result = await batch(client, params);
      emit(result);
      if (result.state !== 'submitted') process.exitCode = 1;
    } else if (method === 'wait-ready') emit(await waitForBattle(client, params));
    else if (method === 'monitor') await monitor(client, params, emit);
    else if (method === 'place-building') await placeBuilding(client, params, emit);
    else if (method === 'order-group') await orderGroup(client, params, emit);
    else if (method === 'look') {
      const { sessionId, ...focus } = params;
      if (typeof sessionId !== 'string') throw new Error('sessionId required');
      emit(await client.look(focus, sessionId));
    } else {
      const { action, sessionId, ...extra } = params;
      if (typeof action !== 'string' || typeof sessionId !== 'string') throw new Error('action and sessionId required');
      emit(await client.command(action, extra, sessionId));
    }
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
} else if (method === 'channels' || method) {
  if (method !== 'channels' && !CHANNEL_PATTERN.test(values.channel ?? '')) throw new Error('--channel is required');
  const response = await fetch(
    `http://127.0.0.1:${port}${method === 'channels' ? '/channels' : `/channels/${values.channel}/request`}`,
    {
      ...(method !== 'channels'
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: randomUUID(),
              method,
              params: values.params ? JSON.parse(values.params) : undefined,
            }),
          }
        : {}),
      signal: AbortSignal.timeout(15000),
    },
  );
  const reply = await response.json();
  if (values.raw) console.log(JSON.stringify(reply));
  else emit(method === 'channels' ? reply : reply.error ? { error: reply.error } : reply.result);
  if (reply.error) process.exitCode = 1;
  if (!response.ok) process.exitCode = 1;
} else {
  console.log(
    'Usage: pnpm ra2ctl serve [--origin URL] | channels | --channel NAME capabilities|observe|screenshot|start|wait-ready|exit-battle|command|act|batch|build-plan|look|order-group|monitor|place-building [--params JSON] [--output NEW_IMAGE_PATH] [--raw]',
  );
}
