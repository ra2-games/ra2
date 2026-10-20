import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { screenshot } from '@ra2vm/control/screenshot';
import type { ControlClient } from '@ra2vm/control/client';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
function fixture(pageId = 'page') {
  const request = vi.fn(async (method: string) =>
    method === 'ui.status'
      ? { pageId: 'page' }
      : {
          pageId,
          image: {
            dataUrl: `data:image/png;base64,${png}`,
            mimeType: 'image/png',
            width: 1,
            height: 1,
            sourceWidth: 1,
            sourceHeight: 1,
            presentation: 7,
          },
        },
  );
  return { request, client: { request } as unknown as ControlClient };
}

it('saves image bytes, returns metadata without base64, and never overwrites a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-image-test-'));
  try {
    const path = join(dir, 'capture.png');
    const f = fixture();
    const result = await screenshot(f.client, path);
    expect(f.request).toHaveBeenLastCalledWith('ui.screenshot', { expectedPageId: 'page' });
    expect(result).toMatchObject({ path, presentation: 7, width: 1 });
    expect(JSON.stringify(result)).not.toContain(png);
    expect(await readFile(path)).toEqual(Buffer.from(png, 'base64'));
    await writeFile(path, 'keep');
    await expect(screenshot(f.client, path)).rejects.toThrow('EEXIST');
    expect(await readFile(path, 'utf8')).toBe('keep');
    await expect(screenshot(fixture('new-page').client, join(dir, 'stale.png'))).rejects.toThrow('Session changed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects invalid encodings instead of saving text as an image', async () => {
  const f = fixture();
  f.request.mockImplementation(async (method: string) =>
    method === 'ui.status'
      ? { pageId: 'page' }
      : {
          pageId: 'page',
          image: {
            dataUrl: 'data:image/png;base64,YmFk',
            mimeType: 'image/png',
            width: 1,
            height: 1,
            sourceWidth: 1,
            sourceHeight: 1,
            presentation: 1,
          },
        },
  );
  await expect(screenshot(f.client)).rejects.toThrow('Invalid screenshot image');
});
