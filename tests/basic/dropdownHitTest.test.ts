/**
 * Hit-test priority for expanded dropdowns:
 * When row 2's dropdown overlaps row 4's Y range, clicking an item in the popup must hit row 2's dropdown (native Win32 popups float above sibling controls), not row 4 beneath it.
 * Regression scenario: choosing difficulty in row 2 on the Skirmish settings page accidentally opened row 4.
 */
import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

const X = 100;
const ROW_Y2 = 30;
const ROW_Y4 = 70;
const W = 200;
const H = 20;

interface Tree {
  memory: ReturnType<typeof createGuestMemory>;
  shim: ReturnType<typeof createTestShim>;
  row2: number;
  row4: number;
}

function buildTree(): Tree {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { gameId: 'ra2' });
  // Top-level #32770 page (800x600 visible) -> primaryWindow.
  writeAsciiZ(memory, 0x60_000, '#32770');
  const page = callShim(
    shim,
    'USER32.DLL!CreateWindowExA',
    [0, 0x60_000, 0, 0x1000_0000, 0, 0, 800, 600, 0, 0, 0, 0],
  ).eax;
  // Two sibling ComboBoxes at the positions of rows 2 and 4.
  writeAsciiZ(memory, 0x60_100, 'ComboBox');
  const make = (y: number, id: number): number =>
    callShim(shim, 'USER32.DLL!CreateWindowExA', [0, 0x60_100, 0, 0x5000_0000, X, y, W, H, page, id, 0, 0]).eax;
  const row2 = make(ROW_Y2, 1771);
  const row4 = make(ROW_Y4, 1772);
  return { memory, shim, row2, row4 };
}

/** Press once at host screen coordinates (screenX, screenY) and return the hwnd that actually received the message. */
function clickTarget(tree: Tree, screenX: number, screenY: number): number {
  const { shim } = tree;
  shim.setCursorPosition(screenX, screenY);
  shim.postMessage(0x0201, 0x0001, (screenY << 16) | (screenX & 0xffff));
  const trace = shim.inspectHostInputTrace();
  return trace.at(-1)!.hwnd;
}

describe('展开下拉命中优先级', () => {
  it('行 2 下拉展开且弹出区覆盖行 4 时，点行 4 区域命中行 2', () => {
    const tree = buildTree();
    const { shim, row2 } = tree;
    // The game opens row 2's dropdown: CB_SHOWDROPDOWN plus full-height layout records a drop extent of 120.
    callShim(shim, 'USER32.DLL!SendMessageA', [row2, 0x014f, 1, 0]);
    callShim(shim, 'USER32.DLL!MoveWindow', [row2, X, ROW_Y2, W, 120, 1]);
    // The click lies within both row 4 and row 2's expanded area.
    const target = clickTarget(tree, X + 60, ROW_Y4 + 8);
    expect(target).toBe(row2);
  });

  it('行 2 收起时，同一位置命中行 4（不误伤平级控件）', () => {
    const tree = buildTree();
    const { shim, row2, row4 } = tree;
    callShim(shim, 'USER32.DLL!SendMessageA', [row2, 0x014f, 1, 0]);
    callShim(shim, 'USER32.DLL!MoveWindow', [row2, X, ROW_Y2, W, 120, 1]);
    callShim(shim, 'USER32.DLL!SendMessageA', [row2, 0x014f, 0, 0]); // Collapse
    const target = clickTarget(tree, X + 60, ROW_Y4 + 8);
    expect(target).toBe(row4);
  });
});
