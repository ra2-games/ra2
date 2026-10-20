import '../helpers/chineseLocale';
import { describe, expect, it } from 'vitest';
import {
  validateProbeModelMetadata,
  captureProbeImage,
  probeTensor,
  probeOutput,
  PROBE_MODELS,
} from '../../src/ui/pages/game/experiments/modelProbe';
import type { VmFrame } from '../../src/vm86/win32';

describe('独立模型实验像素边界', () => {
  it('Nomos 使用本地导出的固定 FP32 ONNX 与原生 2× 倍率', () => {
    const model = PROBE_MODELS.find((model) => model.id === 'nomos2x')!;
    expect(model.scale).toBe(2);
    expect(model.url).toBe('/.tmp-models/nomosuni-span-2x-fp32.onnx');
    expect(model.license).toContain('CC BY 4.0');
  });
  it('AnimeSharp Sharp/Soft 使用不同下载路径且均为原生 2×', () => {
    const models = PROBE_MODELS.filter((model) => model.id.startsWith('animesharp2x-'));
    expect(models).toHaveLength(2);
    expect(new Set(models.map((model) => model.url)).size).toBe(2);
    for (const model of models) {
      expect(model.scale).toBe(2);
      expect(model.url).toContain('/2x-AnimeSharpV2_Set/2x-AnimeSharpV2_RPLKSR_');
      expect(model.url).toMatch(/_fp32\.onnx$/);
    }
  });
  const base: VmFrame = {
    width: 1,
    height: 1,
    pixels: new Uint8Array([1]),
    palette: new Uint8Array([0, 0, 0, 0, 255, 0, 0, 0]),
  };
  it('RGBA、RGB565、索引色采样一致，边缘钳制，独立副本不会随 VM 回收改变', () => {
    const rgba = new Uint8Array([255, 0, 0, 0]);
    const expected = captureProbeImage(base, 32);
    expect(expected.size).toBe(64);
    const copy = captureProbeImage({ ...base, rgba }, 32);
    expect(copy).toEqual(expected);
    expect(captureProbeImage({ ...base, rgb565: new Uint16Array([0xf800]) }, 32)).toEqual(expected);
    rgba.fill(0);
    expect(copy.rgba.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
  });
  it('NCHW/RGB 顺序与 0～1 归一化固定', () => {
    expect(probeTensor({ size: 1, rgba: new Uint8ClampedArray([255, 0, 255, 255]) })).toEqual(
      new Float32Array([1, 0, 1]),
    );
    expect(() => probeTensor({ size: 2, rgba: new Uint8ClampedArray(4) })).toThrow('长度');
  });
  it('输出必须是 4× RGB 且有限，透明度不继承客体未初始化的 alpha', () => {
    const values = new Float32Array(48);
    values.fill(1, 0, 16);
    const image = probeOutput(values, [1, 3, 4, 4], 1);
    expect(image.rgba.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
    expect(() => probeOutput(values, [1, 3, 2, 8], 1)).toThrow('4×');
    values[0] = NaN;
    expect(() => probeOutput(values, [1, 3, 4, 4], 1)).toThrow('NaN');
  });
  it.each([0, 31, 257, 64.5, NaN])('拒绝异常采样边长 %s', (size) => {
    expect(() => captureProbeImage(base, size)).toThrow('32～256');
  });
  it('原生 2× 输出独立校验，不能把 4× 结果当作 2×', () => {
    const image = probeOutput(new Float32Array(12).fill(0.5), [1, 3, 2, 2], 1, 2);
    expect(image.size).toBe(2);
    expect(image.rgba.slice(0, 4)).toEqual(new Uint8ClampedArray([128, 128, 128, 255]));
    expect(() => probeOutput(new Float32Array(48), [1, 3, 4, 4], 1, 2)).toThrow('2×');
  });
});

describe('model tensor contracts', () => {
  const rgb = { isTensor: true, type: 'float32', shape: [1, 3, 'h', 'w'] } as const;
  it('accepts dynamic RGB tensors independently of weight identity', () => {
    expect(() => validateProbeModelMetadata([rgb], [rgb], false)).not.toThrow();
  });
  it('rejects unsupported precision, shape, and multiple inputs', () => {
    for (const value of [
      { ...rgb, type: 'int8' },
      { ...rgb, shape: [1, 4, 'h', 'w'] },
      { ...rgb, shape: [1, 3, 0, 32] },
      { isTensor: false },
    ])
      expect(() => validateProbeModelMetadata([value], [rgb], false)).toThrow();
    expect(() => validateProbeModelMetadata([rgb, rgb], [rgb], false)).toThrow();
    expect(() => validateProbeModelMetadata([rgb], [rgb], true)).toThrow();
  });
});
