import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
class ResourceError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

// Keep diagnostics independent of request URLs, signed headers and exception text.
function downloadError(error: unknown): ResourceError {
  if (error instanceof ResourceError) return error;
  const retryable = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  const safe = new Set([...retryable, 'Z_DATA_ERROR', 'ENOENT', 'ENOSPC']);
  let cause = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
    const { code, name, cause: next } = cause as { code?: string; name?: string; cause?: unknown };
    if (code && safe.has(code)) return new ResourceError(code, retryable.has(code));
    if (name === 'TimeoutError' || name === 'AbortError') return new ResourceError('下载超时或中断', true);
    cause = next;
  }
  return new ResourceError('未知错误（地址及异常正文已隐藏）');
}
function validateUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new ResourceError('资源地址须为 HTTPS（本地测试允许回环 HTTP），不接受用户信息');
  }
  return url;
}

async function download(url: string, signal: AbortSignal, progress: () => void): Promise<Response> {
  for (let redirects = 0; redirects <= 10; redirects++) {
    validateUrl(url);
    // Observed in CI: the download server rejects the default Python UA with 403/1010, while a browser UA receives 200 at the same URL.
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal });
    progress();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location') ?? '', url).href;
      continue;
    }
    if (!response.ok) {
      // Output only bounded error categories; never echo URLs, raw headers, response bodies, or network exceptions.
      const server = response.headers.get('server')?.toLowerCase() ?? '';
      const category = ['cloudflare', 'nginx', 'apache', 'amazons3'].find((name) => server.includes(name)) ?? 'other';
      await response.body?.cancel();
      throw new ResourceError(
        `资源下载失败：HTTP ${response.status}; server=${category}`,
        [408, 429, 500, 502, 503, 504].includes(response.status),
      );
    }
    return response;
  }
  throw new ResourceError('资源下载重定向过多');
}

interface DownloadTiming {
  idleMs: number;
  totalMs: number;
  retryMs: number;
}
const DEFAULT_TIMING: DownloadTiming = { idleMs: 60_000, totalMs: 15 * 60_000, retryMs: 1000 };

async function downloadArchive(
  url: string,
  archive: string,
  expected: string,
  signal: AbortSignal,
  timing: DownloadTiming,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    const idle = new AbortController();
    const timeout = setTimeout(() => idle.abort(new ResourceError('下载无进展超时', true)), timing.idleMs);
    const attemptSignal = AbortSignal.any([signal, idle.signal]);
    const progress = () => timeout.refresh();
    try {
      console.log(`资源下载：尝试 ${attempt}/3`);
      const response = await download(url, attemptSignal, progress);
      if (!response.body) throw new ResourceError('资源响应为空');
      const hash = createHash('sha256');
      let size = 0;
      let lastReport = Date.now();
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          progress();
          size += chunk.length;
          if (size > 16 * 1024 ** 3) return callback(new ResourceError('资源下载体积超限'));
          hash.update(chunk);
          if (Date.now() - lastReport >= 30_000) {
            console.log(`资源下载：尝试 ${attempt}/3；已接收 ${size} bytes`);
            lastReport = Date.now();
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        meter,
        createWriteStream(archive, { flags: 'wx' }),
        { signal: attemptSignal },
      );
      clearTimeout(timeout);
      const digest = hash.digest('hex');
      const source = await open(archive, 'r');
      const magic = Buffer.alloc(8);
      try {
        await source.read(magic, 0, 8, 0);
      } finally {
        await source.close();
      }
      const kind =
        magic[0] === 0x1f && magic[1] === 0x8b
          ? 'tar.gz'
          : magic.subarray(0, 2).toString() === 'PK'
            ? 'zip'
            : 'unknown';
      if (!expected) {
        // Without a trusted hash, report only the digest; never automatically accept it as a baseline.
        console.log(`资源格式=${kind}; bytes=${size}; SHA-256=${digest}`);
        throw new ResourceError('请审核资源包并配置固定 SHA-256');
      }
      if (digest !== expected) throw new ResourceError('资源包 SHA-256 不匹配');
      signal.throwIfAborted();
      console.log(`资源下载：完成并通过校验；${size} bytes`);
      return;
    } catch (error) {
      const failure = downloadError(attemptSignal.aborted ? attemptSignal.reason : error);
      if (signal.aborted || !failure.retryable || attempt === 3) throw failure;
      // Restart from byte zero with a new hash; never append unverified partial downloads.
      await rm(archive, { force: true });
      console.log(`资源下载：尝试 ${attempt}/3 失败：${failure.message}；将重新下载`);
    } finally {
      clearTimeout(timeout);
    }
    await delay(timing.retryMs * attempt, undefined, { signal });
  }
}

/** Download original user packages; only a fully verified archive is published. Timing can be shortened for offline tests. */
export async function downloadResources(
  url: string,
  expected: string,
  destination: string,
  timing: DownloadTiming = DEFAULT_TIMING,
): Promise<void> {
  let stage: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let phase = '配置';
  const controller = new AbortController();
  try {
    validateUrl(url);
    if (expected && !/^[a-f0-9]{64}$/.test(expected)) throw new ResourceError('请配置固定的资源包 SHA-256');
    if (!isAbsolute(destination)) throw new ResourceError('目标必须为绝对目录');
    try {
      await lstat(destination);
      throw new ResourceError('目标目录已存在');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(destination), { recursive: true });
    stage = await mkdtemp(join(dirname(destination), '.resource-stage-'));
    const archive = join(stage, 'archive.bin');
    phase = '下载';
    deadline = setTimeout(() => controller.abort(new ResourceError('下载总时限已到')), timing.totalMs);
    await downloadArchive(url, archive, expected, controller.signal, timing);
    await rename(archive, destination);
  } catch (error) {
    const failure = downloadError(controller.signal.aborted ? controller.signal.reason : error);
    throw new Error(`CI 资源准备失败：${phase}阶段：${failure.message}`);
  } finally {
    clearTimeout(deadline);
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
