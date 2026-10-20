import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameVmConfiguration } from '../../src/games/vmConfiguration';
import * as transport from '../../src/games/ra2/networkTransport';
import * as gameShim from '../../src/games/win32Shim';
import type { GuestMemory, Win32ShimOptions } from '../../src/vm86/win32';

afterEach(() => vi.restoreAllMocks());

describe.each(['ra2', 'yr', 'mo'] as const)('%s 运行时工厂', (id) => {
  it.each([
    undefined,
    { room: 'public', exeHash: 'a'.repeat(64) },
    { room: 'public', exeHash: 'a'.repeat(64), relayUrl: 'ws://127.0.0.1:15176/game' },
  ])('组装 shim 时保留宿主选项并以显式联机配置为准：%j', (network) => {
    let received: Win32ShimOptions | undefined;
    const instance = {} as gameShim.Win32Shim;
    const constructor = vi.spyOn(gameShim, 'Win32Shim').mockImplementation(function (_memory, options) {
      received = options;
      return instance;
    });
    const memory = {} as GuestMemory;
    const onFileWrite = vi.fn(),
      onNetworkStatus = vi.fn();
    const config = gameVmConfiguration({ id }, onNetworkStatus, network);
    expect(config.createShim(memory, { onFileWrite, commandLineArguments: '-SPEEDCONTROL' })).toBe(instance);
    expect(constructor).toHaveBeenCalledOnce();
    expect(received).toMatchObject({
      onFileWrite,
      commandLineArguments: '-SPEEDCONTROL',
      ra2NetworkEnabled: network !== undefined,
      ra2NetworkRoom: network?.room,
      ra2ExeHash: network?.exeHash,
    });
    if (network) {
      const factory = vi
        .spyOn(transport, 'createRa2WebSocketTransport')
        .mockReturnValue({} as transport.Ra2NetworkTransport);
      const handlers = { onReady: vi.fn(), onPeerJoin: vi.fn(), onPeerLeave: vi.fn(), onDatagram: vi.fn() };
      const join = { room: network.room, exeHash: network.exeHash, name: new Uint8Array([1]) };
      received!.ra2NetworkTransportFactory!(handlers, join);
      expect(factory).toHaveBeenCalledWith(handlers, join, { url: network.relayUrl, socketFactory: undefined });
    } else expect(received!.ra2NetworkTransportFactory).toBeUndefined();
    // Pass callbacks through unchanged; the assembly layer neither transforms state nor creates extra state sources.
    const status = { phase: 'connected' } as Parameters<NonNullable<Win32ShimOptions['onNetworkStatus']>>[0];
    received!.onNetworkStatus!(status);
    expect(onNetworkStatus).toHaveBeenCalledWith(status);
  });
});
