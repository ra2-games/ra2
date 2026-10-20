import type { CapturedFrame } from '../../graphics/presentedFrameCapture';
import { MAX_CONTROL_MESSAGE } from '@ra2vm/control/protocol';

/** Encode a copied presentation, never a guest surface or an off-screen world view. */
export function encodeFrameImage(frame: CapturedFrame) {
  const source = document.createElement('canvas');
  source.width = frame.width;
  source.height = frame.height;
  const context = source.getContext('2d');
  if (!context) throw new Error('Image encoding unavailable');
  const image = context.createImageData(frame.width, frame.height);
  image.data.set(frame.rgba);
  context.putImageData(image, 0, 0);
  const scale = Math.min(1, 1600 / Math.max(frame.width, frame.height));
  const canvas = scale === 1 ? source : document.createElement('canvas');
  if (canvas !== source) {
    canvas.width = Math.max(1, Math.round(frame.width * scale));
    canvas.height = Math.max(1, Math.round(frame.height * scale));
    const scaled = canvas.getContext('2d');
    if (!scaled) throw new Error('Image scaling unavailable');
    scaled.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  // Reserve space for metadata and the routing envelope within the existing wire limit.
  const limit = MAX_CONTROL_MESSAGE - 4096;
  let dataUrl = canvas.toDataURL('image/png');
  for (const quality of [0.9, 0.75, 0.5]) {
    if (dataUrl.length <= limit) break;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  if (dataUrl.length > limit || !/^data:image\/(png|jpeg);base64,/.test(dataUrl))
    throw new Error('Captured image exceeds control transport limit');
  return {
    dataUrl,
    mimeType: dataUrl.startsWith('data:image/png;') ? 'image/png' : 'image/jpeg',
    width: canvas.width,
    height: canvas.height,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    presentation: frame.presentation,
  };
}
