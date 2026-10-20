import { afterEach, expect, it, vi } from 'vitest';
import { DelayedStream } from '../helpers/latencyProxy';

afterEach(() => vi.useRealTimers());

it('固定延迟并保持顺序，不为每个字节块额外累加一次延迟，结束前不截断', async () => {
  vi.useFakeTimers();
  const stream = new DelayedStream(15),
    received: string[] = [];
  stream.on('data', (chunk) => received.push(chunk.toString()));
  stream.write('a');
  stream.write('b');
  stream.end('c');
  await vi.advanceTimersByTimeAsync(14);
  expect(received).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(received).toEqual(['a', 'b', 'c']);
  expect(stream.readableEnded).toBe(true);
});

it('接收端不读取时施加反压，恢复读取后保持所有字节', async () => {
  vi.useFakeTimers();
  const stream = new DelayedStream(15);
  const payload = Buffer.alloc(stream.writableHighWaterMark, 7);
  for (let i = 0; i < 8; i++) stream.write(payload);
  await vi.advanceTimersByTimeAsync(1000);
  expect(stream.readableLength).toBeLessThanOrEqual(payload.length);
  let bytes = 0;
  stream.on('data', (chunk) => {
    bytes += chunk.length;
  });
  stream.end();
  await vi.advanceTimersByTimeAsync(1000);
  expect(bytes).toBe(payload.length * 8);
  expect(stream.readableEnded).toBe(true);
});

it('销毁取消尚未投递的内容', async () => {
  vi.useFakeTimers();
  const stream = new DelayedStream(15),
    receive = vi.fn();
  stream.on('data', receive);
  stream.write('pending');
  stream.destroy();
  await vi.advanceTimersByTimeAsync(100);
  expect(receive).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
