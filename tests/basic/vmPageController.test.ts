import { describe, expect, it, vi } from 'vitest';
import { guardVmCallbacks, VmSessionController } from '../../src/app/session/vmSessionController';
import type { SessionRuntime } from '../../src/app/session/runtime';
import type { VmFrame } from '../../src/vm86/win32';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakeShell(start = Promise.resolve()): SessionRuntime & { startCalls: number; destroyCalls: number } {
  const shell = {
    startCalls: 0,
    destroyCalls: 0,
    start: vi.fn(async () => {
      shell.startCalls++;
      await start;
    }),
    destroy: vi.fn(async () => {
      shell.destroyCalls++;
    }),
  };
  return shell;
}

describe('VmSessionController asynchronous lifecycle', () => {
  it('does not wait for create and destroys a late shell after teardown', async () => {
    const controller = new VmSessionController();
    const creation = deferred<SessionRuntime>();
    const beforeStart = vi.fn();
    const starting = controller.start(async () => creation.promise, beforeStart);
    await Promise.resolve();

    await expect(controller.destroy()).resolves.toBeUndefined();
    const lateShell = fakeShell();
    creation.resolve(lateShell);

    await expect(starting).resolves.toBeNull();
    expect(lateShell.startCalls).toBe(0);
    expect(lateShell.destroyCalls).toBe(1);
    expect(beforeStart).not.toHaveBeenCalled();
  });

  it('runs preparation after creation and before starting the current shell', async () => {
    const controller = new VmSessionController();
    const beforeStart = vi.fn();
    const shell = {
      start: vi.fn(async () => {
        expect(beforeStart).toHaveBeenCalledExactlyOnceWith(shell);
      }),
      destroy: vi.fn(async () => {}),
    };
    await expect(controller.start(async () => shell, beforeStart)).resolves.toBe(shell);
    await controller.destroy();
  });

  it('destroys the acquired shell if preparation fails before start', async () => {
    const controller = new VmSessionController();
    const shell = fakeShell();
    const error = new Error('preparation failed');
    await expect(
      controller.start(
        async () => shell,
        () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(shell.start).not.toHaveBeenCalled();
    expect(shell.destroy).toHaveBeenCalledOnce();
  });

  it('invalidates a create result when a newer start begins', async () => {
    const controller = new VmSessionController();
    const firstCreation = deferred<SessionRuntime>();
    const secondShell = fakeShell();
    const first = controller.start(async () => firstCreation.promise);
    await Promise.resolve();
    const second = controller.start(async () => secondShell);

    await expect(second).resolves.toBe(secondShell);
    const firstShell = fakeShell();
    firstCreation.resolve(firstShell);

    await expect(first).resolves.toBeNull();
    expect(firstShell.startCalls).toBe(0);
    expect(firstShell.destroyCalls).toBe(1);
    expect(secondShell.startCalls).toBe(1);
  });

  it('does not wait for shell.start and deduplicates destroy during the race', async () => {
    const controller = new VmSessionController();
    const startGate = deferred<void>();
    const shell = fakeShell(startGate.promise);
    const starting = controller.start(async () => shell);
    await Promise.resolve();
    await Promise.resolve();

    const destroying = controller.destroy();
    await expect(destroying).resolves.toBeUndefined();
    expect(shell.destroyCalls).toBe(1);

    startGate.resolve();
    await expect(starting).resolves.toBeNull();
    expect(shell.destroyCalls).toBe(1);
  });

  it('invalidates callbacks before destroying a shell whose start fails', async () => {
    const controller = new VmSessionController();
    const startError = new Error('start failed');
    let isCurrent!: () => boolean;
    const shell = {
      start: vi.fn(async () => {
        throw startError;
      }),
      destroy: vi.fn(async () => {
        expect(isCurrent()).toBe(false);
      }),
    } satisfies SessionRuntime;

    const starting = controller.start(async (context) => {
      isCurrent = context.isCurrent;
      return shell;
    });

    await expect(starting).rejects.toBe(startError);
    expect(shell.destroy).toHaveBeenCalledTimes(1);
    expect(isCurrent()).toBe(false);
  });

  it('invalidates a pending shell.start when a newer start replaces it', async () => {
    const controller = new VmSessionController();
    const startGate = deferred<void>();
    const firstShell = fakeShell(startGate.promise);
    const secondShell = fakeShell();
    const first = controller.start(async () => firstShell);
    await Promise.resolve();
    await Promise.resolve();

    const second = controller.start(async () => secondShell);
    await expect(second).resolves.toBe(secondShell);
    expect(firstShell.destroyCalls).toBe(1);
    expect(secondShell.startCalls).toBe(1);

    startGate.resolve();
    await expect(first).resolves.toBeNull();
    expect(firstShell.destroyCalls).toBe(1);
  });

  it('does not consume frames from an invalidated page generation', () => {
    let current = true;
    const onFrame = vi.fn();
    const callbacks = guardVmCallbacks({ onFrame }, () => current);
    const frame: VmFrame = {
      width: 1,
      height: 1,
      pixels: new Uint8Array([1]),
      palette: new Uint8Array(1024),
    };

    callbacks.onFrame?.(frame);
    current = false;
    callbacks.onFrame?.(frame);

    expect(onFrame).toHaveBeenCalledOnce();
  });
});
