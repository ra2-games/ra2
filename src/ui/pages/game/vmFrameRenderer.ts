import { t } from '../../shared/i18n/translate';
import type { FramePostProcess } from '../../../graphics/framePostProcess';
import type { VmFrame } from '../../../vm86/win32';
import { spatialUpscaleShader } from './spatialUpscale';
import { fsrRcasShader, fsrUpscaleShader } from './fsrUpscale';
import { ScalefxUpscale } from './scalefxUpscale';
import { AiUpscale, type AiModel } from './aiUpscale';
import { RGB565_TO_RGBA32 as rgb565Colors } from '../../../vm86/pixels';
// Use local references in pixel loops to avoid per-pixel ESM getter access in development.
const RGB565_TO_RGBA32 = rgb565Colors;

export interface VmCursorPresentation {
  x: number;
  y: number;
  visible: boolean;
}

/** Three FSR 1.0 modes: soft EASU, RCAS sharpening, and gentle RCAS sharpening. */
export type FsrMode = 'fsr' | 'fsr-rcas' | 'fsr-rcas-soft';

export type UpscaleMode = 'off' | 'bicubic' | FsrMode | 'scalefx' | 'fast' | 'gan';

const FSR_LABEL: Record<FsrMode, string> = {
  fsr: 'FSR 1.0（AMD FidelityFX EASU）',
  'fsr-rcas': t('FSR 1.0 + RCAS（AMD FidelityFX，锐化）'),
  'fsr-rcas-soft': t('FSR 1.0 + RCAS（AMD FidelityFX，轻锐化）'),
};

/** Official RCAS sharpness semantics: 0 is maximum sharpening; values are attenuation stops, 2^-n. */
const FSR_RCAS_SHARPNESS: Record<'fsr-rcas' | 'fsr-rcas-soft', number> = {
  'fsr-rcas': 0,
  'fsr-rcas-soft': 1,
};

const isFsrMode = (mode: UpscaleMode): FsrMode | null =>
  mode === 'fsr' || mode === 'fsr-rcas' || mode === 'fsr-rcas-soft' ? mode : null;

export interface VmFrameRenderer extends FrameBackend {
  readonly upscaleMode: UpscaleMode;
  setUpscaleMode(mode: UpscaleMode): void;
  /** The caller supplies the effect; the renderer owns its GPU resources. null disables and releases it. */
  setPostProcess(factory: ((gl: WebGL2RenderingContext) => FramePostProcess) | null): void;
}

interface FrameBackend {
  /** Actual backend shown in the frontend performance panel; detail includes the browser-reported GPU renderer. */
  readonly backend: 'WebGL2' | 'Canvas 2D';
  readonly detail: string;
  /** Actual state rather than URL intent; null means no upscaling requested and no UI badge. */
  readonly upscaleStatus: string | null;
  clear(): void;
  destroy(): void;
  draw(
    frame: VmFrame,
    targetWidth: number,
    targetHeight: number,
    cursorPresentation?: VmCursorPresentation,
    cursorFrame?: VmFrame,
  ): void;
}

/**
 * RA2/YR primary surfaces are mostly 8-bit indexed color. Prefer GPU lookup through the 256-color palette rather than expanding 800x600 indexes into RGBA on the main thread every frame. Retain Canvas 2D when WebGL2 is unavailable.
 */
