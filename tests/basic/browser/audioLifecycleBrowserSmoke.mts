/** Exercise real audio-thread messages and repeated sink/context lifetimes without game resources. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  // Observe production nodes and messages; do not replace the processor, audio clock or destruction behavior.
  const result = await page.evaluate<{ cycles: number; contexts: string[]; processorCounts: number[] }>(`(async () => {
    const { WebAudioPcmSink } = await import('/src/adapter/audio.ts');
    const OriginalNode = AudioWorkletNode;
    const errors = [], contexts = [], processorCounts = [];
    let latest = null, created = 0, cycles = 0;
    globalThis.AudioWorkletNode = class extends OriginalNode {
      constructor(...args) {
        super(...args);
        const entry = { count: null, messages: 0, detach: null };
        const observe = event => {
          if(event.data.kind === 'position') {
            if(!Number.isFinite(event.data.at) || !Number.isInteger(event.data.revision)) {
              errors.push('Audio cursor report omitted its timestamp or revision');
            }
            entry.count = event.data.live;
            entry.messages++;
          }
        };
        this.port.addEventListener('message', observe);
        this.port.start();
        entry.detach = () => this.port.removeEventListener('message', observe);
        latest = entry;
        created++;
      }
    };
    const wait = async condition => {
      const deadline = performance.now() + 5000;
      while(!condition()) {
        if(errors.length) throw new Error(errors.join('; '));
        if(performance.now() > deadline) throw new Error('Audio lifecycle observation timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    try {
      // A fresh context must register its own processor after the previous session has closed.
      for(let session = 0; session < 2; session++) {
        const context = new AudioContext();
        const sink = new WebAudioPcmSink({ contextFactory: () => context, onError: e => errors.push(String(e)) });
        try {
          if(!await sink.unlock()) throw new Error('AudioContext did not enter running state');
          for(let cycle = 0; cycle < 16; cycle++) {
            const before = created;
            sink.createBuffer('music', 88200);
            sink.writeBuffer('music', 0, new Uint8Array(88200));
            if(!sink.play('music', {loop: true})) throw new Error('PCM playback failed');
            sink.writeBuffer('music', 1024, new Uint8Array(2048));
            await wait(() => created === before + 1 && latest.messages > 0 && latest.count === 1);
            processorCounts.push(latest.count);
            if(!sink.getState('music')?.playing) throw new Error('Stream stopped during playback');
            if(cycle % 2 === 0) sink.stop('music');
            if(!sink.releaseBuffer('music') || sink.getState('music') !== null) throw new Error('Buffer was retained');
            latest.detach();
            cycles++;
          }
        } finally {
          latest?.detach();
          await sink.destroy();
        }
        contexts.push(context.state);
        if(context.state !== 'closed') throw new Error('Sink retained its AudioContext');
      }
      if(errors.length) throw new Error(errors.join('; '));
      return { cycles, contexts, processorCounts };
    } finally {
      globalThis.AudioWorkletNode = OriginalNode;
    }
  })()`);
  assert.equal(result.cycles, 32);
  assert.deepEqual(result.contexts, ['closed', 'closed']);
  assert.deepEqual(result.processorCounts, new Array(32).fill(1));
  console.log(result);
} finally {
  await browser.close();
}
