import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@playwright/test';

/** Read-only, low-rate browser recording. The caller owns the page and must await stop(). */
export async function startBrowserRecording(page: Page, options: { path: string; ffmpeg: string }) {
  await mkdir(dirname(options.path), { recursive: true });
  const encoder = spawn(
    options.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-r',
      '1',
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'libvpx',
      '-b:v',
      '400k',
      '-r',
      '1',
      options.path,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let diagnostics = '';
  encoder.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-4096);
  });
  const exited = new Promise<void>((resolve, reject) => {
    encoder.once('error', reject);
    encoder.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Video encoder exited ${code ?? signal}: ${diagnostics}`)),
    );
  });
  // Capture and encoder failures are surfaced by stop(), even if the game itself succeeds.
  let encoderFailure: unknown;
  void exited.catch((error) => {
    encoderFailure = error;
  });
  const abort = new AbortController();
  const started = performance.now(),
    samples: number[] = [];
  let captureFailure: unknown;
  const recording = (async () => {
    while (!abort.signal.aborted) {
      const frameStarted = performance.now();
      if (encoderFailure) throw encoderFailure;
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 80, timeout: 10000 });
      await new Promise<void>((resolve, reject) =>
        encoder.stdin.write(jpeg, (error) => (error ? reject(error) : resolve())),
      );
      samples.push(performance.now() - started);
      await delay(Math.max(0, 1000 - (performance.now() - frameStarted)), undefined, { signal: abort.signal });
    }
  })().catch((error) => {
    if (!abort.signal.aborted || (error as Error).name !== 'AbortError') captureFailure = error;
  });
  let stopping: Promise<{ path: string; frames: number; elapsedMs: number }> | undefined;
  return {
    stop() {
      return (stopping ??= (async () => {
        abort.abort();
        await recording;
        encoder.stdin.end();
        await exited;
        const elapsedMs = performance.now() - started;
        await writeFile(`${options.path}.json`, JSON.stringify({ fps: 1, elapsedMs, sampleTimesMs: samples }, null, 2));
        if (captureFailure) throw captureFailure;
        if (!samples.length) throw new Error('Video contains no captured frames');
        return { path: options.path, frames: samples.length, elapsedMs };
      })());
    },
  };
}
