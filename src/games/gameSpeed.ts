import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import { gameResolutionIni } from './resolution';

/**
 * Original scale: 0 fastest, 6 slowest. Set only startup defaults, without changing clocks or overriding the multiplayer host's speed.
 * ToolTips is initialized once by the native client, so absent installations need an explicit enabled value before the first battle.
 */
export function patchGameSpeedIni(bytes: Uint8Array, speed: number): Uint8Array {
  if (!Number.isInteger(speed) || speed < 0 || speed > 6) throw new Error('游戏速度必须为 0–6 的整数');
  let text = '';
  for (let i = 0; i < bytes.length; i += 4096) text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r\n|\n|\r/) : [];
  const result: string[] = [];
  const found = new Set<string>();
  let section = '',
    speedWritten = false,
    toolTipsPresent = false;
  const finish = () => {
    if (section === 'options') {
      if (!speedWritten) result.push(`GameSpeed=${speed}`);
      if (!toolTipsPresent) result.push('ToolTips=yes');
    } else if (section === 'skirmish' && !speedWritten) result.push(`GameSpeed=${speed}`);
  };
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      finish();
      const name = match[1]!.toLowerCase();
      section = name === 'options' || name === 'skirmish' ? name : '';
      speedWritten = false;
      toolTipsPresent = false;
      if (section) found.add(section);
    }
    if (section && /^\s*GameSpeed\s*=/i.test(line)) {
      // Remove duplicate keys in the same section so the native parser cannot read old defaults.
      if (!speedWritten) result.push(`GameSpeed=${speed}`);
      speedWritten = true;
    } else if (section === 'options' && /^\s*ToolTips\s*=/i.test(line)) {
      toolTipsPresent = true;
      result.push(line);
    } else result.push(line);
  }
  finish();
  for (const name of ['Options', 'Skirmish']) {
    if (!found.has(name.toLowerCase())) {
      result.push(`[${name}]`, `GameSpeed=${speed}`);
      if (name === 'Options') result.push('ToolTips=yes');
    }
  }
  if (result.at(-1) !== '') result.push('');
  return Uint8Array.from(result.join(newline), (c) => c.charCodeAt(0));
}

/** Shared by Workers/main thread before guest creation; like resolution/name overrides, affects only this startup and never modifies imported packages. */
export async function withGameSpeedDefault(source: GameSource): Promise<GameSource> {
  const speed = source.game.defaultGameSpeed;
  if (speed === undefined) return source;
  const path = gameResolutionIni(source.game.id);
  const original = (await source.files.read(path)) ?? new Uint8Array();
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[path, patchGameSpeedIni(original, speed)]]),
      '（内存默认游戏速度）',
      true,
    ),
  };
}
