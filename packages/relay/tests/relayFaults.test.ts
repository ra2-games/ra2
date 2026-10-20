import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayFaults, parseRelayFaultConfig } from '../src/server/relayFaults';

const from = { id: 1, clientId: 'a' };
const to = { id: 2, clientId: 'b' };
afterEach(() => vi.useRealTimers());

describe('中继弱网模拟', () => {
  it('拒绝未知、越界和非数值配置', () => {
    expect(parseRelayFaultConfig(undefined)).toBeUndefined();
    for (const json of ['[]', 'null', '{"lossRate":2}', '{"delayMs":-1}', '{"seed":1.2}', '{"room":""}', '{"foo":1}']) {
      expect(() => parseRelayFaultConfig(json)).toThrow();
    }
  });

  it('固定种子的丢包决定可复现，且规则只匹配指定方向和房间', () => {
    const run = () => {
      const faults = new RelayFaults({ seed: 42, lossRate: 0.5, room: 'r', fromClientId: 'a', toClientId: 'b' });
      const results: boolean[] = [];
      for (let i = 0; i < 100; i++) faults.route('r', from, to, 10, (ok) => results.push(ok));
      faults.route('other', from, to, 10, (ok) => expect(ok).toBe(true));
      faults.route('r', to, from, 10, (ok) => expect(ok).toBe(true));
      faults.close();
      return results;
    };
    const results = run();
    expect(results).toEqual(run());
    expect(results).toContain(true);
    expect(results).toContain(false);
  });

  it('延迟抖动保序，队列有界，关闭释放所有定时器', () => {
    vi.useFakeTimers();
    const faults = new RelayFaults({ delayMs: 100, jitterMs: 90, maxQueuedPackets: 2 });
    const received: number[] = [];
    for (let i = 0; i < 3; i++) faults.route('r', from, to, 10, (ok) => received.push(ok ? i : -i));
    expect(received).toEqual([-2]);
    expect(faults.getStats()).toMatchObject({ queuedPackets: 2, queuedBytes: 20 });
    vi.advanceTimersByTime(200);
    expect(received).toEqual([-2, 0, 1]);
    faults.route('r', from, to, 10, (ok) => expect(ok).toBe(false));
    faults.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(faults.getStats().queuedBytes).toBe(0);
  });

  it('带宽限制累计发送时间，退出会取消旧连接数据', () => {
    vi.useFakeTimers();
    const faults = new RelayFaults({ bytesPerSecond: 100 });
    const done = vi.fn();
    faults.route('r', from, to, 10, done);
    faults.route('r', from, to, 10, done);
    vi.advanceTimersByTime(100);
    expect(done.mock.calls).toEqual([[true]]);
    faults.disconnect(from.id);
    expect(done.mock.calls).toEqual([[true], [false]]);
    vi.advanceTimersByTime(1000);
    expect(done).toHaveBeenCalledTimes(2);
    expect(faults.getStats().queuedPackets).toBe(0);
    faults.close();
  });

  it('黑洞到期后恢复投递，字节上限会拒绝积压', () => {
    vi.useFakeTimers();
    const faults = new RelayFaults({ blackholeMs: 500, delayMs: 10, maxQueuedBytes: 10 });
    const done = vi.fn();
    faults.route('r', from, to, 10, done);
    expect(done.mock.calls).toEqual([[false]]);
    vi.advanceTimersByTime(500);
    faults.route('r', from, to, 10, done);
    faults.route('r', from, to, 1, done);
    vi.advanceTimersByTime(10);
    expect(done.mock.calls).toEqual([[false], [false], [true]]);
    faults.close();
  });
});
