/**
 * PE loading unit tests: feed a synthetic fixture PE to the real loadPe and verify header parsing, section mapping, IAT stubs, and stub code generation.
 */
import { describe, expect, it } from 'vitest';
import {
  HYPERCALL_IMPORT_ACTIVE,
  HYPERCALL_STACK,
  loadPe,
  makeConstantImportStub,
  makeFirstArgImportStub,
  makeImportStub,
  peImportKeys,
  rvaToOff,
} from '../../src/vm86/pe';
import { buildFixturePe, FIXTURE_ABI } from '../fixture/fixtureProgram';

const STUB_BASE = 0x8_0000;

function loadFixture(stubFactory?: Parameters<typeof loadPe>[4]) {
  const { built, abi } = buildFixturePe();
  const staging = new Uint8Array(8 * 1024 * 1024);
  let stubNext = STUB_BASE;
  const image = loadPe(
    staging,
    built.exe,
    (size) => {
      const address = stubNext;
      stubNext = (stubNext + size + 15) & ~15;
      return address;
    },
    (dll, name) => {
      const value = abi[`${dll.toUpperCase()}!${name}`];
      if (value === undefined) throw new Error(`未登记: ${dll}!${name}`);
      return value;
    },
    stubFactory,
  );
  return { image, staging, stubNext, built };
}

describe('buildFixturePe + loadPe', () => {
  it('装载合成 PE：入口、导入数与 ABI 一一对应', () => {
    const { image, built } = loadFixture();
    expect(image.entry).toBe(built.entry);
    expect(image.imageBase).toBe(0x0040_0000);
    expect(image.importList.length).toBe(Object.keys(FIXTURE_ABI).length);
    // IDs are consecutive from 1 (0 is reserved for no request).
    image.importList.forEach((imported, index) => {
      expect(imported.id).toBe(index + 1);
      expect(FIXTURE_ABI[imported.key]).toBe(imported.argBytes);
    });
  });

  it('IAT 槽被改写为桩地址，桩落在分配区内', () => {
    const { image, staging, stubNext } = loadFixture();
    for (const imported of image.importList) {
      const slotValue = readU32(staging, imported.slot);
      expect(slotValue).toBe(imported.stub);
      expect(imported.stub).toBeGreaterThanOrEqual(STUB_BASE);
      expect(imported.stub).toBeLessThan(stubNext);
      // Normal stubs enter the shared-page critical section with cli, publishing importActive before the call stack.
      expect(staging[imported.stub]).toBe(0xfa);
      expect(staging[imported.stub + 1]).toBe(0xc7);
      expect(staging[imported.stub + 2]).toBe(0x05);
      expect(readU32(staging, imported.stub + 3)).toBe(HYPERCALL_IMPORT_ACTIVE);
      expect(readU32(staging, imported.stub + 7)).toBe(1);
      expect(staging[imported.stub + 11]).toBe(0x89);
      expect(staging[imported.stub + 12]).toBe(0x25);
      expect(readU32(staging, imported.stub + 13)).toBe(HYPERCALL_STACK);
    }
  });

  it('peImportKeys 枚举与装载结果一致', () => {
    const { built, image } = loadFixture();
    const keys = peImportKeys(built.exe);
    expect(keys.sort()).toEqual(image.importList.map((imported) => imported.key).sort());
  });

  it('rvaToOff：头部恒等映射，section 按原始偏移换算', () => {
    const { built } = buildFixturePe();
    expect(rvaToOff(built.exe, 0x80)).toBe(0x80); // PE headers fit within sizeOfHeaders
    // .text RVA 0x1000 -> file offset sizeOfHeaders (0x200)
    expect(rvaToOff(built.exe, 0x1000)).toBe(0x200);
    expect(rvaToOff(built.exe, 0x1008)).toBe(0x208);
    expect(rvaToOff(built.exe, 0xf000_0000)).toBe(-1);
  });

  it('拒绝非 PE 与截断文件', () => {
    const staging = new Uint8Array(1024 * 1024);
    const alloc = () => STUB_BASE;
    const abi = () => 0;
    expect(() => loadPe(staging, new Uint8Array(256), alloc, abi)).toThrowError(/PE/);
    const { built } = buildFixturePe();
    const truncated = built.exe.subarray(0, 0x220); // Truncate in the middle of .text
    expect(() => loadPe(staging, truncated, alloc, abi)).toThrowError(/越界/);
  });
});

describe('makeImportStub 参数校验', () => {
  it('拒绝非法 id 与参数字节数', () => {
    expect(() => makeImportStub(0, 0)).toThrowError(/id 非法/);
    expect(() => makeImportStub(-1, 0)).toThrowError(/id 非法/);
    expect(() => makeImportStub(1, 3)).toThrowError(/参数字节数非法/);
    expect(() => makeImportStub(1, -4)).toThrowError(/参数字节数非法/);
    // Stubs include a thread-switch context frame; their length is independent of argument bytes (add esp, n uses inline imm32).
    expect(makeImportStub(1, 0).length).toBe(makeImportStub(1, 0x40).length);
  });

  it('桩尾 ret 携带 stdcall 清理字节数', () => {
    const stub = makeImportStub(7, 20);
    expect(stub[stub.length - 3]).toBe(0xc2);
    expect(stub[stub.length - 2]).toBe(20);
    expect(stub[stub.length - 1]).toBe(0);
  });
});

describe('快速桩生成', () => {
  it('常量桩返回固定 EAX 并弹参', () => {
    const stub = makeConstantImportStub(0x1234_5678, 8);
    expect([...stub]).toEqual([0xb8, 0x78, 0x56, 0x34, 0x12, 0xc2, 8, 0]);
  });
  it('首参桩把 [esp+4] 搬进 EAX', () => {
    const stub = makeFirstArgImportStub(4);
    expect([...stub.slice(0, 4)]).toEqual([0x8b, 0x44, 0x24, 0x04]);
    expect(stub[stub.length - 3]).toBe(0xc2);
  });
});

function readU32(bytes: Uint8Array, address: number): number {
  return (
    (bytes[address]! | (bytes[address + 1]! << 8) | (bytes[address + 2]! << 16) | (bytes[address + 3]! << 24)) >>> 0
  );
}
