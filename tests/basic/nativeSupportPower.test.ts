import { describe, expect, it } from 'vitest';
import { nativeSupportPowers } from '../../src/games/shared/nativeSupportPower';
import { RA2_CONTROL_PROFILE } from '../../src/games/ra2/control';
import { YR_CONTROL_PROFILE } from '../../src/games/yr/control';
import { createGuestMemory, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

describe.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])('$game local support powers', (profile) => {
  const layout = profile.supportPowers!;
  function fixture() {
    const memory = createGuestMemory();
    const house = 0x100000,
      data = 0x110000,
      object = 0x120000,
      type = 0x130000;
    writeU32(memory, house + layout.houseVector + 4, data);
    writeU32(memory, house + layout.houseVector + 16, 1);
    writeU32(memory, data, object);
    writeU32(memory, object + layout.typeOffset, type);
    writeAsciiZ(memory, type + 0x24, 'AmericanParaDropSpecial');
    writeU32(memory, type + layout.targetAction, 41);
    writeU32(memory, profile.sidebar.instance + layout.selectedIndex, 0xffffffff);
    const cameo = { strip: 1, index: 0, rtti: 31, typeIndex: 0, tab: 1 };
    const read = (cameos = [cameo]) =>
      nativeSupportPowers(memory, layout, house, profile.sidebar.instance, cameos, (address) => {
        if (address < 0x10000 || address % 4 || address >= memory.bytes.length) throw new Error('Invalid pointer');
        return address;
      });
    return { memory, house, object, type, cameo, read };
  }
  it('only lists local sidebar powers and reports native cooldown/hold readiness', () => {
    const { memory, object, read, cameo } = fixture();
    expect(read([]).available).toEqual([]);
    expect(read([{ ...cameo, rtti: 32 }]).available).toEqual([]);
    expect(read().selected).toBeNull();
    expect(read().available[0]).toMatchObject({ type: 'AmericanParaDropSpecial', ready: false, requiresTarget: true });
    memory.write_memory([1], object + layout.charged);
    expect(read().available[0]!.ready).toBe(true);
    memory.write_memory([1], object + layout.onHold);
    expect(read().available[0]!.ready).toBe(false);
  });
  it('uses charge-drain state and preserves native follow-up targeting without adding a cameo', () => {
    const { memory, object, type, read } = fixture();
    memory.write_memory([1], type + layout.chargeDrainTypeFlag);
    memory.write_memory([1], object + layout.charged);
    expect(read().available[0]!.ready).toBe(false);
    writeU32(memory, object + layout.chargeDrainState, 2);
    writeU32(memory, profile.sidebar.instance + layout.selectedIndex, 0);
    expect(read([])).toMatchObject({ available: [], selected: { type: 'AmericanParaDropSpecial', ready: true } });
  });
  it('rejects corrupt vectors and stale cameo indexes rather than exposing another object', () => {
    const { memory, house, read, cameo } = fixture();
    expect(() => read([{ ...cameo, typeIndex: 1 }])).toThrow('invalid index');
    writeU32(memory, house + layout.houseVector + 16, 8193);
    expect(() => read()).toThrow('count');
  });
});