export function createVmFrameRenderer(
  canvas: HTMLCanvasElement,
  preferWebGl = true,
  spatialUpscale = false,
  fsr: FsrMode | null = null,
  scalefx = false,
  aiUpscale = false,
  aiModel: AiModel = 'gan',
): VmFrameRenderer {
  const gl = preferWebGl
    ? canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        preserveDrawingBuffer: false,
        stencil: false,
      })
    : null;
  const context = gl ? null : canvas.getContext('2d');
  if (!gl && !context) throw new Error(t('浏览器无法创建游戏画面渲染上下文'));
  let postProcess: FramePostProcess | null = null;
  const applyPostProcess = (width: number, height: number) => postProcess?.draw(width, height);
  const createBackend = (mode: UpscaleMode): FrameBackend =>
    gl
      ? new WebGlIndexedFrameRenderer(
          canvas,
          gl,
          mode === 'bicubic',
          isFsrMode(mode),
          mode === 'scalefx',
          mode === 'fast' || mode === 'gan',
          mode === 'fast' ? 'fast' : 'gan',
          applyPostProcess,
        )
      : new CanvasFrameRenderer(context!, mode !== 'off');
  let mode: UpscaleMode = aiUpscale ? aiModel : scalefx ? 'scalefx' : (fsr ?? (spatialUpscale ? 'bicubic' : 'off'));
  let backend = createBackend(mode);
  let destroyed = false;
  return {
    get backend() {
      return backend.backend;
    },
    get detail() {
      return backend.detail;
    },
    get upscaleStatus() {
      return backend.upscaleStatus;
    },
    get upscaleMode() {
      return mode;
    },
    setPostProcess(factory) {
      if (destroyed) return;
      if (factory && !gl) throw new Error(t('后处理需要 WebGL2'));
      const replacement = factory ? factory(gl!) : null;
      postProcess?.destroy();
      postProcess = replacement;
    },
    setUpscaleMode(next) {
      if (destroyed || next === mode) return;
      // Reuse one browser context, replacing only the display pipeline without restarting the VM or changing game frames.
      // Release old model GPU memory and frame caches to avoid accumulated resources or stale results after repeated switches.
      const replacement = createBackend(next);
      backend.destroy();
      backend = replacement;
      mode = next;
      if (canvas.dataset) delete canvas.dataset.upscale;
    },
    clear() {
      if (!destroyed) backend.clear();
    },
    draw(...args) {
      if (!destroyed) backend.draw(...args);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      postProcess?.destroy();
      postProcess = null;
      backend.destroy();
      // This closure owns the context shared across backends; changing modes replaces only the pipeline, so release the context only here.
      // Backend destroy() must not call loseContext, or the next backend would receive an already lost context.
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

class WebGlIndexedFrameRenderer implements FrameBackend {
  readonly backend = 'WebGL2' as const;
  readonly detail: string;
  private readonly program: WebGLProgram;
  private readonly indexTexture: WebGLTexture;
  private readonly paletteTexture: WebGLTexture;
  // The shim expands RA2's 16-bit shell frames into RGBA (frame.rgba), bypassing palettes;
  // use a separate direct-upload program/texture alongside the indexed path.
  private readonly rgbaProgram: WebGLProgram;
  private readonly rgb565Program: WebGLProgram;
  private readonly rgbaTexture: WebGLTexture;
  private readonly cursorProgram: WebGLProgram;
  private readonly cursorTexture: WebGLTexture;
  private readonly vertices: WebGLBuffer;
  private readonly cursorRectLocation: WebGLUniformLocation | null;
  private uploadedFrame: VmFrame | null = null;
  private uploadedCursor: VmCursorBitmap | null = null;
  private frameWidth = 0;
  private frameHeight = 0;
  private rgbaWidth = 0;
  private rgbaHeight = 0;
  private rgbaTexturePacked = false;
  private cursorWidth = 0;
  private cursorHeight = 0;
  private destroyed = false;
  private readonly upscaleLocations = new Map<WebGLProgram, WebGLUniformLocation | null>();
  private readonly outputSizeLocations = new Map<WebGLProgram, WebGLUniformLocation | null>();
  /** RCAS intermediate pass: EASU renders into an RGBA texture, then RCAS outputs to the canvas. */
  private readonly rcas: {
    program: WebGLProgram;
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
  } | null = null;
  private rcasWidth = 0;
  private rcasHeight = 0;
  private readonly ai: AiUpscale | null;
  private readonly scalefx: ScalefxUpscale | null;
  private spatialStatus = t('插值放大：等待游戏画面（非 AI）');

  get upscaleStatus(): string | null {
    return this.ai?.status ?? (this.spatialUpscale || this.fsr || this.scalefx ? this.spatialStatus : null);
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly spatialUpscale: boolean,
    private readonly fsr: FsrMode | null,
    scalefx: boolean,
    aiUpscale: boolean,
    aiModel: AiModel,
    private readonly postProcess: (width: number, height: number) => void,
  ) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string);
    this.detail = renderer ? `WebGL2 · ${renderer}` : 'WebGL2';
    if (spatialUpscale) this.detail += t(' · 实验空间重建（抗振铃 bicubic）');
    if (fsr) this.detail += ` · ${FSR_LABEL[fsr]}`;
    if (scalefx) this.detail += t(' · ScaleFX 3×（像素画）');
    this.ai = aiUpscale ? new AiUpscale(gl, aiModel) : null;
    if (aiUpscale) this.detail += aiModel === 'gan' ? t(' · AI GAN 2×（实验）') : t(' · AI CNN 2×（快速）');
    this.scalefx = scalefx ? new ScalefxUpscale(gl) : null;
    this.program = linkProgram(
      gl,
      `#version 300 es
      in vec2 position;
      in vec2 texturePosition;
      out vec2 uv;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
        uv = texturePosition;
      }
    `,
      fsr
        ? fsrUpscaleShader('indexed')
        : spatialUpscale
          ? spatialUpscaleShader('indexed')
          : `#version 300 es
      precision mediump float;
      uniform sampler2D indexedFrame;
      uniform sampler2D palette;
      in vec2 uv;
      out vec4 color;
      void main() {
        int paletteIndex = int(texture(indexedFrame, uv).r * 255.0 + 0.5);
        color = vec4(texelFetch(palette, ivec2(paletteIndex, 0), 0).rgb, 1.0);
      }
    `,
    );
    this.rgbaProgram = linkProgram(
      gl,
      `#version 300 es
      in vec2 position;
      in vec2 texturePosition;
      out vec2 uv;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
        uv = texturePosition;
      }
    `,
      fsr
        ? fsrUpscaleShader('rgba')
        : spatialUpscale
          ? spatialUpscaleShader('rgba')
          : `#version 300 es
      precision mediump float;
      uniform sampler2D rgbaFrame;
      in vec2 uv;
      out vec4 color;
      void main() {
        color = texture(rgbaFrame, uv);
      }
    `,
    );
    // Integer textures preserve all 16 bits and use the same bit-replication color conversion, matching CPU lookup pixel for pixel.
    // Reuse the RGBA texture slot; reallocate on format changes and only update pixels in steady state.
    this.rgb565Program = linkProgram(
      gl,
      `#version 300 es
      in vec2 position;
      in vec2 texturePosition;
      out vec2 uv;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
        uv = texturePosition;
      }
    `,
      fsr
        ? fsrUpscaleShader('rgb565')
        : spatialUpscale
          ? spatialUpscaleShader('rgb565')
          : `#version 300 es
      precision highp float;
      precision highp int;
      uniform highp usampler2D packedFrame;
      in vec2 uv;
      out vec4 color;
      void main() {
        uint p = texture(packedFrame, uv).r;
        uvec3 rgb = uvec3((p >> 11u) & 31u, (p >> 5u) & 63u, p & 31u);
        rgb = (rgb << uvec3(3u, 2u, 3u)) | (rgb >> uvec3(2u, 4u, 2u));
        color = vec4(vec3(rgb) / 255.0, 1.0);
      }
    `,
    );
    this.cursorProgram = linkProgram(
      gl,
      `#version 300 es
      uniform vec4 cursorRect;
      out vec2 uv;
      void main() {
        vec2 corner = vec2(float(gl_VertexID / 2), float(gl_VertexID % 2));
        gl_Position = vec4(
          mix(cursorRect.x, cursorRect.z, corner.x),
          mix(cursorRect.y, cursorRect.w, corner.y),
          0.0,
          1.0
        );
        uv = corner;
      }
    `,
      `#version 300 es
      precision mediump float;
      uniform sampler2D cursorImage;
      in vec2 uv;
      out vec4 color;
      void main() {
        color = texture(cursorImage, uv);
      }
    `,
    );
    const indexTexture = gl.createTexture();
    const paletteTexture = gl.createTexture();
    const rgbaTexture = gl.createTexture();
    const cursorTexture = gl.createTexture();
    const vertices = gl.createBuffer();
    if (!indexTexture || !paletteTexture || !rgbaTexture || !cursorTexture || !vertices) {
      // This instance will not reach the caller; reclaim already created programs/textures to avoid GPU leaks from partial initialization.
      this.destroy();
      throw new Error(t('WebGL 游戏画面资源创建失败'));
    }
    this.indexTexture = indexTexture;
    this.paletteTexture = paletteTexture;
    this.rgbaTexture = rgbaTexture;
    this.cursorTexture = cursorTexture;
    this.vertices = vertices;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, 1, 0, 0, -1, -1, 0, 1, 1, 1, 1, 0, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    for (const [name, offset] of [
      ['position', 0],
      ['texturePosition', 2],
    ] as const) {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 16, offset * 4);
    }
    configureTexture(gl, indexTexture, 0);
    configureTexture(gl, paletteTexture, 1);
    configureTexture(gl, rgbaTexture, 2);
    configureTexture(gl, cursorTexture, 3);
    gl.uniform1i(gl.getUniformLocation(this.program, 'indexedFrame'), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'palette'), 1);
    gl.useProgram(this.rgbaProgram);
    gl.uniform1i(gl.getUniformLocation(this.rgbaProgram, 'rgbaFrame'), 2);
    gl.useProgram(this.rgb565Program);
    gl.uniform1i(gl.getUniformLocation(this.rgb565Program, 'packedFrame'), 2);
    gl.useProgram(this.cursorProgram);
    gl.uniform1i(gl.getUniformLocation(this.cursorProgram, 'cursorImage'), 3);
    this.cursorRectLocation = gl.getUniformLocation(this.cursorProgram, 'cursorRect');
    if (spatialUpscale || fsr) {
      for (const program of [this.program, this.rgbaProgram, this.rgb565Program]) {
        this.upscaleLocations.set(program, gl.getUniformLocation(program, 'upscale'));
        this.outputSizeLocations.set(program, gl.getUniformLocation(program, 'outputSize'));
      }
    }
    if (fsr && fsr !== 'fsr') {
      const rcasProgram = linkProgram(
        gl,
        `#version 300 es
      in vec2 position;
      in vec2 texturePosition;
      out vec2 uv;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
        uv = texturePosition;
      }
    `,
        fsrRcasShader(FSR_RCAS_SHARPNESS[fsr]),
      );
      const rcasTexture = gl.createTexture();
      const rcasFramebuffer = gl.createFramebuffer();
      if (!rcasTexture || !rcasFramebuffer) {
        this.destroy();
        throw new Error(t('RCAS 纹理/帧缓冲分配失败'));
      }
      configureTexture(gl, rcasTexture, 4);
      // Allocate 1x1 first to complete attachments, since unsized textures make FBOs incomplete; resize to target dimensions on the first frame.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, rcasFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rcasTexture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.destroy();
        throw new Error(t('RCAS 帧缓冲不可用'));
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.rcas = { program: rcasProgram, texture: rcasTexture, framebuffer: rcasFramebuffer };
      gl.useProgram(rcasProgram);
      gl.uniform1i(gl.getUniformLocation(rcasProgram, 'easuFrame'), 4);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  clear(): void {
    if (this.destroyed) return;
    const { gl } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(9 / 255, 11 / 255, 16 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  draw(
    frame: VmFrame,
    targetWidth: number,
    targetHeight: number,
    cursorPresentation?: VmCursorPresentation,
    cursorFrame: VmFrame = frame,
  ): void {
    if (this.destroyed) return;
    const { gl } = this;
    const useAi = this.ai?.prepare(frame.width, frame.height, targetWidth, targetHeight) ?? false;
    const upscaling =
      targetWidth >= frame.width &&
      targetHeight >= frame.height &&
      (targetWidth > frame.width || targetHeight > frame.height);
    if (this.spatialUpscale || this.fsr || this.scalefx)
      this.spatialStatus = upscaling
        ? t(
            '插值放大已启动 · {0}',
            this.scalefx ? t('ScaleFX 3×（像素画）') : this.fsr ? FSR_LABEL[this.fsr] : t('bicubic（非 AI）'),
          )
        : t(
            '插值放大未启动：当前没有放大（{0}）',
            this.scalefx ? 'ScaleFX 3×' : this.fsr ? FSR_LABEL[this.fsr] : t('非 AI'),
          );
    if ((this.fsr || this.scalefx) && this.canvas.dataset && this.canvas.dataset.upscale !== this.spatialStatus)
      this.canvas.dataset.upscale = this.spatialStatus;
    if (this.ai && this.canvas.dataset && this.canvas.dataset.upscale !== this.ai.status)
      this.canvas.dataset.upscale = this.ai.status;
    if (useAi && this.ai!.hasFrame(frame)) {
      // Cursor redraws/window resizing reuse inference results without rerunning CNN or delaying the independent cursor.
      this.ai!.draw(targetWidth, targetHeight);
      this.postProcess(targetWidth, targetHeight);
      this.drawCursor(frameCursor(cursorFrame), cursorFrame, cursorPresentation);
      return;
    }
    gl.viewport(0, 0, targetWidth, targetHeight);
    if (useAi) this.ai!.bindInput();
    // RCAS modes: EASU renders to an intermediate texture, then RCAS to the canvas; disabled at 1:1 and when downscaling.
    const useRcas = this.rcas !== null && upscaling;
    if (useRcas) {
      this.ensureRcasTarget(targetWidth, targetHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rcas!.framebuffer);
      gl.viewport(0, 0, targetWidth, targetHeight);
    }
    if (frame.rgba || frame.rgb565) {
      const packed = !frame.rgba && !!frame.rgb565;
      const pixels = frame.rgba ?? frame.rgb565!;
      const format = packed ? gl.RED_INTEGER : gl.RGBA;
      const type = packed ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE;
      const program = packed ? this.rgb565Program : this.rgbaProgram;
      gl.useProgram(program);
      this.setUpscale(program, upscaling, targetWidth, targetHeight);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.rgbaTexture);
      if (this.uploadedFrame !== frame) {
        if (frame.width !== this.rgbaWidth || frame.height !== this.rgbaHeight || packed !== this.rgbaTexturePacked) {
          this.rgbaWidth = frame.width;
          this.rgbaHeight = frame.height;
          this.rgbaTexturePacked = packed;
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            packed ? gl.R16UI : gl.RGBA,
            frame.width,
            frame.height,
            0,
            format,
            type,
            pixels,
          );
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, format, type, pixels);
        }
      }
      if (this.scalefx && upscaling) {
        this.scalefx.resize(frame.width, frame.height);
        this.scalefx.draw(this.rgbaTexture, packed ? 'rgb565' : 'rgba', null, targetWidth, targetHeight);
      } else {
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    } else {
      gl.useProgram(this.program);
      this.setUpscale(this.program, upscaling, targetWidth, targetHeight);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.indexTexture);
      if (this.uploadedFrame !== frame) {
        if (frame.width !== this.frameWidth || frame.height !== this.frameHeight) {
          this.frameWidth = frame.width;
          this.frameHeight = frame.height;
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, frame.width, frame.height, 0, gl.RED, gl.UNSIGNED_BYTE, frame.pixels);
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RED, gl.UNSIGNED_BYTE, frame.pixels);
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.palette);
      }
      if (this.scalefx && upscaling) {
        this.scalefx.resize(frame.width, frame.height);
        this.scalefx.draw(this.indexTexture, 'indexed', this.paletteTexture, targetWidth, targetHeight);
      } else {
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    this.uploadedFrame = frame;
    if (useRcas) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, targetWidth, targetHeight);
      gl.useProgram(this.rcas!.program);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.rcas!.texture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (useAi) {
      this.ai!.infer(frame);
      this.ai!.draw(targetWidth, targetHeight);
    }
    this.postProcess(targetWidth, targetHeight);
    this.drawCursor(frameCursor(cursorFrame), cursorFrame, cursorPresentation);
  }

  private ensureRcasTarget(width: number, height: number): void {
    if (this.rcasWidth === width && this.rcasHeight === height) return;
    this.rcasWidth = width;
    this.rcasHeight = height;
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.rcas!.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  /**
   * Reclaim only this backend's GPU objects. createVmFrameRenderer owns the context shared by backends; do not call WEBGL_lose_context because subsequent backends need the same context.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ai?.destroy();
    this.gl.deleteTexture(this.indexTexture);
    this.gl.deleteTexture(this.paletteTexture);
    this.gl.deleteTexture(this.rgbaTexture);
    this.gl.deleteTexture(this.cursorTexture);
    this.gl.deleteBuffer(this.vertices);
    this.gl.deleteProgram(this.program);
    this.gl.deleteProgram(this.rgbaProgram);
    this.gl.deleteProgram(this.rgb565Program);
    this.gl.deleteProgram(this.cursorProgram);
    if (this.rcas) {
      this.gl.deleteProgram(this.rcas.program);
      this.gl.deleteTexture(this.rcas.texture);
      this.gl.deleteFramebuffer(this.rcas.framebuffer);
    }
    this.scalefx?.destroy();
    this.uploadedFrame = null;
    this.uploadedCursor = null;
  }

  private drawCursor(
    cursor: VmCursorBitmap | undefined,
    frame: VmFrame,
    presentation: VmCursorPresentation | undefined,
  ): void {
    if (!cursor || presentation?.visible === false || cursor.width <= 0 || cursor.height <= 0) return;
    const { gl } = this;
    gl.useProgram(this.cursorProgram);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.cursorTexture);
    if (this.uploadedCursor !== cursor) {
      if (cursor.width !== this.cursorWidth || cursor.height !== this.cursorHeight) {
        this.cursorWidth = cursor.width;
        this.cursorHeight = cursor.height;
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          cursor.width,
          cursor.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          cursor.rgba,
        );
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cursor.width, cursor.height, gl.RGBA, gl.UNSIGNED_BYTE, cursor.rgba);
      }
      this.uploadedCursor = cursor;
    }
    const x = presentation?.x ?? cursor.x;
    const y = presentation?.y ?? cursor.y;
    const left = ((x - cursor.hotspotX) / frame.width) * 2 - 1;
    const top = 1 - ((y - cursor.hotspotY) / frame.height) * 2;
    const right = left + (cursor.width / frame.width) * 2;
    const bottom = top - (cursor.height / frame.height) * 2;
    gl.uniform4f(this.cursorRectLocation, left, top, right, bottom);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }

  private setUpscale(program: WebGLProgram, upscaling: boolean, width: number, height: number): void {
    // When disabled, add no GPU-state calls; retain the independent cursor pass so reconstruction filters cannot blur mouse rendering.
    if (!this.spatialUpscale && !this.fsr) return;
    this.gl.uniform1i(this.upscaleLocations.get(program) ?? null, upscaling ? 1 : 0);
    // Only the spatial shader declares outputSize; other programs get a null location, which WebGL ignores.
    if (upscaling) this.gl.uniform2f(this.outputSizeLocations.get(program) ?? null, width, height);
  }
}

class CanvasFrameRenderer implements FrameBackend {
  readonly backend = 'Canvas 2D' as const;
  readonly detail = t('Canvas 2D（WebGL2 不可用或由 ?webgl=0 强制回退）');
  private cache: VmFrameCache | null = null;
  private cursorCache: VmCursorCache | null = null;
  private destroyed = false;

  readonly upscaleStatus: string | null;
  constructor(
    private readonly context: CanvasRenderingContext2D,
    requestedUpscale = false,
  ) {
    this.upscaleStatus = requestedUpscale ? t('超分未启动：当前使用 Canvas 2D，已回退原图') : null;
  }

  clear(): void {
    if (this.destroyed) return;
    const { context } = this;
    context.fillStyle = '#090b10';
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  }

  draw(
    frame: VmFrame,
    targetWidth: number,
    targetHeight: number,
    cursorPresentation?: VmCursorPresentation,
    cursorFrame: VmFrame = frame,
  ): void {
    if (this.destroyed) return;
    const { context } = this;
    let cache = this.cache;
    if (!cache || cache.image.width !== frame.width || cache.image.height !== frame.height) {
      const image = context.createImageData(frame.width, frame.height);
      const base = document.createElement('canvas');
      base.width = frame.width;
      base.height = frame.height;
      const baseContext = base.getContext('2d');
      if (!baseContext) throw new Error(t('浏览器无法创建游戏画面缓存上下文'));
      cache = {
        frame: null,
        image,
        pixels32: new Uint32Array(image.data.buffer),
        palette32: new Uint32Array(256),
        base,
        baseContext,
      };
      this.cache = cache;
    }
    const { image, pixels32, palette32 } = cache;
    if (cache.frame !== frame) {
      if (frame.rgba) {
        image.data.set(frame.rgba);
      } else if (frame.rgb565) {
        // Browsers without WebGL can still display compact frames; reuse ImageData and avoid repeated color conversion on cursor moves.
        for (let i = 0; i < frame.rgb565.length; i++) pixels32[i] = RGB565_TO_RGBA32[frame.rgb565[i]!]!;
      } else {
        for (let index = 0; index < 256; index++) {
          const color = index * 4;
          palette32[index] =
            0xff00_0000 |
            ((frame.palette[color + 2] ?? 0) << 16) |
            ((frame.palette[color + 1] ?? 0) << 8) |
            (frame.palette[color] ?? 0);
        }
        for (let pixel = 0; pixel < frame.pixels.length; pixel++) {
          pixels32[pixel] = palette32[frame.pixels[pixel]!]!;
        }
      }
      cache.baseContext.putImageData(image, 0, 0);
      cache.frame = frame;
    }
    const integerScale =
      targetWidth > frame.width &&
      targetWidth % frame.width === 0 &&
      targetHeight % frame.height === 0 &&
      targetWidth / frame.width === targetHeight / frame.height;
    context.imageSmoothingEnabled = !integerScale;
    context.imageSmoothingQuality = 'high';
    context.drawImage(cache.base, 0, 0, targetWidth, targetHeight);

    const cursor = frameCursor(cursorFrame);
    if (!cursor || cursorPresentation?.visible === false || cursor.width <= 0 || cursor.height <= 0) return;
    const cursorCanvas = this.cacheCursor(cursor);
    const scaleX = targetWidth / cursorFrame.width;
    const scaleY = targetHeight / cursorFrame.height;
    const x = cursorPresentation?.x ?? cursor.x;
    const y = cursorPresentation?.y ?? cursor.y;
    context.drawImage(
      cursorCanvas,
      (x - cursor.hotspotX) * scaleX,
      (y - cursor.hotspotY) * scaleY,
      cursor.width * scaleX,
      cursor.height * scaleY,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cache = null;
    this.cursorCache = null;
  }

  private cacheCursor(cursor: VmCursorBitmap): HTMLCanvasElement {
    let cache = this.cursorCache;
    if (!cache || cache.cursor !== cursor) {
      if (!cache || cache.canvas.width !== cursor.width || cache.canvas.height !== cursor.height) {
        const canvas = document.createElement('canvas');
        canvas.width = cursor.width;
        canvas.height = cursor.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error(t('浏览器无法创建鼠标光标缓存上下文'));
        cache = { cursor, canvas, context };
        this.cursorCache = cache;
      } else {
        cache.cursor = cursor;
      }
      const image = cache.context.createImageData(cursor.width, cursor.height);
      image.data.set(cursor.rgba);
      cache.context.putImageData(image, 0, 0);
    }
    return cache.canvas;
  }
}

function configureTexture(gl: WebGL2RenderingContext, texture: WebGLTexture, unit: number): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function linkProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  if (!program) throw new Error(t('WebGL program 创建失败'));
  try {
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error(t('WebGL shader 创建失败'));
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(t('WebGL shader 编译失败：{0}', gl.getShaderInfoLog(shader) ?? t('未知错误')));
      }
      return shader;
    };
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ] as const) {
      const shader = compile(type, source);
      shaders.push(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(t('WebGL program 链接失败：{0}', gl.getProgramInfoLog(program) ?? t('未知错误')));
    }
    return program;
  } catch (error) {
    // Reclaim partially built programs on compile/link failure; constructors leave them in the context even though no instance is returned.
    gl.deleteProgram(program);
    throw error;
  } finally {
    // The program owns attached shaders; their handles are no longer needed on either success or failure.
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

interface VmFrameCache {
  frame: VmFrame | null;
  image: ImageData;
  pixels32: Uint32Array;
  palette32: Uint32Array;
  base: HTMLCanvasElement;
  baseContext: CanvasRenderingContext2D;
}

interface VmCursorCache {
  cursor: VmCursorBitmap;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

type VmCursorBitmap = NonNullable<VmFrame['cursor']>;

function frameCursor(frame: VmFrame): VmCursorBitmap | undefined {
  return frame.cursor;
}
