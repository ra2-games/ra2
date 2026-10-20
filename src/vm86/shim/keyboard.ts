/** Fixed US-layout Set-1 scan codes; do not read host keyboard layouts, keeping guest mappings stable. */
const scanToVk = new Map<number, number>([
  [0x01, 0x1b],
  [0x0e, 0x08],
  [0x0f, 0x09],
  [0x1c, 0x0d],
  [0x1d, 0xa2],
  [0x2a, 0xa0],
  [0x36, 0xa1],
  [0x38, 0xa4],
  [0x39, 0x20],
  [0x3a, 0x14],
  [0x45, 0x90],
  [0x46, 0x91],
  [0x0c, 0xbd],
  [0x0d, 0xbb],
  [0x1a, 0xdb],
  [0x1b, 0xdd],
  [0x27, 0xba],
  [0x28, 0xde],
  [0x29, 0xc0],
  [0x2b, 0xdc],
  [0x33, 0xbc],
  [0x34, 0xbe],
  [0x35, 0xbf],
  [0x37, 0x6a],
  [0x47, 0x67],
  [0x48, 0x68],
  [0x49, 0x69],
  [0x4a, 0x6d],
  [0x4b, 0x64],
  [0x4c, 0x65],
  [0x4d, 0x66],
  [0x4e, 0x6b],
  [0x4f, 0x61],
  [0x50, 0x62],
  [0x51, 0x63],
  [0x52, 0x60],
  [0x53, 0x6e],
  [0xe01c, 0x0d],
  [0xe01d, 0xa3],
  [0xe038, 0xa5],
  [0xe035, 0x6f],
  [0xe047, 0x24],
  [0xe048, 0x26],
  [0xe049, 0x21],
  [0xe04b, 0x25],
  [0xe04d, 0x27],
  [0xe04f, 0x23],
  [0xe050, 0x28],
  [0xe051, 0x22],
  [0xe052, 0x2d],
  [0xe053, 0x2e],
  [0xe037, 0x2c],
  [0xe05b, 0x5b],
  [0xe05c, 0x5c],
  [0xe05d, 0x5d],
]);
for (const [start, keys] of [
  [0x02, '1234567890'],
  [0x10, 'QWERTYUIOP'],
  [0x1e, 'ASDFGHJKL'],
  [0x2c, 'ZXCVBNM'],
] as const) {
  [...keys].forEach((key, index) => scanToVk.set(start + index, key.charCodeAt(0)));
}
for (let i = 0; i < 10; i++) scanToVk.set(0x3b + i, 0x70 + i);
scanToVk.set(0x57, 0x7a);
scanToVk.set(0x58, 0x7b);
const vkToScan = new Map<number, number>();
for (const [scan, vk] of scanToVk) if (!vkToScan.has(vk)) vkToScan.set(vk, scan);
const punctuation: Readonly<Record<number, string>> = {
  0xba: ';',
  0xbb: '=',
  0xbc: ',',
  0xbd: '-',
  0xbe: '.',
  0xbf: '/',
  0xc0: '`',
  0xdb: '[',
  0xdc: '\\',
  0xdd: ']',
  0xde: "'",
  0x6a: '*',
  0x6b: '+',
  0x6d: '-',
  0x6e: '.',
  0x6f: '/',
};

const scanKeyNames: Readonly<Record<number, string>> = {
  0x01: 'Escape',
  0x0e: 'Backspace',
  0x0f: 'Tab',
  0x1c: 'Enter',
  0x1d: 'Ctrl',
  0x2a: 'Shift',
  0x36: 'Right Shift',
  0x38: 'Alt',
  0x39: 'Space',
  0x3a: 'Caps Lock',
  0x45: 'Num Lock',
  0x46: 'Scroll Lock',
  0x37: 'Num *',
  0x47: 'Num 7',
  0x48: 'Num 8',
  0x49: 'Num 9',
  0x4a: 'Num -',
  0x4b: 'Num 4',
  0x4c: 'Num 5',
  0x4d: 'Num 6',
  0x4e: 'Num +',
  0x4f: 'Num 1',
  0x50: 'Num 2',
  0x51: 'Num 3',
  0x52: 'Num 0',
  0x53: 'Num Del',
  0x57: 'F11',
  0x58: 'F12',
  0xe01c: 'Num Enter',
  0xe01d: 'Right Ctrl',
  0xe035: 'Num /',
  0xe037: 'Print Screen',
  0xe038: 'Right Alt',
  0xe047: 'Home',
  0xe048: 'Up',
  0xe049: 'Page Up',
  0xe04b: 'Left',
  0xe04d: 'Right',
  0xe04f: 'End',
  0xe050: 'Down',
  0xe051: 'Page Down',
  0xe052: 'Insert',
  0xe053: 'Delete',
  0xe05b: 'Left Windows',
  0xe05c: 'Right Windows',
  0xe05d: 'Applications',
};

