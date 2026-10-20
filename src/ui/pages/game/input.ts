import { t } from '../../shared/i18n/translate';
/**
 * Helpers for constructing and injecting Win32 keyboard messages.
 *
 * Keep pure functions, no module-level mutable state, and no DOM: page.ts has no HMR accept, so invalidation propagates into a full-page refresh; state held here would leak across HMR. Both real KeyboardEvent and touch-toolbar SyntheticKey satisfy KeyLike.
 */

export interface KeyLike {
  code: string;
  key: string;
  location: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** VM-shell keyboard-injection target; Win32GameVm satisfies this without an adapter dependency. */
export interface KeyStrokeTarget {
  postMessage(message: number, wParam?: number, lParam?: number): void;
  setKeyState(virtualKey: number, down: boolean): void;
}

/** Preserve the locked cursor's relative screen position when guest resolution changes. */
export function rescaleLogicalPointer(
  x: number,
  y: number,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): [number, number] {
  const width = Math.max(1, toWidth);
  const height = Math.max(1, toHeight);
  const sourceWidth = Math.max(1, fromWidth);
  const sourceHeight = Math.max(1, fromHeight);
  const scaleAxis = (value: number, source: number, target: number): number => {
    if (value <= 0 || target <= 1) return 0;
    // Map edges exactly to edges: scaling 799/800 to 1440 by ordinary ratios gives only 1438.2,
    // permanently leaving the locked cursor one column short after resolution changes and breaking edge scrolling.
    if (value >= source - 1) return target - 1;
    return Math.max(0, Math.min(target - 1, (value * target) / source));
  };
  return [scaleAxis(x, sourceWidth, width), scaleAxis(y, sourceHeight, height)];
}

/**
 * macOS rewrites Ctrl+primary as a secondary button in the DOM, but the game needs the original Ctrl+left-click. Restore only on Apple platforms, preserving genuine Ctrl+right-click elsewhere.
 */
export function normalizePointerButton(button: number, ctrlKey: boolean, platform: string, buttons = 0): number {
  return ctrlKey &&
    (((button === 0 || button === 2) && (buttons & 0x01) !== 0) ||
      (button === 2 && /(?:Macintosh|MacIntel|iPhone|iPad|iPod)/i.test(platform)))
    ? 0
    : button;
}

export function keyLParam(event: KeyLike, released: boolean, wasDown: boolean): number {
  const extended =
    event.code.startsWith('Arrow') ||
    [
      'ControlRight',
      'AltRight',
      'Insert',
      'Delete',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'NumpadDivide',
      'NumpadEnter',
    ].includes(event.code);
  const scanCode = WIN32_SCAN_CODES[event.code] ?? 0;
  return (
    (1 |
      (scanCode << 16) |
      (extended ? 0x0100_0000 : 0) |
      (event.altKey ? 0x2000_0000 : 0) |
      (wasDown ? 0x4000_0000 : 0) |
      (released ? 0x8000_0000 : 0)) >>>
    0
  );
}

const WIN32_SCAN_CODES: Readonly<Record<string, number>> = {
  Escape: 0x01,
  Backspace: 0x0e,
  Tab: 0x0f,
  Enter: 0x1c,
  NumpadEnter: 0x1c,
  ControlLeft: 0x1d,
  ControlRight: 0x1d,
  ShiftLeft: 0x2a,
  ShiftRight: 0x36,
  AltLeft: 0x38,
  AltRight: 0x38,
};

export function virtualKey(event: KeyLike): number {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.charCodeAt(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return 0x6f + Number(event.code.slice(1));
  const keys: Record<string, number> = {
    Backspace: 0x08,
    Tab: 0x09,
    Enter: 0x0d,
    NumpadEnter: 0x0d,
    ShiftLeft: 0x10,
    ShiftRight: 0x10,
    ControlLeft: 0x11,
    ControlRight: 0x11,
    AltLeft: 0x12,
    AltRight: 0x12,
    Pause: 0x13,
    CapsLock: 0x14,
    Escape: 0x1b,
    Space: 0x20,
    PageUp: 0x21,
    PageDown: 0x22,
    End: 0x23,
    Home: 0x24,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    PrintScreen: 0x2c,
    Insert: 0x2d,
    Delete: 0x2e,
    MetaLeft: 0x5b,
    MetaRight: 0x5c,
    ContextMenu: 0x5d,
    Numpad0: 0x60,
    Numpad1: 0x61,
    Numpad2: 0x62,
    Numpad3: 0x63,
    Numpad4: 0x64,
    Numpad5: 0x65,
    Numpad6: 0x66,
    Numpad7: 0x67,
    Numpad8: 0x68,
    Numpad9: 0x69,
    NumpadMultiply: 0x6a,
    NumpadAdd: 0x6b,
    NumpadSubtract: 0x6d,
    NumpadDecimal: 0x6e,
    NumpadDivide: 0x6f,
    NumLock: 0x90,
    ScrollLock: 0x91,
    Semicolon: 0xba,
    Equal: 0xbb,
    Comma: 0xbc,
    Minus: 0xbd,
    Period: 0xbe,
    Slash: 0xbf,
    Backquote: 0xc0,
    BracketLeft: 0xdb,
    Backslash: 0xdc,
    BracketRight: 0xdd,
    Quote: 0xde,
  };
  return keys[event.code] ?? 0;
}

/** Real Windows TranslateMessage generates WM_CHAR for these keys. */
export function win32CharacterCode(event: KeyLike): number | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key.length === 1) return event.key.charCodeAt(0);
  const controls: Record<string, number> = {
    Enter: 0x0d,
    Tab: 0x09,
    Backspace: 0x08,
    Escape: 0x1b,
  };
  return controls[event.key] ?? null;
}

