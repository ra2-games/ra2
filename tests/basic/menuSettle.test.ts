/**
 * Quiet coalescing for menu-shell presentation:
 * Menu repainting often spans two guest frames (erase old highlight, draw new highlight). Worker backpressure can present each separately, exposing intermediate states and flickering on selection.
 * If the presentation callback sees further surface changes on a shell page, wait one additional round at most to coalesce erase+draw into the final state. Battle behavior (no shell page) stays unchanged.
 *
 * The unit-test shim lacks guestSurfaceFastPath, so Unlock alone does not mark dirty. Drive presentation with paired Lock (mark dirty) -> Unlock (emit) calls.
 */
import { describe, expect, it } from 'vitest';
import type { VmFrame } from '../../src/vm86/win32';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

const W = 800;
const H = 600;

function setup(shellVisible: boolean) {
  const memory = createGuestMemory();
  const frames: VmFrame[] = [];
  const queued: Array<() => void> = [];
  const shim = createTestShim(memory, {
    gameId: 'ra2',
    onFrame: (frame) => frames.push(frame),
    scheduleFrame: (emit) => queued.push(emit),
    deferFrameSnapshot: true,
  });
  if (shellVisible) {
    // Fullscreen #32770 dialog plus visible title control (id 1684) -> isShellVisible() = true.
    writeAsciiZ(memory, 0x50_000, '#32770');
    const dialog = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      0x50_000,
      0,
      0x1000_0000,
      0,
      0,
      W,
      H,
      0,
      0,
      0,
      0,
    ]).eax;
    writeAsciiZ(memory, 0x50_100, 'Static');
    callShim(shim, 'USER32.DLL!CreateWindowExA', [0, 0x50_100, 0, 0x5000_0000, 0, 0, 200, 20, dialog, 1684, 0, 0]);
    (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'choosemap';
  }
  callShim(shim, 'DDRAW.COM!IDirectDraw.SetDisplayMode', [0, W, H, 16]);
  const desc = 0x10_000;
  const out = 0x10_100;
  writeU32(memory, desc, 108);
  writeU32(memory, desc + 4, 6 | 1);
  writeU32(memory, desc + 8, H);
  writeU32(memory, desc + 12, W);
  writeU32(memory, desc + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
  const result = callShim(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
  if (result.eax !== 0) throw new Error(`CreateSurface failed: ${result.eax}`);
  const primary = readU32(memory, out);
  const draw = (): void => {
    // Lock marks dirty; Unlock emits (content is unchanged; this only drives the presentation state machine).
    callShim(shim, 'DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, desc, 0]);
    callShim(shim, 'DDRAW.COM!IDirectDrawSurface.Unlock', [primary, 0]);
  };
  const runScheduled = (): number => {
    let count = 0;
    while (queued.length) {
      const emit = queued.shift()!;
      count++;
      emit();
    }
    return count;
  };
  return { memory, frames, queued, shim, primary, draw, runScheduled };
}

describe('菜单壳页呈现静默合并', () => {
  it('等待窗口内的第二次重绘合并成一次呈现（不呈现擦旧中间态）', () => {
    const page = setup(true);
    page.draw(); // First repaint: erase the old highlight
    expect(page.queued.length).toBe(1);
    expect(page.frames).toHaveLength(0); // The callback has not been released; nothing presented yet

    page.draw(); // Before releasing the callback, the guest finishes the second repaint: draw the new highlight
    const runs = page.runScheduled();
    // The first callback sees continued changes and defers one round; the second presents the final frame.
    expect(runs).toBe(2);
    expect(page.frames).toHaveLength(1);
    expect(page.queued).toHaveLength(0);
  });

  it('持续重绘（动画）时最多推迟一轮，不会饿死呈现', () => {
    const page = setup(true);
    page.draw();
    expect(page.runScheduled()).toBe(1);
    expect(page.frames).toHaveLength(1);
    page.draw();
    page.runScheduled();
    expect(page.frames).toHaveLength(2);
  });

  it('对战中（无壳页）保持原有逐帧呈现语义', () => {
    const page = setup(false);
    page.draw();
    expect(page.queued.length).toBe(1);
    expect(page.frames).toHaveLength(0);
    page.runScheduled();
    // The deferred snapshot reads the surface when the callback is released, incorporating updates made while waiting.
    expect(page.frames).toHaveLength(1);
    expect(page.frames[0]!.width).toBe(W);
    expect(page.queued).toHaveLength(0);
    // Later repaints continue at the original cadence.
    page.draw();
    page.runScheduled();
    expect(page.frames).toHaveLength(2);
  });
});
