import '../helpers/chineseLocale';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVmFrameRenderer } from '../../src/ui/pages/game/vmFrameRenderer';
import { fsrUpscaleMode, spatialUpscaleEnabled } from '../../src/ui/pages/game/spatialUpscale';
import type { VmFrame } from '../../src/vm86/win32';

class FakeCanvas {
  width = 0;
  height = 0;
  readonly context = new FakeCanvasContext(this);

  getContext(kind: string): FakeCanvasContext | null {
    return kind === '2d' ? this.context : null;
  }
}

class FakeCanvasContext {
  readonly calls: string[] = [];
  lastImage: ImageData | null = null;
  imageSmoothingEnabled = true;
  imageSmoothingQuality: ImageSmoothingQuality = 'low';
  fillStyle: string | CanvasGradient | CanvasPattern = '';

  constructor(readonly canvas: FakeCanvas) {}

  createImageData(width: number, height: number): ImageData {
    this.calls.push(`createImageData:${width}x${height}`);
    return {
      colorSpace: 'srgb',
      data: new Uint8ClampedArray(width * height * 4),
      height,
      width,
    } as ImageData;
  }

  putImageData(image: ImageData): void {
    this.lastImage = image;
    this.calls.push('putImageData');
  }
  fillRect(): void {
    this.calls.push('fillRect');
  }
  drawImage(): void {
    this.calls.push('drawImage');
  }
}

class FakeWebGl {
  readonly calls: string[] = [];
  readonly deletedTextures: unknown[] = [];
  readonly deletedPrograms: unknown[] = [];
  readonly deletedBuffers: unknown[] = [];
  readonly deletedShaders: unknown[] = [];
  readonly RENDERER = 1;
  readonly VERTEX_SHADER = 2;
  readonly FRAGMENT_SHADER = 3;
  readonly COMPILE_STATUS = 4;
  readonly LINK_STATUS = 5;
  readonly ARRAY_BUFFER = 6;
  readonly STATIC_DRAW = 7;
  readonly FLOAT = 8;
  readonly TEXTURE0 = 10;
  readonly TEXTURE1 = 11;
  readonly TEXTURE2 = 12;
  readonly TEXTURE3 = 13;
  readonly TEXTURE4 = 14;
  readonly TEXTURE_2D = 14;
  readonly TEXTURE_MIN_FILTER = 15;
  readonly TEXTURE_MAG_FILTER = 16;
  readonly TEXTURE_WRAP_S = 17;
  readonly TEXTURE_WRAP_T = 18;
  readonly NEAREST = 19;
  readonly CLAMP_TO_EDGE = 20;
  readonly UNPACK_ALIGNMENT = 21;
  readonly R8 = 22;
  readonly RED = 23;
  readonly RGBA = 24;
  readonly UNSIGNED_BYTE = 25;
  readonly TRIANGLE_STRIP = 26;
  readonly COLOR_BUFFER_BIT = 27;
  readonly BLEND = 28;
  readonly SRC_ALPHA = 29;
  readonly ONE_MINUS_SRC_ALPHA = 30;
  readonly R16UI = 31;
  readonly RED_INTEGER = 32;
  readonly UNSIGNED_SHORT = 33;
  readonly RGBA8 = 34;
  readonly FRAMEBUFFER = 35;
  readonly COLOR_ATTACHMENT0 = 36;
  readonly FRAMEBUFFER_COMPLETE = 37;
  readonly uploads: unknown[][] = [];