/**
 * Simulate one physical keystroke with page.ts window keydown/keyup semantics:
 * down -> setKeyState + WM_KEYDOWN/SYSKEYDOWN + WM_CHAR; up -> WM_KEYUP/SYSKEYUP.
 */
export function syntheticKeyStroke(vm: KeyStrokeTarget, code: string, down: boolean): void {
  const event: KeyLike = {
    code,
    key: code === 'Space' ? ' ' : code,
    location: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  };
  const vk = virtualKey(event);
  if (!vk) return;
  const system = code === 'AltLeft' || code === 'AltRight';
  vm.setKeyState(vk, down);
  vm.postMessage(down ? (system ? 0x0104 : 0x0100) : system ? 0x0105 : 0x0101, vk, keyLParam(event, !down, !down));
  if (down) {
    const character = win32CharacterCode(event);
    if (character !== null) vm.postMessage(0x0102, character, keyLParam(event, false, false));
  }
}

export const CHEAT_TEXT_MAX_LENGTH = 128;

export type CheatTextValidation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

const CHEAT_TEXT_PATTERN = /^[A-Za-z0-9 ()]+$/;

/** Validate and normalize cheat text by trimming only outer ASCII spaces, preserving spaces within phrases. */
export function normalizeCheatText(text: string): CheatTextValidation {
  const normalized = text.replace(/^ +| +$/g, '');
  if (!normalized) return { ok: false, error: t('请输入作弊码。') };
  if (normalized.length > CHEAT_TEXT_MAX_LENGTH) {
    return { ok: false, error: t('作弊码不能超过 {0} 个字符。', CHEAT_TEXT_MAX_LENGTH) };
  }
  if (!CHEAT_TEXT_PATTERN.test(normalized)) {
    return { ok: false, error: t('只能输入英文字母、数字、空格或括号。') };
  }
  return { ok: true, text: normalized };
}

function cheatCharacterEvent(character: string): KeyLike | null {
  let code: string;
  if (/^[A-Za-z]$/.test(character)) code = `Key${character.toUpperCase()}`;
  else if (/^[0-9]$/.test(character)) code = `Digit${character}`;
  else if (character === ' ') code = 'Space';
  else if (character === '(') code = 'Digit9';
  else if (character === ')') code = 'Digit0';
  else return null;
  return { code, key: character, location: 0, altKey: false, ctrlKey: false, metaKey: false };
}

function syntheticCheatCharacterStroke(vm: KeyStrokeTarget, character: string, down: boolean): void {
  const event = cheatCharacterEvent(character);
  if (!event) throw new Error(t('无法发送字符：{0}', character));
  const vk = virtualKey(event);
  if (!vk) throw new Error(t('无法发送字符：{0}', character));
  vm.setKeyState(vk, down);
  vm.postMessage(down ? 0x0100 : 0x0101, vk, keyLParam(event, !down, !down));
  if (down) vm.postMessage(0x0102, character.charCodeAt(0), keyLParam(event, false, false));
}

function tapSyntheticKey(vm: KeyStrokeTarget, code: string): void {
  try {
    syntheticKeyStroke(vm, code, true);
  } finally {
    // Attempt key release even if the down phase throws, avoiding stuck guest key state.
    syntheticKeyStroke(vm, code, false);
  }
}

function sendNormalizedCheatText(vm: KeyStrokeTarget, text: string): void {
  for (const character of text) {
    try {
      syntheticCheatCharacterStroke(vm, character, true);
    } finally {
      syntheticCheatCharacterStroke(vm, character, false);
    }
  }
}

/** Send the original cheat-input sequence: F9 -> text -> Enter. */
export function sendCheatSequence(vm: KeyStrokeTarget, text: string): CheatTextValidation {
  const validation = normalizeCheatText(text);
  if (!validation.ok) return validation;
  tapSyntheticKey(vm, 'F9');
  sendNormalizedCheatText(vm, validation.text);
  tapSyntheticKey(vm, 'Enter');
  return validation;
}

/** Send one test-mode shortcut, such as F8, F11, H, or U. */
export function sendCheatKey(vm: KeyStrokeTarget, code: string): void {
  tapSyntheticKey(vm, code);
}
