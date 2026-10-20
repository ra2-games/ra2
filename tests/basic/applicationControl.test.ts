import { expect, it, vi } from 'vitest';
import { createApplicationControl } from '../../src/app/session/applicationControl';
import { ControlSession } from '../../src/app/session/controlSession';

function fixture() {
  const state = { pageId: '1', phase: 'running', hasResources: true, hasRuntime: true };
  let finish!: () => void;
  const quickStart = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const runtime = vi.fn(async () => ({ page: 'GUI:MainMenu' }));
  const control = createApplicationControl({ state: () => state, runtime, quickStart });
  return { state, quickStart, runtime, control, finish: () => finish() };
}
const command = { commandId: 'start-1', expectedPageId: '1', replaceSession: true };

it('captures only the current page and rejects results completed after replacement or disposal', async () => {
  const state = { pageId: '1', phase: 'running', hasResources: true, hasRuntime: true };
  let finish!: (value: unknown) => void;
  const capture = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        finish = resolve;
      }),
  );
  const control = createApplicationControl({
    state: () => state,
    capture,
    runtime: async () => null,
    quickStart: async () => {},
  });
  expect(await control.request('ui.status')).toMatchObject({ actions: ['ui.quickStart', 'ui.screenshot'] });
  await expect(control.request('ui.screenshot', { expectedPageId: 'old' })).rejects.toThrow('Stale');
  expect(capture).not.toHaveBeenCalled();
  const first = control.request('ui.screenshot', { expectedPageId: '1' });
  finish({ presentation: 4 });
  expect(await first).toEqual({ pageId: '1', image: { presentation: 4 } });
  const replaced = control.request('ui.screenshot', { expectedPageId: '1' });
  state.pageId = '2';
  finish({ presentation: 5 });
  await expect(replaced).rejects.toThrow('Session changed');
  const disposed = control.request('ui.screenshot', { expectedPageId: '2' });
  control.dispose();
  finish({ presentation: 6 });
  await expect(disposed).rejects.toThrow('Session changed');
});

it('does not forward screenshot requests to unsupported runtimes', async () => {
  const f = fixture();
  await expect(f.control.request('ui.screenshot', { expectedPageId: '1' })).rejects.toThrow('unavailable');
  expect(f.runtime).not.toHaveBeenCalled();
});

it('requires resources, a fresh page and explicit replacement before starting', async () => {
  const f = fixture();
  await expect(f.control.request('ui.quickStart', { ...command, expectedPageId: 'old' })).rejects.toThrow('Stale');
  await expect(f.control.request('ui.quickStart', { ...command, replaceSession: false })).rejects.toThrow(
    'replaceSession',
  );
  f.state.hasResources = false;
  await expect(f.control.request('ui.quickStart', command)).rejects.toThrow('Import');
  expect(f.quickStart).not.toHaveBeenCalled();
  expect(await f.control.request('ui.status')).toMatchObject({ actions: [], runtime: { page: 'GUI:MainMenu' } });
});

it('keeps the channel connected across restart and deduplicates accepted requests across page generations', async () => {
  const f = fixture();
  const session = new ControlSession();
  session.attach(f.control.request);
  let request!: typeof f.control.request;
  const close = vi.fn();
  session.connect((handler) => {
    request = handler;
    return close;
  });
  expect(await request('ui.quickStart', command)).toMatchObject({ state: 'submitted' });
  f.state.pageId = '2';
  expect(await request('ui.quickStart', command)).toMatchObject({ state: 'submitted' });
  expect(f.quickStart).toHaveBeenCalledOnce();
  await expect(request('ui.quickStart', { ...command, replaceSession: false })).rejects.toThrow('reused');
  await expect(request('ui.quickStart', { ...command, commandId: 'second', expectedPageId: '2' })).rejects.toThrow(
    'progress',
  );
  expect(await request('ui.status')).toMatchObject({ pageId: '2', starting: true });
  f.finish();
  await vi.waitFor(async () => expect(await request('ui.status')).toMatchObject({ starting: false }));
  await request('observe');
  expect(f.runtime).toHaveBeenLastCalledWith('observe', undefined);
  expect(close).not.toHaveBeenCalled();
  session.dispose();
});

it('reports asynchronous launch failures and prevents delayed work after disposal', async () => {
  const state = { pageId: '1', phase: 'running', hasResources: true, hasRuntime: true };
  const quickStart = vi.fn(async () => {
    throw new Error('native startup failed');
  });
  const f = createApplicationControl({ state: () => state, runtime: async () => null, quickStart });
  await f.request('ui.quickStart', command);
  await vi.waitFor(async () =>
    expect(await f.request('ui.status')).toMatchObject({ starting: false, failure: 'native startup failed' }),
  );
  const g = createApplicationControl({ state: () => state, runtime: async () => null, quickStart });
  const accepted = g.request('ui.quickStart', command);
  g.dispose();
  await accepted;
  await Promise.resolve();
  expect(quickStart).toHaveBeenCalledOnce();
  await expect(g.request('ui.status')).rejects.toThrow('disposed');
});
