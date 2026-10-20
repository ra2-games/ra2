import '../helpers/chineseLocale';
import { expect, it } from 'vitest';
import { formatNetworkStatus } from '../../src/ui/pages/game/networkStatus';
import { guardVmCallbacks } from '../../src/app/session/vmSessionController';

it('区分中继连接与游戏同步，断线明确提示不支持续局', () => {
  const status = { phase: 'connected' as const, room: 'public-ra2', peers: 7, detail: '', relayRttMs: 120 };
  expect(formatNetworkStatus(status)).toContain('其他成员 7');
  expect(formatNetworkStatus(status)).toContain('中继 RTT 120 ms');
  expect(formatNetworkStatus({ ...status, phase: 'disconnected', detail: 'handshake timeout' })).toContain(
    '中继握手超时',
  );
  expect(formatNetworkStatus({ ...status, phase: 'disconnected', detail: 'room full' })).toContain('最多 20 人');
  expect(formatNetworkStatus({ ...status, phase: 'disconnected' })).toContain('不支持断线续局');
});

it('退出的旧 VM 不能覆盖新 VM 联机状态', () => {
  let current = true;
  const calls: string[] = [];
  const callbacks = guardVmCallbacks({ onNetworkStatus: (status) => calls.push(status.phase) }, () => current);
  callbacks.onNetworkStatus!({ phase: 'connected', room: 'r', peers: 1, detail: '' });
  current = false;
  callbacks.onNetworkStatus!({ phase: 'disconnected', room: 'r', peers: 0, detail: '' });
  expect(calls).toEqual(['connected']);
});
