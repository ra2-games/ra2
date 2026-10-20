import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  const result = await page.evaluate<{
    pixel: number[];
    smallMime: string;
    largeMime: string;
    width: number;
    height: number;
    sourceWidth: number;
    withinLimit: boolean;
  }>(`(async () => {
    const { encodeFrameImage } = await import('/src/platform/browser/frameImage.ts');
    const { MAX_CONTROL_MESSAGE } = await import('/.agents/skills/ra2-battle-control/scripts/protocol.ts');
    const small = encodeFrameImage({width: 1, height: 1, presentation: 1, rgba: new Uint8ClampedArray([12, 34, 56, 255])});
    const image = new Image(); image.src = small.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixel = [...context.getImageData(0,0,1,1).data];
    const rgba = new Uint8ClampedArray(1800 * 1200 * 4);
    let seed = 17;
    for (let i = 0; i < rgba.length; i += 4) {
      for (let c = 0; c < 3; c++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; rgba[i+c] = seed >>> 24; }
      rgba[i+3] = 255;
    }
    const large = encodeFrameImage({width:1800,height:1200,presentation:2,rgba});
    const decoded = new Image(); decoded.src = large.dataUrl; await decoded.decode();
    return {pixel, smallMime:small.mimeType, largeMime:large.mimeType, width:decoded.width, height:decoded.height,
      sourceWidth:large.sourceWidth, withinLimit:JSON.stringify({id:'request',result:{pageId:'1',image:large}}).length < MAX_CONTROL_MESSAGE};
  })()`);
  assert.deepEqual(result.pixel, [12, 34, 56, 255]);
  assert.equal(result.smallMime, 'image/png');
  assert.equal(result.largeMime, 'image/jpeg');
  assert.equal(result.width, 1600);
  assert.equal(result.height, 1067);
  assert.equal(result.sourceWidth, 1800);
  assert.equal(result.withinLimit, true);
  console.log('Browser frame encoding passed:', result);
} finally {
  await browser.close();
}
