import { expect, it, vi } from 'vitest';
import { ControlSession } from '../../src/app/session/controlSession';

it('closes replaced connections and rejects outstanding responses from an old game session', async () => {
  const session = new ControlSession();
  let resolve!: (value: unknown) => void;
  session.attach(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let request!: (method: string, params: unknown) => Promise<unknown>;
  const close = vi.fn();
  session.connect((handler) => {
    request = handler;
    return close;
  });
  const pending = request('observe', undefined);
  const assertion = expect(pending).rejects.toThrow('replaced');
  session.attach(async () => 'new session');
  resolve('stale');
  await assertion;
  expect(close).toHaveBeenCalledOnce();
  await expect(request('command', {})).rejects.toThrow('replaced');
  session.dispose();
  expect(() => session.connect(() => close)).toThrow('No running');
});

it('reports commands and follows receipts without requiring CLI polling; disconnect cancels polling', async () => {
  vi.useFakeTimers();
  const activity = vi.fn();
  const endpoint = vi.fn(async (method: string) => ({ state: method === 'command' ? 'pending' : 'submitted' }));
  const session = new ControlSession(activity);
  let request!: (method: string, params: unknown) => Promise<unknown>;
  try {
    session.attach(endpoint);
    session.connect((handler) => {
      request = handler;
      return () => {};
    });
    const params = { sessionId: 'battle', commandId: 'train', action: 'produce', type: 'MTNK' };
    await request('command', params);
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'request', params }));
    await vi.advanceTimersByTimeAsync(500);
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reply', method: 'commandStatus', result: { state: 'submitted' } }),
    );
    await request('command', { ...params, commandId: 'second' });
    session.disconnect();
    const calls = endpoint.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(endpoint).toHaveBeenCalledTimes(calls);
    expect(activity).toHaveBeenCalledWith({ kind: 'disconnect' });
    await expect(request('command', params)).rejects.toThrow('replaced');
  } finally {
    session.dispose();
    vi.useRealTimers();
  }
});

it('does not let a broken journal swallow successful orders or change native errors', async () => {
  const session = new ControlSession(() => {
    throw new Error('UI failed');
  });
  let request!: (method: string, params: unknown) => Promise<unknown>;
  session.attach(async (_method, params) => {
    if (params === null) throw new Error('Native rejection');
    return { state: 'submitted' };
  });
  session.connect((handler) => {
    request = handler;
    return () => {};
  });
  expect(await request('command', {})).toEqual({ state: 'submitted' });
  await expect(request('command', null)).rejects.toThrow('Native rejection');
  session.dispose();
});
