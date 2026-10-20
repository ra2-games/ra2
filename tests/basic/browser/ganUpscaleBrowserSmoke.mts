import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** GAN branch numerical regression: interpret weights independently, compare the old model, and consume output before timing. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  const result = await page.evaluate<{
    detail: string;
    firstDraws: number;
    cachedDraws: number;
    formatError: number;
    referenceError: number;
    changed: number;
    fastMs: number[];
    ganMs: number[];
  }>(`(async () => {
    const {createVmFrameRenderer}=await import('/src/ui/pages/game/vmFrameRenderer.ts');
    const {default:model}=await import('/src/ui/pages/game/vendor/Anime4K_Upscale_GAN_x2_M.glsl?raw');
    const width=7,height=5,rgba=new Uint8Array(width*height*4),packed=new Uint16Array(width*height),palette=new Uint8Array(1024);
    for(let i=0;i<packed.length;i++){
      const p=packed[i]=(i*7919)&65535,r=p>>>11,g=(p>>>5)&63,b=p&31;
      const c=[(r<<3)|(r>>>2),(g<<2)|(g>>>4),(b<<3)|(b>>>2),255];rgba.set(c,i*4);palette.set(c,i*4);
    }
    const base={width,height,pixels:Uint8Array.from({length:width*height},(_,i)=>i),palette};
    const canvas=document.createElement('canvas');canvas.width=width*2;canvas.height=height*2;
    const renderer=createVmFrameRenderer(canvas,true,false,null,false,true),gl=canvas.getContext('webgl2');
    let draws=0;const draw=gl.drawArrays.bind(gl);gl.drawArrays=(...a)=>{draws++;draw(...a);};
    const read=()=>{const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);if(gl.getError())throw new Error('WebGL 错误');return data;};
    const frame={...base,rgba};renderer.draw(frame,14,10);const actual=read(),firstDraws=draws;
    if(!renderer.upscaleStatus.includes('GAN'))throw new Error(renderer.upscaleStatus);
    draws=0;renderer.draw(frame,14,10);const cachedDraws=draws;read();
    let formatError=0;
    for(const f of [base,{...base,rgb565:packed}]){
      renderer.draw(f,14,10);const data=read();
      for(let i=0;i<data.length;i++)formatError=Math.max(formatError,Math.abs(data[i]-actual[i]));
    }
    const values=new Map([['MAIN',Float64Array.from(rgba,v=>v/255)]]);
    const half=v=>{if(v===0)return v;const step=2**(Math.max(-14,Math.floor(Math.log2(Math.abs(v))))-10);return Math.round(v/step)*step;};
    let reference;
    for(const [index,block] of model.split('//!DESC ').slice(1).entries()){
      const final=index===22,scale=final?2:1,w=width*scale,h=height*scale;
      const macros=new Map([...block.matchAll(/^#define (go_\\d+|g_\\d+)[^\\n]*$/gm)].map(m=>{
        const s=m[0];return [m[1],{input:s.match(/(\\w+)_tex/)[1],relu:s.includes('max('),negative:s.includes('max(-'),offsetScale:s.includes('* 0.5')?.5:1}];
      }));
      const terms=[...block.matchAll(/mat4\\(([^)]+)\\) \\* (go_\\d+|g_\\d+)(?:\\((-?[\\d.]+), (-?[\\d.]+)\\))?/g)]
        .map(m=>({weights:m[1].split(',').map(Number),...macros.get(m[2]),dx:Number(m[3]??0),dy:Number(m[4]??0)}));
      if(!terms.length)throw new Error('CPU 参考解析不到权重');
      const bias=block.match(/result \\+= vec4\\(([^)]+)\\)/)[1].split(',').map(Number),next=new Float64Array(w*h*4);
      for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let out=0;out<4;out++){
        let sum=bias[out];
        for(const term of terms){
          const tx=(x+.5)/scale+term.dx*term.offsetScale-.5,ty=(y+.5)/scale+term.dy*term.offsetScale-.5;
          const bx=Math.floor(tx),by=Math.floor(ty),fx=tx-bx,fy=ty-by;
          const source=values.get(term.input);
          for(let c=0;c<4;c++){
            let v=0;
            for(let j=0;j<2;j++)for(let i=0;i<2;i++){
              const sx=Math.max(0,Math.min(width-1,bx+i)),sy=Math.max(0,Math.min(height-1,by+j));
              v+=source[(sy*width+sx)*4+c]*(i?fx:1-fx)*(j?fy:1-fy);
            }
            if(term.relu)v=Math.max(term.negative?-v:v,0);
            sum+=term.weights[c*4+out]*v;
          }
        }
        if(final){
          const px=(x+.5)/2-.5,py=(y+.5)/2-.5,bx=Math.floor(px),by=Math.floor(py),fx=px-bx,fy=py-by;
          for(let j=0;j<2;j++)for(let i=0;i<2;i++){
            const sx=Math.max(0,Math.min(width-1,bx+i)),sy=Math.max(0,Math.min(height-1,by+j));
            sum+=rgba[(sy*width+sx)*4+out]/255*(i?fx:1-fx)*(j?fy:1-fy);
          }
          next[(y*w+x)*4+out]=Math.round(Math.max(0,Math.min(1,sum))*255);
        }else next[(y*w+x)*4+out]=half(sum);
      }
      if(final)reference=next;
      else values.set(block.match(/^\\/\\/!SAVE (\\w+)$/m)[1],next);
    }
    let referenceError=0;
    for(let y=0;y<height*2;y++)for(let x=0;x<width*2;x++)for(let c=0;c<4;c++){
      referenceError=Math.max(referenceError,Math.abs(reference[(y*width*2+x)*4+c]-actual[((height*2-y-1)*width*2+x)*4+c]));
    }
    const oldCanvas=document.createElement('canvas');oldCanvas.width=14;oldCanvas.height=10;
    const old=createVmFrameRenderer(oldCanvas,true,false,null,false,true,'fast'),oldGl=oldCanvas.getContext('webgl2');
    old.draw(frame,14,10);const previous=new Uint8Array(actual.length);oldGl.readPixels(0,0,14,10,oldGl.RGBA,oldGl.UNSIGNED_BYTE,previous);
    let changed=0;for(let i=0;i<actual.length;i++)if(Math.abs(actual[i]-previous[i])>2)changed++;
    const perf={width:320,height:240,pixels:new Uint8Array(),palette:new Uint8Array(),rgb565:new Uint16Array(320*240)};
    for(let i=0;i<perf.rgb565.length;i++)perf.rgb565[i]=(i*31)&65535;
    const measure=(r,c,g)=>{
      c.width=640;c.height=480;const out=new Uint8Array(640*480*4),samples=[];
      const consume=()=>g.readPixels(0,0,640,480,g.RGBA,g.UNSIGNED_BYTE,out);
      r.draw(perf,640,480);consume();
      for(let i=0;i<3;i++){const start=performance.now();r.draw({...perf},640,480);consume();samples.push(performance.now()-start);}
      return samples;
    };
    const fastMs=measure(old,oldCanvas,oldGl),ganMs=measure(renderer,canvas,gl),detail=renderer.detail;
    old.destroy();renderer.destroy();
    return {detail,firstDraws,cachedDraws,formatError,referenceError,changed,fastMs,ganMs};
  })()`);
  assert.equal(result.firstDraws, 25);
  assert.equal(result.cachedDraws, 1);
  assert.equal(result.formatError, 0);
  assert.ok(result.referenceError <= 3, 'GAN GPU 必须匹配独立权重计算');
  assert.ok(result.changed > 20, '新模型输出必须实际区别于旧 CNN');
  console.log(result);
} finally {
  await browser.close();
}
