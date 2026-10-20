import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { downloadResources } from '../../scripts/ci/downloadResources';

it.each(['valid', 'bad-hash', 'http-error', 'missing-hash', 'redirect', 'insecure-redirect'])(
  '原始游戏包下载：%s；校验后才发布，不泄露 URL 或留下半成品',
  async (scenario) => {
    const bytes = Buffer.from('arbitrary user archive fixture');
    const base = await mkdtemp(join(tmpdir(), 'ra2-resource-download-'));
    const destination = join(base, 'archive.bin');
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      if (!request.headers['user-agent']?.startsWith('Mozilla/5.0')) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (scenario === 'insecure-redirect' || (scenario === 'redirect' && request.url?.startsWith('/private'))) {
        response.writeHead(302, {
          location: scenario === 'insecure-redirect' ? 'http://invalid.example/private' : '/final',
        });
        response.end();
        return;
      }
      response.writeHead(scenario === 'http-error' ? 403 : 200, { Server: 'nginx do-not-print-this' });
      response.end(scenario === 'http-error' ? 'do-not-print-this' : bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/private?token=do-not-print-this`;
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const hash = createHash('sha256').update(bytes).digest('hex');
      const task = downloadResources(
        url,
        scenario === 'missing-hash' ? '' : scenario === 'bad-hash' ? '0'.repeat(64) : hash,
        destination,
      );
      if (scenario === 'valid' || scenario === 'redirect') {
        await task;
        expect(await readFile(destination)).toEqual(bytes);
        expect(await readdir(base)).toEqual(['archive.bin']);
      } else {
        const error = await task.then(
          () => {
            throw new Error('应失败');
          },
          (error) => error as Error,
        );
        expect(error.message).toContain('CI 资源准备失败');
        if (scenario === 'missing-hash')
          expect(output).toHaveBeenCalledWith(expect.stringContaining(`SHA-256=${hash}`));
        if (scenario === 'http-error') expect(error.message).toContain('HTTP 403; server=nginx');
        expect(error.message + JSON.stringify(output.mock.calls)).not.toContain('do-not-print-this');
        expect(await readdir(base)).toEqual([]);
      }
      expect(requests).toBe(scenario === 'redirect' ? 2 : 1);
    } finally {
      output.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(base, { recursive: true, force: true });
    }
  },
);

it.each(['headers-stall', 'body-stall', 'connection-reset', 'http-transient', 'exhausted', 'deadline'])(
  '下载恢复：%s；取消停滞请求、从头重试并保持完整性边界',
  async (scenario) => {
    const bytes = Buffer.from('complete verified archive fixture');
    const base = await mkdtemp(join(tmpdir(), 'ra2-resource-retry-'));
    const destination = join(base, 'archive.bin');
    let requests = 0;
    let disconnected = 0;
    const server = createServer((request, response) => {
      requests++;
      request.on('close', () => disconnected++);
      if (scenario === 'exhausted' || scenario === 'deadline' || (requests === 1 && scenario === 'headers-stall'))
        return;
      if (requests === 1 && scenario === 'http-transient') {
        response.writeHead(503, { Server: 'nginx private-address' });
        response.end('private-response');
        return;
      }
      if (requests === 1 && (scenario === 'body-stall' || scenario === 'connection-reset')) {
        response.writeHead(200, { 'Content-Length': bytes.length });
        response.write(bytes.subarray(0, 5));
        if (scenario === 'connection-reset') setImmediate(() => response.destroy());
        return;
      }
      response.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const task = downloadResources(
        `http://127.0.0.1:${port}/private-address?secret=private-token`,
        createHash('sha256').update(bytes).digest('hex'),
        destination,
        { idleMs: 150, totalMs: scenario === 'deadline' ? 50 : 3000, retryMs: 1 },
      );
      if (scenario === 'exhausted' || scenario === 'deadline') {
        await expect(task).rejects.toThrow(scenario === 'deadline' ? '下载总时限已到' : '下载无进展超时');
        expect(requests).toBe(scenario === 'deadline' ? 1 : 3);
        expect(await readdir(base)).toEqual([]);
      } else {
        await task;
        expect(requests).toBe(2);
        expect(await readFile(destination)).toEqual(bytes);
        expect(await readdir(base)).toEqual(['archive.bin']);
      }
      await vi.waitFor(() => expect(disconnected).toBe(requests));
      const log = JSON.stringify(output.mock.calls);
      expect(log).not.toMatch(/private-address|private-token|private-response/);
      expect(log).toContain('尝试 1/3');
    } finally {
      output.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(base, { recursive: true, force: true });
    }
  },
);
