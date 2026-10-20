import { afterEach, expect, it, vi } from 'vitest';
import { ProxyAudioSink } from '../../src/adapter/audioProxy';
import { AudioStateFeedback } from '../../src/adapter/audioFeedback';
import type { WorkerToMainMessage } from '../../src/adapter/vmProtocol';
import type { Win32AudioSink } from '../../src/vm86/win32';
import { DEFAULT_PCM_FORMAT } from '../../src/vm86/audio';

const format = DEFAULT_PCM_FORMAT;
afterEach(() => vi.useRealTimers());

it('transfers exclusive PCM copies and returns accepted bytes after detachment', () => {
  const received: WorkerToMainMessage[] = [];
  const sink = new ProxyAudioSink((message, transfer) => received.push(structuredClone(message, { transfer })));
  sink.createBuffer(1, 8, format);
  const source = new Uint8Array([1, 2, 3, 4]);
  expect(sink.writeBuffer(1, 6, source)).toBe(2);
  expect(source).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(received.at(-1)).toMatchObject({ op: { offset: 6, bytes: new Uint8Array([1, 2]) } });
  expect(sink.writeBuffer(1, 0, source)).toBe(4);
  expect(source.byteLength).toBe(4);
  expect(sink.writeBuffer(2, 0, source)).toBe(0);
});

it('holds the observed cursor until feedback and rejects reports from superseded commands and buffers', () => {
  vi.useFakeTimers();
  let revision = 0;
  const sink = new ProxyAudioSink((message) => {
    if (message.type === 'audio' && message.revision !== undefined) revision = message.revision;
  });
  const report = () => ({ id: 1, revision, positionBytes: 40, writePositionBytes: 80, playing: true });
  sink.createBuffer(1, 400, format);
  sink.play(1);
  const old = report();
  sink.acceptState([old]);
  vi.advanceTimersByTime(5000);
  expect(sink.getState(1)).toEqual({ positionBytes: 40, writePositionBytes: 80, playing: true });
  sink.setCurrentPosition(1, 200);
  sink.acceptState([old]);
  expect(sink.getState(1)!.positionBytes).toBe(200);
  sink.stop(1);
  sink.acceptState([old]);
  expect(sink.getState(1)!.playing).toBe(false);
  sink.releaseBuffer(1);
  sink.createBuffer(1, 400, format);
  sink.acceptState([old]);
  expect(sink.getState(1)).toEqual({ positionBytes: 0, writePositionBytes: 0, playing: false });
  sink.play(1);
  sink.acceptState([{ ...report(), playing: false, positionBytes: 0, writePositionBytes: 0 }]);
  expect(sink.getState(1)!.playing).toBe(false);
});

it('batches changed sink observations and stops polling on release or session cleanup', () => {
  vi.useFakeTimers();
  let state = { positionBytes: 4, writePositionBytes: 8, playing: true };
  const getState = vi.fn(() => state);
  const send = vi.fn();
  const feedback = new AudioStateFeedback({ getState } as unknown as Win32AudioSink, send);
  feedback.applied({ op: 'play', id: 1 }, 10);
  expect(send).toHaveBeenLastCalledWith([{ id: 1, revision: 10, ...state }]);
  vi.advanceTimersByTime(20);
  expect(send).toHaveBeenCalledTimes(1);
  state = { positionBytes: 12, writePositionBytes: 16, playing: true };
  vi.advanceTimersByTime(10);
  expect(send).toHaveBeenLastCalledWith([{ id: 1, revision: 10, ...state }]);
  feedback.applied({ op: 'stop', id: 1 }, 11);
  expect(send).toHaveBeenLastCalledWith([{ id: 1, revision: 11, ...state }]);
  feedback.applied({ op: 'releaseBuffer', id: 1 }, 12);
  expect(vi.getTimerCount()).toBe(0);
  feedback.applied({ op: 'play', id: 2 }, 13);
  feedback.clear();
  const calls = getState.mock.calls.length;
  vi.advanceTimersByTime(100);
  expect(getState).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});
