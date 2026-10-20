import { describe, expect, it } from 'vitest';
import { calculateCanvasFit } from '../../src/ui/pages/game/canvasFit';

describe('canvas 等比适配', () => {
  it('按 1440×900 帧适配宽舞台并保持 16:10', () => {
    const result = calculateCanvasFit({
      stageWidth: 1920,
      stageHeight: 1080,
      frameWidth: 1440,
      frameHeight: 900,
      devicePixelRatio: 1,
    });

    expect(result).toEqual({
      cssWidth: 1728,
      cssHeight: 1080,
      backingWidth: 2880,
      backingHeight: 1800,
    });
    expect(result!.cssWidth / result!.cssHeight).toBeCloseTo(1440 / 900);
  });

  it('按 800×600 帧适配高舞台并保持 4:3', () => {
    const result = calculateCanvasFit({
      stageWidth: 1000,
      stageHeight: 900,
      frameWidth: 800,
      frameHeight: 600,
      devicePixelRatio: 1,
    });

    expect(result).toEqual({
      cssWidth: 1000,
      cssHeight: 750,
      backingWidth: 1600,
      backingHeight: 1200,
    });
    expect(result!.cssWidth / result!.cssHeight).toBeCloseTo(800 / 600);
  });

  it('在非整数缩放和高 DPR 下仍不改变帧比例', () => {
    const result = calculateCanvasFit({
      stageWidth: 1237,
      stageHeight: 777,
      frameWidth: 1440,
      frameHeight: 900,
      devicePixelRatio: 1.25,
    });

    expect(result).not.toBeNull();
    expect(result!.cssWidth).toBeLessThanOrEqual(1237);
    expect(result!.cssHeight).toBeLessThanOrEqual(777);
    expect(result!.cssWidth / result!.cssHeight).toBeCloseTo(1440 / 900, 2);
    expect(result!.backingWidth).toBeGreaterThan(0);
    expect(result!.backingHeight).toBeGreaterThan(0);
  });

  it('拒绝无效尺寸，避免产生非法 CSS 或 backing 尺寸', () => {
    expect(
      calculateCanvasFit({
        stageWidth: 0,
        stageHeight: 900,
        frameWidth: 800,
        frameHeight: 600,
        devicePixelRatio: 1,
      }),
    ).toBeNull();
    expect(
      calculateCanvasFit({
        stageWidth: 1000,
        stageHeight: 900,
        frameWidth: Number.NaN,
        frameHeight: 600,
        devicePixelRatio: 1,
      }),
    ).toBeNull();
  });

  it('在极小舞台中也完整缩小，不因 backing 下限产生裁切', () => {
    const result = calculateCanvasFit({
      stageWidth: 123,
      stageHeight: 80,
      frameWidth: 1440,
      frameHeight: 900,
      devicePixelRatio: 1,
    });

    expect(result).not.toBeNull();
    expect(result!.cssWidth).toBeLessThanOrEqual(123);
    expect(result!.cssHeight).toBeLessThanOrEqual(80);
    expect(result!.backingWidth).toBeGreaterThanOrEqual(360);
    expect(result!.backingHeight).toBeGreaterThanOrEqual(225);
  });
});