  readonly loseContextCalls: string[] = [];
  /** Mock only WEBGL_lose_context; other extensions such as debug_renderer_info still return null. */
  getExtension(name: string): object | null {
    if (name === 'WEBGL_lose_context') return { loseContext: () => this.loseContextCalls.push(name) };
    return null;
  }
  getParameter(): string {
    return 'fake-gpu';
  }
  createShader(): object {
    return {};
  }
  shaderSource(): void {}
  compileShader(): void {}
  getShaderParameter(): boolean {
    return true;
  }
  getShaderInfoLog(): null {
    return null;
  }
  createProgram(): object {
    return {};
  }
  attachShader(): void {}
  linkProgram(): void {}
  getProgramParameter(): boolean {
    return true;
  }
  getProgramInfoLog(): null {
    return null;
  }
  createTexture(): object {
    return {};
  }
  createBuffer(): object {
    return {};
  }
  createFramebuffer(): object {
    return {};
  }
  deleteFramebuffer(): void {}
  bindFramebuffer(): void {
    this.calls.push('bindFramebuffer');
  }
  framebufferTexture2D(): void {}
  checkFramebufferStatus(): number {
    return this.FRAMEBUFFER_COMPLETE;
  }
  useProgram(): void {
    this.calls.push('useProgram');
  }
  bindBuffer(): void {}
  bufferData(): void {}
  getAttribLocation(_program: object, name: string): number {
    return name === 'position' ? 0 : 1;
  }
  enableVertexAttribArray(): void {}
  vertexAttribPointer(): void {}
  activeTexture(): void {}
  bindTexture(): void {}
  texParameteri(): void {}
  uniform1i(location: { name: string }, value: number): void {
    this.calls.push(`uniform:${location.name}:${value}`);
  }
  uniform2f(location: { name: string }, x: number, y: number): void {
    this.calls.push(`uniform:${location.name}:${x},${y}`);
  }
  getUniformLocation(_program: object, name: string): object {
    return { name };
  }
  pixelStorei(): void {}
  viewport(): void {
    this.calls.push('viewport');
  }
  clearColor(): void {}
  clear(): void {
    this.calls.push('clear');
  }
  texImage2D(...args: unknown[]): void {
    this.uploads.push(args);
    this.calls.push('texImage2D');
  }
  texSubImage2D(...args: unknown[]): void {
    this.uploads.push(args);
    this.calls.push('texSubImage2D');
  }
  drawArrays(): void {
    this.calls.push('drawArrays');
  }
  uniform4f(): void {}
  enable(): void {}
  blendFunc(): void {}
  disable(): void {}
  deleteTexture(texture: unknown): void {
    this.deletedTextures.push(texture);
  }
  deleteProgram(program: unknown): void {
    this.deletedPrograms.push(program);
  }
  deleteShader(shader: unknown): void {
    this.deletedShaders.push(shader);
  }
  deleteBuffer(buffer: unknown): void {
    this.deletedBuffers.push(buffer);
  }
}

