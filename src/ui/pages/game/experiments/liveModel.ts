import { t, uiLocale } from '../../../shared/i18n/translate';
import type { VmFrame } from '../../../../vm86/win32';
import { PROBE_MODELS, isLiveModelId, type LiveModelId, type ProbeReply } from './modelProbe';

/** Independent experimental display pipeline: one in-flight task, no retained recyclable VM buffers, and no historical-frame backlog. */
export class LiveModel {
  private worker: Worker;
  private ready = false;
  private pending = false;
  private dead = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rejectLoad: ((error: Error) => void) | undefined;
  private output: VmFrame | null = null;
  private inputWidth = 0;
  private inputHeight = 0;
  private submittedAt = 0;
  private displayedAt = 0;
  private elapsed = 0;
  private inference = 0;
  private source: VmFrame | null = null;
  private failure = '';
  private modelName = '';

  constructor(private changed: () => void) {
    this.worker = new Worker(new URL('./modelProbeWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(event.message);
    };
  }
  async load(file: File, modelId: LiveModelId = 'ultra4x-fp16'): Promise<void> {
    if (!isLiveModelId(modelId)) throw new Error(t('该模型尚未开放整帧实验'));
    this.modelName = PROBE_MODELS.find((model) => model.id === modelId)!.name;
    if (file.size < 1 || file.size > 40 * 1024 * 1024) throw new Error(t('请选择已登记的整帧实验 ONNX'));
    const model = await file.arrayBuffer();
    if (this.dead) throw new Error(t('实验已取消'));
    await new Promise<void>((resolve, reject) => {
      this.rejectLoad = reject;
      this.worker.onmessage = ({ data }: MessageEvent<ProbeReply>) => {
        if (this.dead) return;
        clearTimeout(this.timer);
        if (data.type === 'error') {
          this.fail(data.message);
          return;
        }
        if (data.type === 'ready') {
          this.ready = true;
          this.rejectLoad = undefined;
          resolve();
        } else {
          this.pending = false;
          this.elapsed = performance.now() - this.submittedAt;
          this.inference = data.milliseconds;
          this.displayedAt = this.submittedAt;
          this.output = {
            width: data.image.size,
            height: data.image.height ?? data.image.size,
            rgba: new Uint8Array(data.image.rgba.buffer),
            pixels: new Uint8Array(),
            palette: new Uint8Array(),
          };
        }
        this.changed();
      };
      this.deadline();
      this.worker.postMessage({ type: 'load', modelId, model, locale: uiLocale }, [model]);
    });
  }
  private deadline() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(t('超过 120 秒，已停止并恢复原始画面')), 120_000);
  }
  private fail(message: string) {
    this.failure = message;
    this.destroy();
    this.changed();
  }
  get status(): string {
    if (this.failure) return t('{0} 整帧实验失败：{1}', this.modelName, this.failure);
    if (!this.ready) return t('{0} 整帧实验：正在加载', this.modelName);
    if (!this.output) return t('{0} 整帧实验：首帧推理中，暂显示原图', this.modelName);
    return t(
      '{0} {1}×{2} → {3}×{4} · 推理/回读 {5}ms · 采样到结果 {6}ms · 当前画面年龄 {7}ms（非输入延迟）',
      this.modelName,
      this.inputWidth,
      this.inputHeight,
      this.output.width,
      this.output.height,
      this.inference.toFixed(1),
      this.elapsed.toFixed(1),
      Math.max(0, performance.now() - this.displayedAt).toFixed(0),
    );
  }
  /** The main thread copies only the latest full frame while idle; cursor redraws do not rerun the same VM frame. */
  frame(frame: VmFrame): VmFrame | null {
    if (this.dead) return null;
    if (frame.width > 800 || frame.height > 600) {
      this.fail(t('整帧实验只支持不超过 800×600，请先降低游戏分辨率'));
      return null;
    }
    const sameSize = frame.width === this.inputWidth && frame.height === this.inputHeight;
    if (!this.ready || this.pending || document.hidden || this.source === frame) return sameSize ? this.output : null;
    if (!sameSize) this.output = null;
    this.inputWidth = frame.width;
    this.inputHeight = frame.height;
    this.source = frame;
    this.submittedAt = performance.now();
    const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
    if (frame.rgba) rgba.set(frame.rgba);
    else
      for (let i = 0; i < frame.width * frame.height; i++) {
        if (frame.rgb565) {
          const v = frame.rgb565[i]!,
            r = v >>> 11,
            g = (v >>> 5) & 63,
            b = v & 31;
          rgba[i * 4] = (r << 3) | (r >>> 2);
          rgba[i * 4 + 1] = (g << 2) | (g >>> 4);
          rgba[i * 4 + 2] = (b << 3) | (b >>> 2);
        } else rgba.set(frame.palette.subarray(frame.pixels[i]! * 4, frame.pixels[i]! * 4 + 3), i * 4);
        rgba[i * 4 + 3] = 255;
      }
    this.pending = true;
    this.deadline();
    this.worker.postMessage({ type: 'run-frame', image: { size: frame.width, height: frame.height, rgba } }, [
      rgba.buffer,
    ]);
    return this.output;
  }
  destroy(): void {
    this.dead = true;
    this.ready = false;
    this.pending = false;
    clearTimeout(this.timer);
    this.worker.terminate();
    this.output = null;
    this.source = null;
    this.rejectLoad?.(new Error(this.failure || t('实验已取消')));
    this.rejectLoad = undefined;
  }
}
