import { t, initializeWorkerLocale, type UiLocale } from '../../../shared/i18n/translate';
import {
  validateProbeModelMetadata,
  probeTensor,
  probeFrameOutput,
  PROBE_MODELS,
  type ProbeImage,
  type ProbeReply,
} from './modelProbe';
import type * as Ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { normalizeUltraSharpOutputShape, ultraSharpCompatibilityNodes } from './ultraSharpModel';
import { halfRgbTensor, decodeHalf } from './halfFloat';

let ort: typeof Ort | undefined;
let session: Ort.InferenceSession | undefined;
let busy = false;
let adapterName = 'WebGPU';
let scale: 2 | 4 = 4;
let half = false;
const scope = self as unknown as { postMessage(message: ProbeReply, transfer: Transferable[]): void };
const send = (reply: ProbeReply) =>
  scope.postMessage(reply, reply.type === 'result' ? [reply.image.rgba.buffer as ArrayBuffer] : []);

onmessage = async (
  event: MessageEvent<
    | { type: 'load'; model: ArrayBuffer; modelId?: string; locale: UiLocale }
    | { type: 'run' | 'run-frame'; image: ProbeImage }
  >,
) => {
  if (busy) {
    send({ type: 'error', message: t('当前实验尚未完成，请等待或关闭弹窗取消') });
    return;
  }
  busy = true;
  try {
    if (event.data.type === 'load') {
      initializeWorkerLocale(event.data.locale);
      if (session) throw new Error(t('模型已加载，请重新打开实验窗口后再更换'));
      const selectedId = event.data.modelId ?? 'ultra4x';
      const model = PROBE_MODELS.find((candidate) => candidate.id === selectedId);
      if (!model) throw new Error(t('未知的模型配置'));
      scale = model.scale;
      half = model.id.endsWith('-fp16');
      const gpu = (
        navigator as unknown as {
          gpu?: {
            requestAdapter(options: {
              powerPreference: string;
            }): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null>;
          };
        }
      ).gpu;
      const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error(t('此浏览器没有可用 WebGPU 适配器；不会退回 CPU 拖慢游戏'));
      if (half && !(adapter as unknown as { features: Set<string> }).features.has('shader-f16'))
        throw new Error(t('GPU 不支持 shader-f16，请选择 FP32 模型'));
      adapterName =
        [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(' · ') ||
        t('WebGPU（未公开型号）');
      // Load ORT and WASM on demand only in experimental Workers; normal game startup never requests these resources.
      ort = await import('onnxruntime-web/webgpu');
      ort.env.webgpu.adapter = adapter as NonNullable<typeof ort.env.webgpu.adapter>;
      ort.env.wasm.numThreads = 1;
      // Let Vite resolve the location explicitly; after development prebundling, relative paths would resolve to homepage HTML instead of WASM.
      ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
      // Verified AnimeSharp and UltraSharp models share the output/width/height metadata signature;
      // both need the Metal DepthToSpace workaround, but validate final output against each model's registered scale.
      // APISR uses its own reconstruction/HW signature and no pixel-shuffle workaround.
      const bytes = new Uint8Array(event.data.model);
      // Nomos exports already use separate input/output dimension symbols; do not apply other models' metadata patches.
      // It also has one final DepthToSpace node, so retain the Metal pixel-shuffle compatibility path.
      const prepared = model.id.startsWith('nomos2x')
        ? bytes
        : normalizeUltraSharpOutputShape(bytes, model.id === 'apisr2x' ? 'apisr2x' : 'ultra4x');
      const loaded = await ort.InferenceSession.create(prepared, {
        executionProviders: [
          {
            name: 'webgpu',
            ...(model.id !== 'apisr2x' ? { forceCpuNodeNames: ultraSharpCompatibilityNodes(bytes) } : {}),
          },
        ],
        // Some official graph nodes cannot run entirely on WebGPU; retain ORT's per-operator WASM fallback.
        // The UI explicitly reports mixed execution and total duration, which must not be called pure GPU kernel time.
      });
      try {
        validateProbeModelMetadata(loaded.inputMetadata, loaded.outputMetadata, half);
      } catch (error) {
        await loaded.release();
        throw error;
      }
      session = loaded;
      send({ type: 'ready', adapter: adapterName });
    } else {
      if (!ort || !session) throw new Error(t('请先加载模型'));
      const image = event.data.image;
      const height = image.height ?? image.size;
      if (
        !Number.isInteger(image.size) ||
        !Number.isInteger(height) ||
        image.size < 1 ||
        height < 1 ||
        image.size > (event.data.type === 'run-frame' ? 800 : 288) ||
        height > (event.data.type === 'run-frame' ? 600 : 288) ||
        image.rgba.length !== image.size * height * 4
      )
        throw new Error(t('输入尺寸超出实验上限或像素长度不匹配'));
      const tensor = half
        ? new ort.Tensor('float16', halfRgbTensor(image.rgba), [1, 3, height, image.size])
        : new ort.Tensor('float32', probeTensor(image), [1, 3, height, image.size]);
      let outputs: Ort.InferenceSession.ReturnType | undefined;
      try {
        const started = performance.now();
        outputs = await session.run({ [session.inputNames[0]!]: tensor });
        const output = outputs[session.outputNames[0]!]!;
        const raw = output.data;
        const data =
          output.type === 'float16' && ArrayBuffer.isView(raw)
            ? decodeHalf(new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2))
            : raw;
        if (!(data instanceof Float32Array)) throw new Error(t('模型输出不是浮点像素'));
        const result = probeFrameOutput(data, output.dims, image.size, height, scale);
        send({ type: 'result', image: result, milliseconds: performance.now() - started, adapter: adapterName });
      } finally {
        tensor.dispose();
        if (outputs) for (const output of Object.values(outputs)) output.dispose();
      }
    }
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
  }
};
