/** Core DirectSound/PCM data protocol; adapters provide concrete output. */
export interface PcmWaveFormat {
  wFormatTag: number;
  nChannels: number;
  nSamplesPerSec: number;
  nAvgBytesPerSec: number;
  nBlockAlign: number;
  wBitsPerSample: number;
  cbSize: number;
}

export interface PcmPlayOptions {
  loop?: boolean;
  fromByte?: number;
}

export const DEFAULT_PCM_FORMAT: Readonly<PcmWaveFormat> = Object.freeze({
  wFormatTag: 1,
  nChannels: 2,
  nSamplesPerSec: 22_050,
  nAvgBytesPerSec: 88_200,
  nBlockAlign: 4,
  wBitsPerSample: 16,
  cbSize: 0,
});

export function parsePcmWaveFormatEx(bytes: Uint8Array, offset = 0): PcmWaveFormat {
  if (offset < 0 || bytes.byteLength - offset < 16) throw new RangeError('WAVEFORMATEX 至少需要 16 字节');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return normalizePcmWaveFormat({
    wFormatTag: view.getUint16(offset, true),
    nChannels: view.getUint16(offset + 2, true),
    nSamplesPerSec: view.getUint32(offset + 4, true),
    nAvgBytesPerSec: view.getUint32(offset + 8, true),
    nBlockAlign: view.getUint16(offset + 12, true),
    wBitsPerSample: view.getUint16(offset + 14, true),
    cbSize: bytes.byteLength - offset >= 18 ? view.getUint16(offset + 16, true) : 0,
  });
}

export function normalizePcmWaveFormat(format: PcmWaveFormat): PcmWaveFormat {
  if (format.wFormatTag !== 1) throw new Error(`PCM format tag 不支持: ${format.wFormatTag}`);
  const channels = Math.trunc(format.nChannels);
  const sampleRate = Math.trunc(format.nSamplesPerSec);
  const bits = Math.trunc(format.wBitsPerSample);
  if (channels < 1 || channels > 32) throw new RangeError(`无效 PCM 声道数: ${channels}`);
  if (sampleRate < 3_000 || sampleRate > 384_000) throw new RangeError(`无效 PCM 采样率: ${sampleRate}`);
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) throw new RangeError(`不支持 ${bits}-bit PCM`);
  const packedBlockAlign = channels * (bits >>> 3);
  const blockAlign = Math.trunc(format.nBlockAlign) || packedBlockAlign;
  if (blockAlign < packedBlockAlign) throw new RangeError(`无效 PCM block align: ${blockAlign}`);
  return {
    wFormatTag: 1,
    nChannels: channels,
    nSamplesPerSec: sampleRate,
    nAvgBytesPerSec: Math.trunc(format.nAvgBytesPerSec) || sampleRate * blockAlign,
    nBlockAlign: blockAlign,
    wBitsPerSample: bits,
    cbSize: Math.max(0, Math.trunc(format.cbSize)),
  };
}
