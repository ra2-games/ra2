import { expect, it } from 'vitest';
import { withGuestMachine, PROGRAM, DONE, store32, le32, finish } from '../../helpers/guestMachine';
import { HYPERCALL_EXCEPTION, HYPERCALL_EXCEPTION_EIP, HYPERCALL_EXCEPTION_EFLAGS } from '../../../src/vm86/pe';
import { readDebugContext, writeDebugContext } from '../../../src/vm86/debugContext';

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
const counter = DONE + 4;
const enableTrap = [0x9c, 0x81, 0x0c, 0x24, ...le32(0x100), 0x9d];
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Firmware debugger test timed out');
    await delay();
  }
}
it('executes one real instruction with TF and restores its exception frame after debugger continuation', async () => {
  await withGuestMachine(async (m) => {
    const instruction = [0xff, 0x05, ...le32(counter)];
    m.code(PROGRAM, [...enableTrap, ...instruction, ...instruction, ...finish]);
    await m.memory.run();
    await waitFor(() => m.read(HYPERCALL_EXCEPTION) !== 0);
    await m.memory.stop();
    expect(m.read(HYPERCALL_EXCEPTION)).toBe(2);
    expect(m.read(counter)).toBe(1);
    expect(m.read(HYPERCALL_EXCEPTION_EIP)).toBe(PROGRAM + enableTrap.length + instruction.length);
    const context = readDebugContext(m.memory),
      view = new DataView(context.buffer);
    view.setUint32(0, 0x10001, true);
    view.setUint32(192, view.getUint32(192, true) & ~0x100, true);
    writeDebugContext(m.memory, context, 32 * 1024 * 1024);
    m.write(HYPERCALL_EXCEPTION, 0);
    m.memory.serial0_send('\0');
    await m.memory.run();
    await waitFor(() => !!m.read(DONE));
    expect(m.read(counter)).toBe(2);
    expect(m.read(HYPERCALL_EXCEPTION)).toBe(0);
  });
});
it('reports the actual branch target when single-stepping a jump', async () => {
  await withGuestMachine(async (m) => {
    const branch = PROGRAM + enableTrap.length + 2 + 10;
    m.code(PROGRAM, [...enableTrap, 0xeb, 10, ...store32(counter, 99), ...finish]);
    await m.memory.run();
    await waitFor(() => m.read(HYPERCALL_EXCEPTION) !== 0);
    await m.memory.stop();
    expect(m.read(HYPERCALL_EXCEPTION)).toBe(2);
    expect(m.read(HYPERCALL_EXCEPTION_EIP)).toBe(branch);
    expect(m.read(counter)).toBe(0);
  });
});
it('preserves a real instruction fault instead of replacing it with successful single-step execution', async () => {
  await withGuestMachine(async (m) => {
    m.code(PROGRAM, [...enableTrap, 0x0f, 0x0b, ...finish]);
    await m.memory.run();
    await waitFor(() => m.read(HYPERCALL_EXCEPTION) !== 0);
    await m.memory.stop();
    expect(m.read(HYPERCALL_EXCEPTION)).toBe(7);
    expect(m.read(HYPERCALL_EXCEPTION_EIP)).toBe(PROGRAM + enableTrap.length);
    expect(m.read(HYPERCALL_EXCEPTION_EFLAGS) & 0x100).toBe(0x100);
    expect(m.read(DONE)).toBe(0);
  });
});

it('restores TF through an interrupt without stepping the firmware return instruction', async () => {
  await withGuestMachine(async (m) => {
    const instruction = [0xff, 0x05, ...le32(counter)];
    m.code(PROGRAM, [...enableTrap, 0xcd, 0x20, ...instruction, ...finish]);
    await m.memory.run();
    await waitFor(() => m.read(HYPERCALL_EXCEPTION) !== 0);
    await m.memory.stop();
    expect(m.read(HYPERCALL_EXCEPTION)).toBe(2);
    expect(m.read(counter)).toBe(1);
    expect(m.read(HYPERCALL_EXCEPTION_EIP)).toBe(PROGRAM + enableTrap.length + 2 + instruction.length);
  });
});

it('keeps temporary native data below ESP intact across a real hardware timer interrupt', async () => {
  await withGuestMachine(async (m) => {
    m.code(PROGRAM, [
      0xc7,
      0x44,
      0x24,
      0xfc,
      ...le32(0x12345678),
      0xc7,
      0x44,
      0x24,
      0xd8,
      ...le32(0x76543210),
      0xfb,
      0xf4,
      0xfa, // Wait for an actual PIT IRQ; no synthetic timer or input.
      0x8b,
      0x44,
      0x24,
      0xfc,
      0xa3,
      ...le32(counter),
      0x8b,
      0x44,
      0x24,
      0xd8,
      0xa3,
      ...le32(counter + 4),
      ...finish,
    ]);
    await m.run();
    expect(m.read(counter)).toBe(0x12345678);
    expect(m.read(counter + 4)).toBe(0x76543210);
  });
});
