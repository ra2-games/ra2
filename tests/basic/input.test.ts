import { describe, expect, it } from 'vitest';
import { keyLParam, normalizePointerButton, rescaleLogicalPointer } from '../../src/ui/pages/game/input';

describe('浏览器指针按键归一化', () => {
  it('还原 macOS 改写的 Ctrl+左键', () => {
    expect(normalizePointerButton(2, true, 'MacIntel')).toBe(0);
    expect(normalizePointerButton(2, true, 'Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe(0);
    expect(normalizePointerButton(2, true, 'Win32', 0x01)).toBe(0);
  });

  it('不改写其他平台或无 Ctrl 的右键', () => {
    expect(normalizePointerButton(2, true, 'Win32')).toBe(2);
    expect(normalizePointerButton(2, true, 'Win32', 0x02)).toBe(2);
    expect(normalizePointerButton(2, false, 'MacIntel')).toBe(2);
  });

  it('为左右 Ctrl 与 Shift 生成真实扫描码', () => {
    const event = (code: string, location: number) => ({
      code,
      key: 'Control',
      location,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
    });
    const leftControl = keyLParam(event('ControlLeft', 1), false, false);
    const rightControl = keyLParam(event('ControlRight', 2), false, false);
    const rightShift = keyLParam(event('ShiftRight', 2), false, false);
    expect((leftControl >>> 16) & 0xff).toBe(0x1d);
    expect((leftControl & 0x0100_0000) !== 0).toBe(false);
    expect((rightControl >>> 16) & 0xff).toBe(0x1d);
    expect((rightControl & 0x0100_0000) !== 0).toBe(true);
    expect((rightShift >>> 16) & 0xff).toBe(0x36);
  });
});

describe('锁定鼠标分辨率适配', () => {
  it('切换分辨率后保持相对屏幕位置并钳制边界', () => {
    expect(rescaleLogicalPointer(400, 300, 800, 600, 1440, 900)).toEqual([720, 450]);
    expect(rescaleLogicalPointer(799, 599, 800, 600, 1440, 900)).toEqual([1439, 899]);
    expect(rescaleLogicalPointer(799, 599, 800, 600, 320, 200)).toEqual([319, 199]);
  });
});
