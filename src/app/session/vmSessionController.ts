import type { SessionRuntime } from './runtime';
import type { GameVmCallbacks } from './runtimeEvents';

export interface VmSessionStartContext {
  isCurrent(): boolean;
}

export type VmSessionShellFactory<T extends SessionRuntime = SessionRuntime> = (
  context: VmSessionStartContext,
) => Promise<T>;

/**
 * Own the VM shell's asynchronous lifecycle independently of the page DOM.
 * New starts invalidate old create/start results; cleanup waits only for shells already acquired.
 */
export class VmSessionController {
  private generation = 0;
  private activeShell: SessionRuntime | null = null;
  private readonly destroyPromises = new WeakMap<SessionRuntime, Promise<void>>();

  async start<T extends SessionRuntime>(
    factory: VmSessionShellFactory<T>,
    beforeStart: (shell: T) => void = () => {},
  ): Promise<T | null> {
    const generation = ++this.generation;
    await this.destroyActive();
    if (!this.isCurrent(generation)) return null;

    let shell: T;
    try {
      shell = await factory({ isCurrent: () => this.isCurrent(generation) });
    } catch (error) {
      if (this.isCurrent(generation)) throw error;
      return null;
    }

    if (!this.isCurrent(generation)) {
      await this.destroyShell(shell);
      return null;
    }
    this.activeShell = shell;
    try {
      // Prepare host context only for an acquired, current shell; preparation failures share startup cleanup.
      beforeStart(shell);
      await shell.start();
    } catch (error) {
      const wasCurrent = this.isCurrent(generation);
      if (this.activeShell === shell) this.activeShell = null;
      // Invalidate callbacks before cleanup so stop/destroy status cannot overwrite the original startup error.
      if (wasCurrent) ++this.generation;
      await this.destroyShell(shell);
      if (wasCurrent) throw error;
      return null;
    }
    if (!this.isCurrent(generation)) {
      if (this.activeShell === shell) this.activeShell = null;
      await this.destroyShell(shell);
      return null;
    }
    return shell;
  }

  async destroy(): Promise<void> {
    ++this.generation;
    await this.destroyActive();
  }

  isActive(shell: SessionRuntime): boolean {
    return this.activeShell === shell;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private async destroyActive(): Promise<void> {
    const shell = this.activeShell;
    this.activeShell = null;
    if (shell) await this.destroyShell(shell);
  }

  private destroyShell(shell: SessionRuntime): Promise<void> {
    const existing = this.destroyPromises.get(shell);
    if (existing) return existing;
    const promise = shell.destroy();
    this.destroyPromises.set(shell, promise);
    return promise;
  }
}

/** Discard callbacks from invalidated sessions instead of duplicating generation checks across pages. */
export function guardVmCallbacks(callbacks: GameVmCallbacks, isCurrent: () => boolean): GameVmCallbacks {
  return {
    onNetworkStatus: (status) => {
      if (isCurrent()) callbacks.onNetworkStatus?.(status);
    },
    onStatus: (status) => {
      if (isCurrent()) callbacks.onStatus?.(status);
    },
    onCall: (call, ordinal) => {
      if (isCurrent()) callbacks.onCall?.(call, ordinal);
    },
    onCallBatch: (batch) => {
      if (isCurrent()) callbacks.onCallBatch?.(batch);
    },
    onBlocked: (call) => {
      if (isCurrent()) callbacks.onBlocked?.(call);
    },
    onFrame: (frame) => {
      if (isCurrent()) callbacks.onFrame?.(frame);
    },
    onLogicFrame: (count) => {
      if (isCurrent()) callbacks.onLogicFrame?.(count);
    },
    onShellPage: (title) => {
      if (isCurrent()) callbacks.onShellPage?.(title);
    },
  };
}
