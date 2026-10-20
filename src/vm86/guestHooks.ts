/** x86 callback ABI: origin, EFLAGS, then PUSHAD's EDI..EAX register frame.
 * Callbacks use cdecl and return zero to execute displaced bytes, or a guest
 * continuation address. Install before executing the image, never while running.
 */
export interface GuestHook {
  address: number;
  displaced: number;
  expected: Uint8Array;
  exports: readonly string[];
}

export function buildGuestHook(base: number, hook: GuestHook, targets: readonly number[]): Uint8Array {
  if (!targets.length) throw new Error('Hook has no callbacks');
  const code: number[] = [0x60, 0x9c, 0x68];
  const word = (value: number) => code.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
  const patch = (offset: number, value: number) => {
    for (let i = 0; i < 4; i++) code[offset + i] = (value >>> (i * 8)) & 255;
  };
  word(hook.address);
  const branches: number[] = [];
  for (const target of targets) {
    code.push(0x54, 0xe8);
    word(target - (base + code.length + 4));
    code.push(0x83, 0xc4, 0x04, 0x85, 0xc0, 0x0f, 0x85);
    branches.push(code.length);
    word(0);
  }
  code.push(0xb8);
  const defaultTarget = code.length;
  word(0);
  const restore = code.length;
  // The continuation remains below ESP while registers are restored. Disable
  // interrupts until IRET consumes flags/CS/EIP atomically; a PIT interrupt
  // between POPAD and a below-stack JMP would overwrite the continuation.
  code.push(
    0xfa,
    0x89,
    0x04,
    0x24,
    0x83,
    0xc4,
    0x08,
    0x61,
    0xff,
    0x74,
    0x24,
    0xdc,
    0x6a,
    0x08,
    0xff,
    0x74,
    0x24,
    0xe0,
    0xcf,
  );
  patch(defaultTarget, base + code.length);
  for (const branch of branches) patch(branch, restore - (branch + 4));
  code.push(...hook.expected.subarray(0, hook.displaced));
  code.push(0xe9);
  word(hook.address + Math.max(5, hook.displaced) - (base + code.length + 4));
  return Uint8Array.from(code);
}
