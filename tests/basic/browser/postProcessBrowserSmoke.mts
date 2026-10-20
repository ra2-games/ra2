import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15185/');
  const result = await page.evaluate<{ checks: number }>(`(async () => {
    const {createVmFrameRenderer} = await import('/src/ui/pages/game/vmFrameRenderer.ts');
    const {ColorPostProcess} = await import('/src/graphics/framePostProcess.ts');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=8;
    const renderer=createVmFrameRenderer(canvas), gl=canvas.getContext('webgl2');
    if(!gl)throw Error('WebGL2 required');
    const vertex='#version 300 es\\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}';
    const fragment='#version 300 es\\nprecision highp float;uniform sampler2D image;out vec4 color;void main(){vec4 c=texelFetch(image,ivec2(gl_FragCoord.xy),0);color=vec4(1.0-c.rgb,1);}';
    const read=()=>{const b=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,b);const error=gl.getError();if(error)throw Error('WebGL error '+error+' checks='+checks);return b;};
    let checks=0;
    for(const size of [8,13]) {
      canvas.width=canvas.height=size;
      const rgba=Uint8Array.from({length:size*size*4},(_,i)=>i%4===3?255:(i*13)%256);
      const palette=Uint8Array.from({length:1024},(_,i)=>i%4===3?255:(i*7)%256);
      for(const pixels of [{rgba},{rgb565:Uint16Array.from({length:size*size},(_,i)=>i*179)},{pixels:Uint8Array.from({length:size*size},(_,i)=>i),palette}]) {
        const frame={width:size,height:size,pixels:new Uint8Array(),palette:new Uint8Array(),...pixels};
        renderer.setPostProcess(null);renderer.draw(frame,size,size);const base=read();
        renderer.setPostProcess(gl=>new ColorPostProcess(gl,{vertex,fragment,colorSampler:'image'}));
        for(let n=0;n<2;n++) {renderer.draw(frame,size,size);const actual=read();for(let i=0;i<base.length;i++)if(actual[i] !== (i%4===3?255:255-base[i]))throw Error('pixel mismatch '+i);checks++;}
        renderer.setPostProcess(null);renderer.draw(frame,size,size);const back=read();if(back.some((v,i)=>v!==base[i]))throw Error('disable mismatch');
      }
    }
    const {createReShadePreset}=await import('/src/graphics/reshadePreset.ts');
    const sample={width:13,height:13,pixels:new Uint8Array(),palette:new Uint8Array(),rgba:Uint8Array.from({length:13*13*4},(_,i)=>i%4===3?255:(i*17)%256)};
    renderer.setPostProcess(null);renderer.draw(sample,13,13);const original=read();
    renderer.setPostProcess(gl=>createReShadePreset(gl));renderer.draw(sample,13,13);const enhanced=read();
    if(!enhanced.some((v,i)=>v!==original[i]))throw Error('ReShade preset did not change colors');
    renderer.setPostProcess(gl=>createReShadePreset(gl,true));renderer.draw(sample,13,13);const compared=read();
    for(let i=0;i<compared.length;i++){const x=Math.floor(i/4)%13;const expected=x+0.5<6.5?original[i]:enhanced[i];if(compared[i]!==expected)throw Error('ReShade split mismatch');}
    renderer.setPostProcess(gl=>new ColorPostProcess(gl,{vertex,fragment,colorSampler:'image'}));
    renderer.setUpscaleMode('bicubic');renderer.setUpscaleMode('off');
    const frame={width:13,height:13,pixels:new Uint8Array(),palette:new Uint8Array(),rgba:new Uint8Array(13*13*4),cursor:{handle:1,width:1,height:1,x:0,y:0,hotspotX:0,hotspotY:0,rgba:new Uint8Array([255,0,0,255])}};
    renderer.draw(frame,13,13);const cursor=read();const offset=12*13*4;if(cursor[offset]!==255||cursor[offset+1]!==0||cursor[offset+2]!==0)throw Error('cursor altered');
    renderer.setPostProcess(null);
    renderer.clear();renderer.destroy();renderer.destroy();
    return {checks};
  })()`);
  assert.equal(result.checks, 12);
  console.log(result);
} finally {
  await browser.close();
}