function indexedFrame(width = 2, height = 1): VmFrame {
  return {
    width,
    height,
    pixels: new Uint8Array(width * height),
    palette: new Uint8Array(256 * 4),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('VmFrameRenderer 生命周期', () => {
  it('实时切换复用上下文、释放旧管线，同模式和销毁后不再分配', () => {
    const gl = new FakeWebGl();
    const getContext = vi.fn(() => gl);
    const canvas = { width: 20, height: 10, dataset: { upscale: '旧状态' }, getContext };
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement);
    const frame = indexedFrame();
    renderer.draw(frame, 20, 10);
    renderer.setUpscaleMode('bicubic');
    expect(renderer.upscaleMode).toBe('bicubic');
    expect(canvas.dataset.upscale).toBeUndefined();
    expect(gl.deletedPrograms).toHaveLength(4);
    renderer.draw(frame, 20, 10);
    expect(renderer.upscaleStatus).toContain('插值');
    renderer.setUpscaleMode('bicubic');
    expect(gl.deletedPrograms).toHaveLength(4);
    renderer.setUpscaleMode('fast');
    expect(renderer.detail).toContain('CNN');
    renderer.setUpscaleMode('gan');
    expect(renderer.detail).toContain('GAN');
    renderer.setUpscaleMode('off');
    expect(renderer.upscaleStatus).toBeNull();
    renderer.destroy();
    renderer.setUpscaleMode('gan');
    expect(renderer.upscaleMode).toBe('off');
    expect(gl.deletedPrograms).toHaveLength(20);
    expect(gl.deletedTextures).toHaveLength(20);
    // Two shaders per program: release handles after linking, including on failure.
    expect(gl.deletedShaders).toHaveLength(40);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('换档只替换显示管线不释放上下文，只有终态销毁才 loseContext', () => {
    const gl = new FakeWebGl();
    const canvas = { width: 20, height: 10, dataset: {}, getContext: vi.fn(() => gl) };
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement);
    renderer.setUpscaleMode('bicubic');
    renderer.setUpscaleMode('off');
    // Backends share the context; releasing it during a mode switch would give the new backend a lost context.
    expect(gl.loseContextCalls).toHaveLength(0);
    renderer.destroy();
    expect(gl.loseContextCalls).toHaveLength(1);
    renderer.destroy();
    expect(gl.loseContextCalls).toHaveLength(1);
  });

  it('releases pipelines during VM replacement and releases the retained context once on page destruction', () => {
    const gl = new FakeWebGl();
    const canvas = { width: 20, height: 10, dataset: {}, getContext: vi.fn(() => gl) };
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement);
    renderer.destroy(true);
    expect(gl.deletedPrograms.length).toBeGreaterThan(0);
    expect(gl.loseContextCalls).toHaveLength(0);
    const count = gl.deletedPrograms.length;
    renderer.destroy(true);
    expect(gl.deletedPrograms).toHaveLength(count);
    renderer.destroy();
    renderer.destroy();
    expect(gl.loseContextCalls).toHaveLength(1);
  });

  it('Canvas 2D 实时请求 AI 明确显示回退，关闭后清除提示', () => {
    const canvas = new FakeCanvas();
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false);
    renderer.setUpscaleMode('gan');
    expect(renderer.upscaleStatus).toContain('Canvas 2D');
    renderer.setUpscaleMode('off');
    expect(renderer.upscaleStatus).toBeNull();
    renderer.destroy();
  });

  it('Canvas 2D 同时覆盖 indexed/RGBA 帧，并在 destroy 后静默 no-op', () => {
    const canvas = new FakeCanvas();
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false);
    const first = indexedFrame();
    const rgba: VmFrame = {
      width: 2,
      height: 1,
      pixels: new Uint8Array(2),
      palette: new Uint8Array(256 * 4),
      rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]),
    };

    renderer.clear();
    renderer.draw(first, 20, 10);
    renderer.draw(rgba, 20, 10);
    const callsBeforeDestroy = canvas.context.calls.length;
    renderer.destroy();
    renderer.destroy();
    renderer.clear();
    renderer.draw(first, 20, 10);

    expect(canvas.context.calls).toContain('fillRect');
    expect(canvas.context.calls).toContain('drawImage');
    expect(canvas.context.calls.length).toBe(callsBeforeDestroy);
  });

  it('帧尺寸变化会重新创建缓存图像，销毁后不再触碰 context', () => {
    const canvas = new FakeCanvas();
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false);

    renderer.draw(indexedFrame(2, 1), 20, 10);
    renderer.draw(indexedFrame(3, 2), 30, 20);
    expect(canvas.context.calls.filter((call) => call.startsWith('createImageData')).length).toBe(2);
    renderer.destroy();
    renderer.clear();
    expect(canvas.context.calls).not.toContain('fillRect');
  });

  it('WebGL2 destroy releases all GPU resources and makes later draw/clear no-op', () => {
    const gl = new FakeWebGl();
    const canvas = {
      width: 320,
      height: 200,
      getContext: (kind: string) => (kind === 'webgl2' ? gl : null),
    };
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, true);
    expect(renderer.backend).toBe('WebGL2');
    renderer.draw(indexedFrame(), 320, 200);
    renderer.draw({ ...indexedFrame(), rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) }, 320, 200);
    const callsBeforeDestroy = gl.calls.length;
    renderer.destroy();
    renderer.destroy();
    expect(gl.deletedTextures).toHaveLength(4);
    expect(gl.deletedPrograms).toHaveLength(4);
    expect(gl.deletedBuffers).toHaveLength(1);
    renderer.clear();
    renderer.draw(indexedFrame(), 320, 200);
    expect(gl.calls.length).toBe(callsBeforeDestroy);
  });

  it('RGB565 Canvas 回退准确转色，同一帧光标重画不重复转换', () => {
    const canvas = new FakeCanvas(),
      base = new FakeCanvas();
    vi.stubGlobal('document', { createElement: () => base });
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false);
    const frame = { ...indexedFrame(3, 1), rgb565: new Uint16Array([0xf800, 0x07e0, 0x001f]) };
    renderer.draw(frame, 3, 1);
    renderer.draw(frame, 3, 1);
    expect([...base.context.lastImage!.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    expect(base.context.calls.filter((call) => call === 'putImageData')).toHaveLength(1);
  });

  it('GPU 紧凑帧只上传一次，RGBA/整数格式切换重新分配纹理', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    const frame = { ...indexedFrame(), rgb565: new Uint16Array([0xf800, 0x07e0]) };
    renderer.draw(frame, 2, 1);
    renderer.draw(frame, 2, 1);
    expect(gl.uploads).toHaveLength(1);
    expect(gl.uploads[0]).toEqual([
      gl.TEXTURE_2D,
      0,
      gl.R16UI,
      2,
      1,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      frame.rgb565,
    ]);
    renderer.draw({ ...frame, rgb565: frame.rgb565.slice() }, 2, 1);
    expect(gl.calls.filter((call) => call === 'texSubImage2D')).toHaveLength(1);
    renderer.draw({ ...indexedFrame(), rgba: new Uint8Array(8) }, 2, 1);
    renderer.draw(frame, 2, 1);
    expect(gl.calls.filter((call) => call === 'texImage2D')).toHaveLength(3);
  });

  it('空间重建必须显式开启，1:1/缩小不启用，也不增加同帧上传', () => {
    for (const search of ['', '?sr=0', '?sr=true', '?other=1']) expect(spatialUpscaleEnabled(search)).toBe(false);
    expect(spatialUpscaleEnabled('?debug=1&sr=1')).toBe(true);
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement, true, true);
    expect(renderer.detail).toContain('实验空间重建');
    const frame = { ...indexedFrame(4, 4), rgb565: new Uint16Array(16) };
    renderer.draw(frame, 8, 8);
    renderer.draw(frame, 4, 4);
    renderer.draw(frame, 2, 2);
    expect(gl.calls.filter((call) => call.startsWith('uniform:upscale:'))).toEqual([
      'uniform:upscale:1',
      'uniform:upscale:0',
      'uniform:upscale:0',
    ]);
    expect(gl.uploads).toHaveLength(1);
    renderer.destroy();
    expect(gl.deletedPrograms).toHaveLength(4);
    expect(gl.deletedTextures).toHaveLength(4);
  });

  it('FSR 1.0 必须显式开启，1:1/缩小走原采样直通', () => {
    for (const search of ['', '?sr=0', '?sr=1', '?sr=ai']) expect(fsrUpscaleMode(search)).toBeNull();
    expect(fsrUpscaleMode('?debug=1&sr=fsr')).toBe('fsr');
    expect(fsrUpscaleMode('?sr=fsr-rcas')).toBe('fsr-rcas');
    expect(fsrUpscaleMode('?sr=fsr-rcas-soft')).toBe('fsr-rcas-soft');
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer(
      { getContext: () => gl } as unknown as HTMLCanvasElement,
      true,
      false,
      'fsr',
    );
    expect(renderer.detail).toContain('FSR 1.0');
    expect(renderer.upscaleMode).toBe('fsr');
    const frame = { ...indexedFrame(4, 4), rgb565: new Uint16Array(16) };
    renderer.draw(frame, 8, 8);
    renderer.draw(frame, 4, 4);
    renderer.draw(frame, 2, 2);
    expect(gl.calls.filter((call) => call.startsWith('uniform:upscale:'))).toEqual([
      'uniform:upscale:1',
      'uniform:upscale:0',
      'uniform:upscale:0',
    ]);
    expect(renderer.upscaleStatus).toContain('FSR 1.0');
    renderer.destroy();
  });

  it('FSR+RCAS 档位经中间纹理锐化，1:1 时不启用通道且尺寸不变不重分配', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer(
      { getContext: () => gl } as unknown as HTMLCanvasElement,
      true,
      false,
      'fsr-rcas',
    );
    expect(renderer.detail).toContain('RCAS');
    expect(renderer.upscaleMode).toBe('fsr-rcas');
    const frame = indexedFrame(4, 4);
    renderer.draw(frame, 8, 8);
    // Two calls during construction (bind/unbind) plus two per upscale draw (into the FBO/back to the canvas).
    expect(gl.calls.filter((call) => call === 'bindFramebuffer')).toHaveLength(4);
    // Uploads: 1x1 intermediate-texture placeholder, first-frame resize to target dimensions, indexed texture, and palette.
    expect(gl.calls.filter((call) => call === 'texImage2D')).toHaveLength(4);
    renderer.draw(frame, 8, 8);
    expect(gl.calls.filter((call) => call === 'texImage2D')).toHaveLength(4);
    expect(gl.calls.filter((call) => call === 'bindFramebuffer')).toHaveLength(6);
    renderer.draw(frame, 4, 4);
    expect(gl.calls.filter((call) => call === 'bindFramebuffer')).toHaveLength(6);
    expect(renderer.upscaleStatus).toContain('未启动');
    renderer.destroy();
  });

  it('ScaleFX 档位经 5-pass 链输出，1:1 时不启用', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer(
      { getContext: () => gl } as unknown as HTMLCanvasElement,
      true,
      false,
      null,
      true,
    );
    expect(renderer.detail).toContain('ScaleFX');
    expect(renderer.upscaleMode).toBe('scalefx');
    const frame = indexedFrame(4, 4);
    renderer.draw(frame, 8, 8);
    expect(renderer.upscaleStatus).toContain('ScaleFX');
    // Chain: pass0..3 -> 1x intermediate textures, pass4 -> 3x, final fit -> canvas; six draws total.
    expect(gl.calls.filter((call) => call === 'drawArrays')).toHaveLength(6);
    expect(gl.calls.filter((call) => call.startsWith('uniform:outputSize:'))).toEqual(['uniform:outputSize:12,12']);
    renderer.draw(frame, 4, 4);
    expect(gl.calls.filter((call) => call === 'drawArrays')).toHaveLength(7);
    expect(renderer.upscaleStatus).toContain('未启动');
    renderer.destroy();
  });

  it('空间重建关闭没有额外 uniform，Canvas 回退不启用 GPU 滤镜', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    renderer.draw(indexedFrame(), 100, 100);
    expect(gl.calls.some((call) => call.startsWith('uniform:upscale:'))).toBe(false);
    renderer.destroy();
    const canvas = new FakeCanvas();
    const fallback = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false, true);
    expect(fallback.backend).toBe('Canvas 2D');
    expect(fallback.detail).not.toContain('空间重建');
    fallback.destroy();
  });
});
