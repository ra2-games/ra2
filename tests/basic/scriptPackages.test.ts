import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { fetchPackageFile, loadRemoteGamePackage } from '../../scripts/resources/gamePackageDownload';

const script = fileURLToPath(new URL('../../scripts/resources/syncGamePackages.mts', import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const content = new TextEncoder().encode('本地同步测试');
const zip = zipSync({ 'DATA/Rules.INI': content, 'movies01.mix': new Uint8Array() });
const sha256 = createHash('sha256').update(zip).digest('hex');
let directory: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

async function serve(status = 200): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(status, { 'Content-Length': zip.length });
    response.end(zip);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务器未监听 TCP');
  return `http://127.0.0.1:${address.port}/package.zip`;
}

async function sync(env: Record<string, string> = {}) {
  directory = await mkdtemp(join(tmpdir(), 'ra2-sync-test-'));
  return new Promise<{ code: number | string; output: string }>((resolve) => {
    // A real tsx subprocess covers ESM export resolution; isolate its working directory from the developer's game files.
    execFile(
      process.execPath,
      ['--import', tsx, script, 'ra2'],
      {
        cwd: directory,
        env: { ...process.env, RA2_PACKAGE_URL: '', RA2_PACKAGE_SHA256: '', YR_PACKAGE_URL: '', ...env },
        timeout: 10_000,
      },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, output: stdout + stderr }),
    );
  });
}

describe('Node 游戏包工具', () => {
  it('同步入口实际下载、校验并留档解压，保留零字节文件', async () => {
    const result = await sync({ RA2_PACKAGE_URL: await serve(), RA2_PACKAGE_SHA256: sha256 });
    expect(result.code, result.output).toBe(0);
    expect(await readFile(join(directory!, 'game/ra2-base.zip'))).toEqual(Buffer.from(zip));
    expect(await readFile(join(directory!, 'game/ra2/data/rules.ini'))).toEqual(Buffer.from(content));
    expect(await readFile(join(directory!, 'game/ra2/movies01.mix'))).toHaveLength(0);
  });

  it('同步哈希错误时退出失败，不写入未验证的包', async () => {
    const result = await sync({ RA2_PACKAGE_URL: await serve(), RA2_PACKAGE_SHA256: '0'.repeat(64) });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(`SHA-256 不匹配：${sha256}`);
    expect(await readdir(directory!)).toEqual([]);
  });

  it('没有下载源时说明配置方法，不能报告同步完成', async () => {
    const result = await sync();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('RA2_PACKAGE_URL');
    expect(result.output).toContain('未同步任何游戏包');
    expect(result.output).toContain('资源包需包含原始游戏主程序');
  });

  it('下载失败保留 HTTP 状态', async () => {
    await expect(fetchPackageFile(await serve(503))).rejects.toThrow('HTTP 503');
  });

  it('冒烟工具复用下载/哈希检查与现有字节解析 API', async () => {
    const url = await serve();
    const progress: Array<[number, number | undefined]> = [];
    expect(await fetchPackageFile(url, (downloaded, total) => progress.push([downloaded, total]))).toEqual(zip);
    expect(progress.at(-1)).toEqual([zip.length, zip.length]);
    const provider = await loadRemoteGamePackage(url, { sha256 });
    expect(await provider.read('data/rules.ini')).toEqual(content);
    await expect(loadRemoteGamePackage(url, { sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256 不匹配');
  });
});