/**
 * GetKeyNameTextA receives a keyboard lParam, where bits 16–23 contain a Set-1 scan code and bit 24 marks E0 keys.
 * Names remain US-layout identifiers so the guest's key bindings do not depend on the browser or host OS locale.
 */
export function keyNameText(lParam: number): string {
  const scan = (lParam >>> 16) & 0xff;
  const extended = (lParam & 0x0100_0000) !== 0;
  const code = extended ? 0xe000 | scan : scan;
  const named = scanKeyNames[code];
  if (named) return named;
  const vk = scanToVk.get(code) ?? 0;
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  if (vk >= 0x70 && vk <= 0x7b) return `F${vk - 0x6f}`;
  return punctuation[vk] ?? '';
}

/**
 * MapVirtualKey directions are distinct. RA2 battlefield shortcuts call it; return Win32's 0 for unknown keys.
 * Semantics: Microsoft Win32 documentation, MapVirtualKeyA.
 */
export function mapVirtualKey(code: number, type: number): number {
  if (type === 0 || type === 4) {
    const left = code === 0x10 ? 0xa0 : code === 0x11 ? 0xa2 : code === 0x12 ? 0xa4 : code;
    const scan = vkToScan.get(left) ?? 0;
    return type === 0 ? scan & 0xff : scan;
  }
  if (type === 1 || type === 3) {
    const vk = scanToVk.get(code) ?? 0;
    if (type === 3) return vk;
    return vk === 0xa0 || vk === 0xa1
      ? 0x10
      : vk === 0xa2 || vk === 0xa3
        ? 0x11
        : vk === 0xa4 || vk === 0xa5
          ? 0x12
          : vk;
  }
  if (type === 2) {
    if (
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      [0x08, 0x09, 0x0d, 0x1b, 0x20].includes(code)
    )
      return code;
    if (code >= 0x60 && code <= 0x69) return code - 0x60 + 0x30;
    return punctuation[code]?.charCodeAt(0) ?? 0;
  }
  return 0;
}

/**
 * US-layout ToAscii subset: Shift/CapsLock determines case; Ctrl generates control characters.
 * No dead keys; noncharacter function keys return no result, never virtual key codes masquerading as ASCII.
 */
export function toAscii(code: number, scan: number, state: Uint8Array): number[] {
  if (scan & 0x8000) return [];
  const shift = ((state[0x10] ?? 0) & 0x80) !== 0;
  const control = ((state[0x11] ?? 0) & 0x80) !== 0;
  const caps = ((state[0x14] ?? 0) & 1) !== 0;
  let char = mapVirtualKey(code, 2);
  if (!char) return [];
  if (control) {
    if (code >= 0x41 && code <= 0x5a) return [code - 0x40];
    if ([0xdb, 0xdc, 0xdd].includes(code)) return [char - 0x40];
    return [];
  }
  if (code >= 0x41 && code <= 0x5a) char += shift !== caps ? 0 : 32;
  else if (shift) {
    const plain = "1234567890-=[]\\;'`,./";
    const shifted = '!@#$%^&*()_+{}|:"~<>?';
    const index = plain.indexOf(String.fromCharCode(char));
    if (index >= 0 && !(code >= 0x60 && code <= 0x6f)) char = shifted.charCodeAt(index);
  }
  return [char];
}
