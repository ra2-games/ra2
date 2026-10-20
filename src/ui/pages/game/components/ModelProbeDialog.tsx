import { t, uiLocale, localizeText } from '../../../shared/i18n/translate';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  PROBE_PADDING,
  PROBE_MODELS,
  isLiveModelId,
  type LiveModelId,
  type ProbeImage,
  type ProbeReply,
} from '../experiments/modelProbe';
import './ModelProbeDialog.css';

function Preview({ image, scale }: { image: ProbeImage; scale: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    canvas
      .current!.getContext('2d')!
      .putImageData(
        new ImageData(new Uint8ClampedArray(image.rgba), image.size, image.size),
        -PROBE_PADDING * scale,
        -PROBE_PADDING * scale,
      );
  }, [image, scale]);
  const size = image.size - PROBE_PADDING * scale * 2;
  return <canvas ref={canvas} width={size} height={size} />;
}

/** Independent small-patch probe; never overlay seconds-late inference on the live frame. Closing terminates the Worker. */
export function ModelProbeDialog({
  capture,
  live,
  close,
}: {
  capture(size: number): ProbeImage;
  live?(file: File | null, modelId?: LiveModelId): Promise<void>;
  close(): void;
}) {
  const [modelId, setModelId] = useState<string>('animesharp2x-soft');
  const model = PROBE_MODELS.find((candidate) => candidate.id === modelId)!;
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const worker = useRef<Worker | null>(null),
    generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState(t('请先下载官方模型，再选择本地文件。仅本机推理，不上传模型或游戏画面。'));
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [size, setSize] = useState(128);
  const [before, setBefore] = useState<ProbeImage | null>(null),
    [after, setAfter] = useState<ProbeImage | null>(null);
  const reset = () => {
    generation.current++;
    clearTimeout(timer.current);
    worker.current?.terminate();
    worker.current = null;
  };
  useEffect(() => () => reset(), []);
  const deadline = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      reset();
      setBusy(false);
      setReady(false);
      setStatus(t('实验超过 120 秒已终止，游戏继续使用原来的渲染器。可减小采样尺寸后重新加载模型。'));
    }, 120_000);
  };
  const load = async (file: File) => {
    setSelectedFile(file);
    reset();
    setReady(false);
    setAfter(null);
    setBusy(true);
    const token = generation.current;
    try {
      if (file.size < 1 || file.size > 40 * 1024 * 1024)
        throw new Error(t('请选择 {0} ONNX（约 {1} MB）', model.name, model.megabytes));
      setStatus(t('正在校验模型并初始化 WebGPU…'));
      const modelBytes = await file.arrayBuffer();
      if (generation.current !== token) return;
      const instance = new Worker(new URL('../experiments/modelProbeWorker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      const failed = (message: string) => {
        reset();
        setReady(false);
        setBusy(false);
        setStatus(message);
      };
      instance.onerror = (event) => {
        event.preventDefault();
        if (worker.current === instance) failed(t('模型实验失败：{0}', event.message));
      };
      instance.onmessage = ({ data }: MessageEvent<ProbeReply>) => {
        if (worker.current !== instance) return;
        clearTimeout(timer.current);
        setBusy(false);
        if (data.type === 'error') {
          failed(t('模型实验失败：{0}', data.message));
          return;
        }
        if (data.type === 'ready') {
          setReady(true);
          setStatus(t('WebGPU 已就绪 · {0}（允许 WASM 兼容算子）；可采样当前游戏中心区域。', data.adapter));
        } else {
          setAfter(data.image);
          setStatus(
            t(
              '{0} · {1} ms/块（含兼容算子与回读）· {2}；单次采样，不是游戏 FPS。',
              model.name,
              data.milliseconds.toFixed(1),
              data.adapter,
            ),
          );
        }
      };
      deadline();
      instance.postMessage({ type: 'load', model: modelBytes, modelId, locale: uiLocale }, [modelBytes]);
    } catch (error) {
      if (generation.current !== token) return;
      reset();
      setBusy(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const run = () => {
    if (!ready || busy || !worker.current) return;
    try {
      const image = capture(size);
      setBefore(image);
      setAfter(null);
      setBusy(true);
      setStatus(t('正在采样推理；可随时关闭实验窗口取消。'));
      // Keep one UI preview and transfer only an independent copy; never touch recyclable VM frame buffers.
      const copy = { ...image, rgba: image.rgba.slice() };
      deadline();
      worker.current.postMessage({ type: 'run', image: copy }, [copy.rgba.buffer]);
    } catch (error) {
      setBusy(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Modal open title={t('WebGPU 模型实验')} onClose={close} className="model-probe-dialog message-box">
      <header>
        <h3>
          {model.name} {t('· WebGPU 实验')}
        </h3>
        <button type="button" className="dialog-button" onClick={close}>
          {t('关闭并释放模型')}{' '}
        </button>
      </header>
      <fieldset>
        <legend>{t('实验模型')}</legend>
        {PROBE_MODELS.map((item) => (
          <label key={item.id}>
            <input
              type="radio"
              name="probe-model"
              value={item.id}
              checked={modelId === item.id}
              onChange={() => {
                reset();
                setSelectedFile(null);
                setModelId(item.id);
                setReady(false);
                setBusy(false);
                setBefore(null);
                setAfter(null);
                setStatus(t('请下载并选择当前模型；切换已释放旧模型。'));
              }}
            />
            {item.name}
          </label>
        ))}
      </fieldset>
      <p>
        {t('采样仅测试画质与耗时，不替换实时画面；支持的模型可另外启用下方整帧显示。首轮含编译开销，建议重复采样。')}
      </p>
      <p>
        {model.scale === 2
          ? t('原生 2× 模型，不是 4× 后缩小，也不是红警专用模型；请比较单位、文字和地形细节。')
          : t('Metal 兼容：末端像素重排使用 WASM，卷积仍使用 WebGPU。')}
      </p>
      {model.id.startsWith('animesharp2x-') && (
        <p>
          {t(
            'Soft 适合较干净的输入；Sharp 面向严重退化输入，可能过度处理细节。建议在同一场景对照。Metal 兼容：末端像素重排使用 WASM。',
          )}{' '}
        </p>
      )}
      {model.id.startsWith('nomos2x') && (
        <p>
          {t(
            '官方 safetensors 本地导出；下方链接不是官方 ONNX 下载。缺文件时按 docs/AI_UPSCALING.md 准备。末端像素重排使用 FP32 WASM。FP16 要求 shader-f16，是半精度转换而非 INT8 量化，画质和硬件延迟需实测。',
          )}{' '}
        </p>
      )}
      <p>
        <a href={model.url} target="_blank" rel="noopener noreferrer">
          {t('下载当前模型')} {model.id.endsWith('-fp16') ? 'FP16' : 'FP32'} ONNX（{model.megabytes} MB）↗
        </a>{' '}
        · {model.license}
      </p>
      <label>
        {t('选择本地模型')}{' '}
        <input
          type="file"
          accept=".onnx"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void load(file);
          }}
        />
      </label>
      <div className="model-probe-actions">
        <label>
          {t('中心采样边长')}{' '}
          <input
            type="number"
            min={32}
            max={256}
            step={16}
            value={size}
            disabled={busy}
            onChange={(event) => setSize(Number(event.target.value))}
          />
        </label>
        <button type="button" className="dialog-button" disabled={!ready || busy} onClick={run}>
          {t('采样并推理')}{' '}
        </button>
      </div>
      <p role="status">{localizeText(status)}</p>
      {isLiveModelId(model.id) && live && (
        <section>
          <p>
            {t('整帧显示实验：输入最多 800×600，输出最高')} {800 * model.scale}×{600 * model.scale}
            {t(
              '。异步单任务，画面可能明显滞后；不保证实时帧率或 1ms。请先用小块确认 GPU 能运行当前模型，再启用。',
            )}{' '}
          </p>
          <button
            type="button"
            className="dialog-button"
            disabled={!ready || busy || !selectedFile}
            onClick={() => {
              if (!selectedFile || !isLiveModelId(model.id)) return;
              // Release the patch model first so one GPU does not retain two models and activation caches at once.
              reset();
              setReady(false);
              const file = selectedFile;
              close();
              void live(file, model.id).catch(() => {
                /* The page status bar reports loading errors; the stop button remains available. */
              });
            }}
          >
            {t('接入整帧显示并测延迟')}{' '}
          </button>
        </section>
      )}
      <div className="model-probe-comparison">
        {before && (
          <figure>
            <figcaption>{t('原图（最近邻显示）')}</figcaption>
            <Preview image={before} scale={1} />
          </figure>
        )}
        {after && (
          <figure>
            <figcaption>
              {model.name} · {after.size - PROBE_PADDING * model.scale * 2}×
              {after.size - PROBE_PADDING * model.scale * 2}
            </figcaption>
            <Preview image={after} scale={model.scale} />
          </figure>
        )}
      </div>
    </Modal>
  );
}
