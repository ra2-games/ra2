import { withRa2Winsock } from './ra2/winsock';
import { Win32ShimBase, type GuestMemory, type Win32ShimOptions } from '../vm86/win32';
import type { GameRuntimeHooks } from './runtimeHooks';

/** Application-level composition; native addresses are resolved by the selected game's session hooks. */
export class Win32Shim extends withRa2Winsock(Win32ShimBase) {
  constructor(memory: GuestMemory, options: Win32ShimOptions & Pick<GameRuntimeHooks, 'prepareNetwork'> = {}) {
    super(memory, options);
    if (options.ra2NetworkEnabled) options.prepareNetwork?.(memory, (code) => this.allocateDynamicCode(code));
  }
}
