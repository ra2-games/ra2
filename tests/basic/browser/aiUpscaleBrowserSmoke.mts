import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** Compare real CNN shaders against an independent CPU reference without game assets or a model CDN. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  // Wait for page-service initialization before publishing test state through an independent renderer, so initial page state cannot overwrite it.
  await page.getByRole('button', { name: '加载游戏', exact: true }).waitFor();
  const result = await page.evaluate<{
    detail: string;
    status: string;
    activeIndicator: boolean;
    waitingIndicator: boolean;
    fallbackIndicator: boolean;
    firstDraws: number;
    cachedDraws: number;
    cachedErrors: number;
    formatError: number;
    maxReferenceError: number;
    learnedDifferences: number;
    bypassErrors: number;
    pointerDraws: number;
    framebufferRestored: boolean;
    destroyNoop: boolean;
    inferenceAndReadbackMs: number[];
  }>(`(async () => {
    const { createVmFrameRenderer } = await import('/src/ui/pages/game/vmFrameRenderer.ts');
    const { upscaleStatus } = await import('/src/ui/pages/game/state/uiState.ts');
    const updateUpscaleIndicator = async (status) => {
      upscaleStatus.set(status);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    const { default: model } = await import('/src/ui/pages/game/vendor/Anime4K_Upscale_CNN_x2_S.glsl?raw');
    const canvas=document.createElement('canvas');canvas.width=14;canvas.height=10;
    const renderer=createVmFrameRenderer(canvas,true,false,null,false,true,'fast'),gl=canvas.getContext('webgl2');
    if(!gl)throw new Error('需要 WebGL2');
    let draws=0;const originalDraw=gl.drawArrays.bind(gl);
    gl.drawArrays=(...args)=>{draws++;originalDraw(...args);};
    const width=7,height=5,rgba=new Uint8Array(width*height*4),rgb565=new Uint16Array(width*height),palette=new Uint8Array(1024);
    for(let i=0;i<width*height;i++){
      const p=rgb565[i]=(i*7919)&65535,r=p>>>11,g=(p>>>5)&63,b=p&31;
      const color=[(r<<3)|(r>>>2),(g<<2)|(g>>>4),(b<<3)|(b>>>2),255];rgba.set(color,i*4);palette.set(color,i*4);
    }
    const base={width,height,pixels:Uint8Array.from({length:width*height},(_,i)=>i),palette},frame={...base,rgba};
    const read=()=>{const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);if(gl.getError())throw new Error('WebGL 错误');return data;};
    renderer.draw(frame,14,10);const actual=read(),firstDraws=draws;
    if(!canvas.dataset.upscale?.includes('快速模式'))throw new Error(canvas.dataset.upscale || 'AI 未启动');
    const indicator=document.getElementById('vm-upscale-status');
    await updateUpscaleIndicator(renderer.upscaleStatus);
    const activeIndicator=!indicator.hidden&&indicator.textContent.includes('已启动')&&getComputedStyle(indicator).pointerEvents==='none';
    draws=0;renderer.draw(frame,14,10);const cachedDraws=draws,cached=read();
    let cachedErrors=0;for(let i=0;i<actual.length;i++)if(actual[i]!==cached[i])cachedErrors++;
    let formatError=0;
    for(const other of [base,{...base,rgb565}]){
      renderer.draw(other,14,10);const data=read();
      for(let i=0;i<data.length;i++)formatError=Math.max(formatError,Math.abs(actual[i]-data[i]));
    }
    // Interpret the fixed weight matrix independently; CPU images run top to bottom, while GLSL mat4 constants are column-major.
    let values=Float64Array.from(rgba,v=>v/255);
    for(const block of model.split('//!DESC ').slice(1,5)){
      const terms=[...block.matchAll(/mat4\\(([^)]+)\\) \\* go_([01])\\((-?[\\d.]+), (-?[\\d.]+)\\)/g)]
        .map(m=>({weights:m[1].split(',').map(Number),negative:m[2]==='1',dx:Number(m[3]),dy:Number(m[4])}));
      const bias=block.match(/result \\+= vec4\\(([^)]+)\\)/)[1].split(',').map(Number);
      const first=terms.length===9,next=new Float64Array(values.length);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let out=0;out<4;out++){
        let sum=bias[out];
        for(const term of terms){
          const sx=Math.max(0,Math.min(width-1,x+term.dx)),sy=Math.max(0,Math.min(height-1,y+term.dy));
          for(let input=0;input<4;input++){
            let v=values[(sy*width+sx)*4+input];if(!first)v=Math.max(term.negative?-v:v,0);
            sum+=term.weights[input*4+out]*v;
          }
        }
        next[(y*width+x)*4+out]=sum;
      }
      values=next;
    }
    let maxReferenceError=0,learnedDifferences=0;
    for(let y=0;y<height*2;y++)for(let x=0;x<width*2;x++){
      const residual=values[(Math.floor(y/2)*width+Math.floor(x/2))*4+(y%2)*2+x%2];
      const px=(x+.5)/2-.5,py=(y+.5)/2-.5,bx=Math.floor(px),by=Math.floor(py),fx=px-bx,fy=py-by;
      for(let c=0;c<3;c++){
        let source=0;
        for(let j=0;j<2;j++)for(let i=0;i<2;i++){
          const sx=Math.max(0,Math.min(width-1,bx+i)),sy=Math.max(0,Math.min(height-1,by+j));
          source+=rgba[(sy*width+sx)*4+c]*(i?fx:1-fx)*(j?fy:1-fy);
        }
        const expected=Math.round(Math.max(0,Math.min(255,source+residual*255)));
        const value=actual[((height*2-1-y)*width*2+x)*4+c];
        maxReferenceError=Math.max(maxReferenceError,Math.abs(expected-value));
        if(Math.abs(value-Math.round(source))>2)learnedDifferences++;
      }
    }
    // The 1:1 bypass must restore original pixels without mixing in cached AI output.
    canvas.width=width;canvas.height=height;renderer.draw(frame,width,height);const bypass=read();
    await updateUpscaleIndicator(renderer.upscaleStatus);
    const waitingIndicator=!indicator.hidden&&indicator.textContent.includes('放大不足');
    let bypassErrors=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<4;c++){
      if(bypass[((height-1-y)*width+x)*4+c]!==rgba[(y*width+x)*4+c])bypassErrors++;
    }
    canvas.width=14;canvas.height=10;renderer.draw(frame,14,10);
    draws=0;renderer.draw(frame,14,10,{x:3,y:2,visible:true});const pointerDraws=draws;
    // Include synchronous readback in timing to consume GPU results and prevent the browser from discarding unobserved draws.
    const perf={width:320,height:240,pixels:new Uint8Array(),palette:new Uint8Array(),rgb565:new Uint16Array(320*240)};
    for(let i=0;i<perf.rgb565.length;i++)perf.rgb565[i]=(i*31)&65535;
    canvas.width=640;canvas.height=480;
    renderer.draw(perf,640,480);read();
    const samples=[];
    for(let i=0;i<5;i++){
      const start=performance.now();renderer.draw({...perf},640,480);read();samples.push(performance.now()-start);
    }
    // Repeatedly switch models for the same frame/context, verifying real shaders retain no stale textures or caches.
    canvas.width=14;canvas.height=10;
    const switches=[];
    for(const mode of ['off','bicubic','gan','fast','off','fast']) {
      renderer.setUpscaleMode(mode);draws=0;renderer.draw(frame,14,10);
      const pixels=read();
      switches.push({mode,draws,status:renderer.upscaleStatus});
      if(mode==='fast'&&pixels.some((v,i)=>v!==actual[i]))throw new Error('切回 CNN 后像素不一致');
      if(canvas.getContext('webgl2')!==gl)throw new Error('切换不应替换上下文');
    }
    if(switches.map(s=>s.draws).join(',')!=='1,1,25,7,1,7')throw new Error('切换绘制管线不匹配');
    const detail=renderer.detail,framebufferRestored=gl.getParameter(gl.FRAMEBUFFER_BINDING)===null;
    renderer.destroy();const before=draws;renderer.draw(frame,14,10);
    const fallbackCanvas=document.createElement('canvas');
    const fallback=createVmFrameRenderer(fallbackCanvas,false,false,null,false,true);
    await updateUpscaleIndicator(fallback.upscaleStatus);
    const fallbackIndicator=!indicator.hidden&&indicator.textContent.includes('Canvas 2D');
    fallback.destroy();await updateUpscaleIndicator(null);
    return {detail,status:canvas.dataset.upscale,activeIndicator,waitingIndicator,fallbackIndicator,firstDraws,cachedDraws,cachedErrors,formatError,maxReferenceError,learnedDifferences,bypassErrors,pointerDraws,framebufferRestored,destroyNoop:draws===before,inferenceAndReadbackMs:samples};
  })()`);
  assert.equal(result.firstDraws, 7);
  assert.equal(result.cachedDraws, 1);
  assert.equal(result.pointerDraws, 1);
  assert.equal(result.cachedErrors, 0);
  assert.equal(result.formatError, 0);
  assert.ok(result.maxReferenceError <= 2, '半精度 GPU 输出应匹配独立卷积参考');
  assert.ok(result.learnedDifferences > 20, '必须实际使用学习到的残差，而非仅插值');
  assert.equal(result.bypassErrors, 0);
  assert.equal(result.framebufferRestored, true);
  assert.equal(result.destroyNoop, true);
  assert.equal(result.activeIndicator, true);
  assert.equal(result.waitingIndicator, true);
  assert.equal(result.fallbackIndicator, true);
  console.log(result);
} finally {
  await browser.close();
}
