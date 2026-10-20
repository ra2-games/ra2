import type { GuestMemory } from './win32';
import {
  HYPERCALL_EXCEPTION_EAX,
  HYPERCALL_EXCEPTION_ECX,
  HYPERCALL_EXCEPTION_EDX,
  HYPERCALL_EXCEPTION_EBX,
  HYPERCALL_EXCEPTION_EBP,
  HYPERCALL_EXCEPTION_ESI,
  HYPERCALL_EXCEPTION_EDI,
  HYPERCALL_EXCEPTION_EIP,
  HYPERCALL_EXCEPTION_ESP,
  HYPERCALL_EXCEPTION_EFLAGS,
  HYPERCALL_EXCEPTION_CS,
} from './pe';
import { GuestKernelError } from './processError';

const registers = [
  [156, HYPERCALL_EXCEPTION_EDI, 2],
  [160, HYPERCALL_EXCEPTION_ESI, 2],
  [164, HYPERCALL_EXCEPTION_EBX, 2],
  [168, HYPERCALL_EXCEPTION_EDX, 2],
  [172, HYPERCALL_EXCEPTION_ECX, 2],
  [176, HYPERCALL_EXCEPTION_EAX, 2],
  [180, HYPERCALL_EXCEPTION_EBP, 1],
  [184, HYPERCALL_EXCEPTION_EIP, 1],
  [188, HYPERCALL_EXCEPTION_CS, 1],
  [192, HYPERCALL_EXCEPTION_EFLAGS, 1],
  [196, HYPERCALL_EXCEPTION_ESP, 1],
] as const;
const read = (memory: GuestMemory, address: number) =>
  new DataView(memory.read_memory(address, 4).slice().buffer).getUint32(0, true);
const write = (memory: GuestMemory, address: number, value: number) =>
  memory.write_memory(new Uint8Array(new Uint32Array([value]).buffer), address);

/** Windows x86 CONTEXT_CONTROL/INTEGER/SEGMENTS from the actual firmware exception frame. */
export function readDebugContext(memory: GuestMemory): Uint8Array {
  const bytes = new Uint8Array(716);
  const view = new DataView(bytes.buffer);
  for (const [offset, address] of registers) view.setUint32(offset, read(memory, address), true);
  for (const [offset, value] of [
    [140, 0x10],
    [144, 0x18],
    [148, 0x10],
    [152, 0x10],
    [200, 0x10],
  ])
    view.setUint32(offset!, value!, true);
  return bytes;
}
export function writeDebugContext(memory: GuestMemory, bytes: Uint8Array, memoryBytes: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint32(0, true);
  if (flags & 1) {
    const eip = view.getUint32(184, true),
      esp = view.getUint32(196, true);
    if (
      eip >= memoryBytes ||
      esp < 12 ||
      esp > memoryBytes ||
      view.getUint32(188, true) !== 8 ||
      view.getUint32(200, true) !== 16
    )
      throw new GuestKernelError(87, 'Invalid flat x86 control context');
  }
  if (flags & 4)
    for (const [offset, value] of [
      [140, 0x10],
      [144, 0x18],
      [148, 0x10],
      [152, 0x10],
    ])
      if (view.getUint32(offset!, true) !== value) throw new GuestKernelError(50, 'Segment changes are unsupported');
  for (const [offset, address, group] of registers)
    if (flags & group) write(memory, address, view.getUint32(offset, true));
}
