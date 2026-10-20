import type { GameRuntimeHooks } from '../runtimeHooks';
import type { RelaySocket } from 'relay-package/client';
import type { GuestMemory, VmNetworkStatus, Win32ShimOptions } from '../../vm86/win32';
import { Win32Shim } from '../win32Shim';
import { RA2_YR_RESOURCE_POLICY } from './resourcePolicy';
import { createRa2WebSocketTransport, type Ra2NetworkConfig } from '../ra2/networkTransport';

/**
 * Both host modes share game configuration without importing VM drivers or UI in reverse.
 * Configuration functions execute locally in each thread; never include factories in Worker messages.
 */
export function ra2YrVmConfiguration(
  onNetworkStatus?: (status: VmNetworkStatus) => void,
  network?: Ra2NetworkConfig,
  socketFactory?: (url: string) => RelaySocket,
) {
  return {
    resourcePolicy: RA2_YR_RESOURCE_POLICY,
    createShim: (memory: GuestMemory, options: Win32ShimOptions = {}, hooks?: GameRuntimeHooks) =>
      new Win32Shim(memory, {
        ...options,
        prepareNetwork: hooks?.prepareNetwork,
        ra2NetworkEnabled: network !== undefined,
        ra2NetworkRoom: network?.room,
        ra2ExeHash: network?.exeHash,
        ...(network
          ? ({
              ra2NetworkTransportFactory: (handlers, join) =>
                createRa2WebSocketTransport(handlers, join, { url: network.relayUrl, socketFactory }),
            } satisfies Partial<ConstructorParameters<typeof Win32Shim>[1]>)
          : {}),
        onNetworkStatus: (status) => onNetworkStatus?.(status),
      }),
  };
}
