import { expect, it } from 'vitest';
import { GUEST_SCHEDULER_TICKS } from '../../../src/vm86/pe';
import { callShim } from '../../helpers/guestMemory';
import { call32, finish, PROGRAM, push32, withGuestMachine } from '../../helpers/guestMachine';

it('refreshes an infrequently polled sound cursor after a real PIT tick', async () => {
  await withGuestMachine(async (m) => {
    const data = 0x310000;
    m.write(data, 20);
    m.write(data + 8, 882000);
    expect(callShim(m.shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, data, data + 32, 0]).eax).toBe(0);
    const object = m.read(data + 32);
    expect(callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Play', [object, 0, 0, 1]).eax).toBe(0);
    const cursor = m.read(m.read(object) + 4 * 4);
    const sleep = m.api('Sleep', 4, () => new Uint8Array([0xfb, 0xf4, 0xc2, 4, 0]));
    const query = (out: number) => [...push32(0), ...push32(out), ...push32(object), ...call32(cursor)];
    m.code(PROGRAM, [
      0xb0,
      0xef,
      0xe6,
      0x21, // Mask PIT only for the same-tick cache-hit pair; retain UART.
      ...query(data + 40),
      ...query(data + 44),
      0xb0,
      0xee,
      0xe6,
      0x21, // Restore PIT, then wait for a real interrupt without advancing clocks in the fixture.
      ...push32(30),
      ...call32(sleep),
      ...query(data + 48),
      ...finish,
    ]);
    await m.run();
    expect(m.read(GUEST_SCHEDULER_TICKS)).toBeGreaterThan(0);
    expect(m.read(data + 44)).toBe(m.read(data + 40));
    expect(m.read(data + 48)).toBeGreaterThan(m.read(data + 44));
    expect(m.calls.filter((c) => c.imported.method === 'GetCurrentPosition')).toHaveLength(2);
  });
});

it('preserves distinct play/write cursors in the x86 cache and locks from the write cursor without seeking', async () => {
  const { ProxyAudioSink } = await import('../../../src/adapter/audioProxy');
  let revision = 0;
  const audio = new ProxyAudioSink((message) => {
    if (message.type === 'audio' && message.revision !== undefined) revision = message.revision;
  });
  await withGuestMachine(
    async (m) => {
      const data = 0x310000;
      m.write(data, 20);
      m.write(data + 8, 4096);
      callShim(m.shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, data, data + 32, 0]);
      const object = m.read(data + 32);
      callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Play', [object, 0, 0, 1]);
      audio.acceptState([{ id: object, revision, positionBytes: 40, writePositionBytes: 400, playing: true }]);
      const cursor = m.read(m.read(object) + 4 * 4);
      const query = (out: number) => [...push32(out + 4), ...push32(out), ...push32(object), ...call32(cursor)];
      m.code(PROGRAM, [0xb0, 0xef, 0xe6, 0x21, ...query(data + 40), ...query(data + 48), ...finish]);
      await m.run();
      expect([m.read(data + 40), m.read(data + 44), m.read(data + 48), m.read(data + 52)]).toEqual([40, 400, 40, 400]);
      expect(m.calls.filter((c) => c.imported.method === 'GetCurrentPosition')).toHaveLength(1);
      callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Lock', [object, 0, 16, data + 56, data + 60, 0, 0, 0]);
      const base = m.read(data + 56);
      callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Lock', [object, 123, 16, data + 56, data + 60, 0, 0, 1]);
      expect(m.read(data + 56)).toBe(base + 400);
      expect(audio.getState(object)).toEqual({ positionBytes: 40, writePositionBytes: 400, playing: true });
      callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [object, data + 40, data + 44]);
      expect([m.read(data + 40), m.read(data + 44)]).toEqual([40, 400]);
    },
    { audio },
  );
});
