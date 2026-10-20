import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** Real shader regression without game assets; start dev first. GPU/software-renderer timings are not game FPS. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  const result = await page.evaluate<{
    detail: string;
    bypassErrors: number;
    maxFormatError: number;
    maxReferenceError: number;
    flatErrors: number;
    cursorErrors: number;
    changed: number;
    nearestMs: number;
    spatialMs: number;
  }>(`(async () => {
    const { createVmFrameRenderer } = await import('/src/ui/pages/game/vmFrameRenderer.ts');
    const make = enabled => {
      const canvas = document.createElement('canvas');
      const renderer = createVmFrameRenderer(canvas, true, enabled);
      if (renderer.backend !== 'WebGL2') throw new Error('需要 WebGL2');
      return { canvas, renderer, gl: canvas.getContext('webgl2') };
    };
    const normal = make(false), sr = make(true);
    const width = 7, height = 5;
    const rgb565 = Uint16Array.from({length:width*height}, (_, i) => (i * 7919) & 65535);
    const rgba = new Uint8Array(width * height * 4), palette = new Uint8Array(1024);
    for (let i = 0; i < rgb565.length; i++) {
      const v = rgb565[i], r = v >>> 11, g = (v >>> 5) & 63, b = v & 31;
      const color = [(r << 3) | (r >>> 2), (g << 2) | (g >>> 4), (b << 3) | (b >>> 2), 255];
      rgba.set(color, i * 4); palette.set(color, i * 4);
    }
    const base = {width, height, palette, pixels: Uint8Array.from({length:width*height}, (_,i) => i)};
    const frames = [base, {...base, rgba}, {...base, rgb565}];
    const draw = (target, frame, w, h) => {
      target.canvas.width = w; target.canvas.height = h;
      target.renderer.draw(frame, w, h);
      const data = new Uint8Array(w*h*4);
      target.gl.readPixels(0, 0, w, h, target.gl.RGBA, target.gl.UNSIGNED_BYTE, data);
      if (target.gl.getError()) throw new Error('WebGL 错误');
      return data;
    };
    let maxFormatError = 0, bypassErrors = 0, changed = 0, maxReferenceError = 0;
    for (const [w,h] of [[7,5], [3,2]]) for (const frame of frames) {
      const a=draw(normal,frame,w,h), b=draw(sr,frame,w,h);
      for(let i=0;i<a.length;i++) if(a[i]!==b[i]) bypassErrors++;
    }
    const w=19,h=13, reference=draw(sr,frames[1],w,h), nearest=draw(normal,frames[1],w,h);
    for(const frame of frames) {
      const actual=draw(sr,frame,w,h);
      for(let i=0;i<actual.length;i++) maxFormatError=Math.max(maxFormatError,Math.abs(actual[i]-reference[i]));
    }
    for(let i=0;i<reference.length;i++) if(reference[i]!==nearest[i]) changed++;
    const weights = t => [-0.5*t+t*t-0.5*t*t*t,1-2.5*t*t+1.5*t*t*t,0.5*t+2*t*t-1.5*t*t*t,-0.5*t*t+0.5*t*t*t];
    // Independent CPU reference for tests only; readPixels is bottom-up, while input frames are top-down.
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const px=(x+0.5)*width/w-0.5, py=(h-y-0.5)*height/h-0.5;
      const bx=Math.floor(px),by=Math.floor(py),wx=weights(px-bx),wy=weights(py-by);
      for(let c=0;c<4;c++) {
        let sum=0,lo=255,hi=0;
        for(let j=0;j<4;j++) for(let i=0;i<4;i++) {
          const sx=Math.max(0,Math.min(width-1,bx+i-1)),sy=Math.max(0,Math.min(height-1,by+j-1));
          const v=rgba[(sy*width+sx)*4+c]; sum+=v*wx[i]*wy[j];
          if(i>=1&&i<=2&&j>=1&&j<=2){lo=Math.min(lo,v);hi=Math.max(hi,v);}
        }
        maxReferenceError=Math.max(maxReferenceError,Math.abs(reference[(y*w+x)*4+c]-Math.round(Math.max(lo,Math.min(hi,sum)))));
      }
    }
    const constant = {...base, rgba: new Uint8Array(width*height*4)};
    for(let i=0;i<width*height;i++) constant.rgba.set([17,83,219,255],i*4);
    const flat=draw(sr,constant,19,13);
    let flatErrors=0;
    for(let i=0;i<flat.length;i++) if(flat[i]!==[17,83,219,255][i%4]) flatErrors++;
    const cursor={width:1,height:1,hotspotX:0,hotspotY:0,x:2,y:2,rgba:new Uint8Array([255,0,255,255])};
    const a=draw(normal,{...constant,cursor},14,10),b=draw(sr,{...constant,cursor},14,10);
    let cursorErrors=0;
    for(let i=0;i<a.length;i++) if(a[i]!==b[i]) cursorErrors++;
    // High-resolution output from asynchronous full-frame models must not change native cursor size or coordinates.
    const enlarged = {width:14,height:10,pixels:new Uint8Array(),palette:new Uint8Array(),rgba:new Uint8Array(14*10*4)};
    for(let i=0;i<14*10;i++) enlarged.rgba.set([17,83,219,255],i*4);
    normal.renderer.draw(enlarged,14,10,undefined,{...constant,cursor});
    const liveCursor = new Uint8Array(14*10*4);
    normal.gl.readPixels(0,0,14,10,normal.gl.RGBA,normal.gl.UNSIGNED_BYTE,liveCursor);
    for(let i=0;i<a.length;i++) if(a[i]!==liveCursor[i]) cursorErrors++;
    const perfFrame={width:800,height:600,pixels:new Uint8Array(),palette:new Uint8Array(),rgb565:new Uint16Array(800*600)};
    for(let i=0;i<perfFrame.rgb565.length;i++) perfFrame.rgb565[i]=(i*31)&65535;
    const measure = target => {
      target.canvas.width=1600;target.canvas.height=1200;
      for(let i=0;i<8;i++)target.renderer.draw(perfFrame,1600,1200);
      const consumed = new Uint8Array(1600*1200*4);
      const consume = () => target.gl.readPixels(0,0,1600,1200,target.gl.RGBA,target.gl.UNSIGNED_BYTE,consumed);
      consume();
      const batches=[];
      for(let batch=0;batch<5;batch++){
        const start=performance.now();
        for(let i=0;i<8;i++)target.renderer.draw(perfFrame,1600,1200);
        consume(); batches.push((performance.now()-start)/8);
      }
      return batches.sort((a,b)=>a-b)[2];
    };
    const nearestMs=measure(normal),spatialMs=measure(sr),detail=sr.renderer.detail;
    normal.renderer.destroy();sr.renderer.destroy();
    return {detail,bypassErrors,maxFormatError,maxReferenceError,flatErrors,cursorErrors,changed,nearestMs,spatialMs};
  })()`);
  assert.equal(result.bypassErrors, 0, '1:1/缩小必须保持原像素');
  assert.ok(result.maxFormatError <= 1, '三种帧格式必须等价');
  assert.ok(result.maxReferenceError <= 1, 'GPU 必须匹配 CPU 重建参考');
  assert.equal(result.flatErrors, 0, '纯色与边界不得污染');
  assert.equal(result.cursorErrors, 0, '光标不经过重建');
  assert.ok(result.changed > 0, '放大开关必须实际改变输出');
  console.log(result);
} finally {
  await browser.close();
}
