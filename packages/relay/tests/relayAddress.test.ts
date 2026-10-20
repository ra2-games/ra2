import { expect, it } from 'vitest';
import { normalizeRelayAddress, relayAddressCandidates, relayRoomFromPath } from '../src/network/relayAddress';

it('裸地址探测 TLS 后明文；显式协议不回退，保留端口与 IPv6', () => {
  expect(relayAddressCandidates('localhost:80/room')).toEqual(['wss://localhost:80/room', 'ws://localhost:80/room']);
  expect(relayAddressCandidates('[::1]:15176/room')).toEqual(['wss://[::1]:15176/room', 'ws://[::1]:15176/room']);
  expect(relayAddressCandidates('wss://localhost/room')).toEqual(['wss://localhost/room']);
  expect(normalizeRelayAddress(' localhost:15176/room ')).toBe('localhost:15176/room');
});
it('路径房间解码，原入口名没有特殊待遇', () => {
  expect(relayRoomFromPath('/%E6%88%BF%E9%97%B4')).toBe('房间');
  for (const path of ['/ra2', '/game', '/ra2-network']) expect(relayRoomFromPath(path)).toBe(path.slice(1));
});
it.each(['/', '/a/b', '/a/', '/%2f', '/%00', '/%20', '/%', '/' + 'a'.repeat(65)])('拒绝非法房间：%s', (path) => {
  expect(() => relayRoomFromPath(path)).toThrow();
});
it.each([
  'http://localhost/room',
  'ws://u:p@localhost/room',
  'localhost/room#x',
  '/room',
  'localhost\\room',
  'localhost/a/../b',
  'localhost/%2e',
])('拒绝非法地址：%s', (value) => {
  expect(() => normalizeRelayAddress(value)).toThrow();
});
