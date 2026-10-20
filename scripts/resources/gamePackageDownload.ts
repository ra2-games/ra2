/** Download entry point for Node tools; the browser retains only local game-package parsing. */
import { loadRemoteGamePackageBytes, type RemotePackageOptions } from '../../src/adapter/gameZip';
import { sha256Hex } from '../../src/utils/sha256';

export async function fetchPackageFile(
  url: string,
  onProgress?: (downloaded: number, total?: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`游戏包下载失败（HTTP ${response.status}）：${url}`);
  if (!response.body) throw new Error(`游戏包响应没有内容：${url}`);
  const length = Number(response.headers.get('Content-Length'));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;
      onProgress?.(downloaded, total);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function loadRemoteGamePackage(url: string, options: RemotePackageOptions & { sha256?: string } = {}) {
  const bytes = await fetchPackageFile(url);
  if (options.sha256) {
    const actual = await sha256Hex(bytes);
    if (actual !== options.sha256) throw new Error(`游戏包 SHA-256 不匹配：${actual}`);
  }
  return loadRemoteGamePackageBytes(bytes, options);
}
