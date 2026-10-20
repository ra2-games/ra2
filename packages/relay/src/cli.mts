/** Standalone, general-purpose WebSocket relay; no TLS certificate is required, and the deployer chooses the listen address. */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { createGameRelay } from './server/gameRelay';
import { parseRelayFaultConfig } from './server/relayFaults';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '0.0.0.0' },
    port: { type: 'string', default: '15176' },
    'max-connections': { type: 'string', default: '2048' },
    faults: { type: 'string' },
    'delay-ms': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: false,
});
if (values.help) {
  console.log(`用法：node gameRelay.cjs [选项]
  --host <地址>             监听地址（默认 0.0.0.0）
  --port <端口>             TCP 端口（默认 15176）
  --max-connections <数量>  最大连接数（默认 2048）
  --delay-ms <毫秒>        每次游戏数据报转发的附加延迟（0–60000，默认 0；不延迟心跳）
  --faults <JSON>           可选故障注入配置
  -h, --help               显示帮助
不读取 RELAY_* 或 RA2_* 环境变量。`);
  process.exit(0);
}
const host = values.host;
const port = Number(values.port);
const maxConnections = Number(values['max-connections']);
if (!host.trim()) throw new Error('--host 不能为空');
if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port 无效');
if (!/^\d+$/.test(values['max-connections']) || !Number.isSafeInteger(maxConnections) || maxConnections < 1)
  throw new Error('--max-connections 无效');
const faults = parseRelayFaultConfig(values.faults) ?? {};
if (values['delay-ms'] !== undefined) {
  if (!/^\d+$/.test(values['delay-ms']) || Number(values['delay-ms']) > 60000) throw new Error('--delay-ms 无效');
  if (faults.delayMs !== undefined) throw new Error('--delay-ms 与 --faults.delayMs 不能同时指定');
  faults.delayMs = Number(values['delay-ms']);
}
const relay = createGameRelay({ faults: Object.keys(faults).length ? faults : undefined, maxConnections });
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/healthz') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(
    JSON.stringify({
      ok: true,
      ...relay.getHealth(),
      transport: 'websocket',
      stats: relay.getStats(),
      faults: relay.getFaultStats(),
    }),
  );
});
server.on('upgrade', (req, socket, head) => {
  relay.handleUpgrade(req, socket, head);
});
server.on('error', (error) => {
  console.error(error);
  relay.close();
  process.exitCode = 1;
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  relay.close();
  server.close();
  await relay.drained();
  server.closeAllConnections();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
// For maintenance, send SIGUSR2, wait for healthz connections=0, then send SIGTERM; do not forcibly terminate existing games on a timer.
process.on('SIGUSR2', () => relay.beginDrain());
server.listen(port, host, () => {
  console.log(`[game-relay] listening ${host}:${port}`);
  const addresses =
    host === '0.0.0.0' || host === '::'
      ? [
          '127.0.0.1',
          ...Object.values(networkInterfaces()).flatMap((entries) =>
            (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address),
          ),
        ]
      : [host];
  for (const address of new Set(addresses)) {
    const endpoint = `${address.includes(':') ? `[${address}]` : address}:${port}`;
    console.log(`[game-relay] 请在游戏中输入 relay：${endpoint}`);
  }
  if (faults.delayMs) console.log(`[game-relay] 游戏数据报每次转发增加 ${faults.delayMs}ms；心跳 RTT 不受此注入影响。`);
  console.log('[game-relay] 路径可改为 /房间名；不同房间隔离。');
  console.log('[game-relay] 在游戏启动页勾选「联机」后填写上述地址，无需输入 ws:// 或 /ra2。');
  console.log('[game-relay] 跨电脑连接请选择可达网卡地址；容器端口映射时使用宿主机地址和映射端口。');
});
