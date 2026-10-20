import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_CONTROL_MESSAGE } from './protocol';
import type { ControlClient } from './client';

/** Keep image bytes out of textual model context; callers open the resulting local file. */
export async function screenshot(client: ControlClient, output?: string) {
  const status = await client.request<{ pageId: string }>('ui.status');
  const reply = await client.request<{
    pageId: string;
    image: {
      dataUrl: string;
      mimeType: string;
      width: number;
      height: number;
      sourceWidth: number;
      sourceHeight: number;
      presentation: number;
    };
  }>('ui.screenshot', { expectedPageId: status.pageId });
  if (reply.pageId !== status.pageId) throw new Error('Session changed during screenshot');
  const image = reply.image;
  if (!image || typeof image.dataUrl !== 'string' || image.dataUrl.length > MAX_CONTROL_MESSAGE)
    throw new Error('Invalid screenshot response');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match || image.mimeType !== `image/${match[1]}`) throw new Error('Invalid screenshot encoding');
  for (const value of [image.width, image.height, image.sourceWidth, image.sourceHeight, image.presentation])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid screenshot metadata');
  const bytes = Buffer.from(match[2]!, 'base64');
  const signature =
    match[1] === 'png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!signature) throw new Error('Invalid screenshot image');
  const path = output
    ? resolve(output)
    : join(await mkdtemp(join(tmpdir(), 'ra2ctl-image-')), `view.${match[1] === 'png' ? 'png' : 'jpg'}`);
  await writeFile(path, bytes, { flag: 'wx' });
  const { dataUrl: _, ...metadata } = image;
  return { event: 'screenshot-saved', pageId: reply.pageId, path, ...metadata };
}
