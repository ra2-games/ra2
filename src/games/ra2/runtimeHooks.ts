import { resolveRa2Movies, resolveRa2Calibration } from './adaptivePatches';
import { resolveRa2ShortGame } from './shortGame';
import { createRa2Control } from './control';
import { createAdaptiveRuntimeHooks } from '../shared/adaptiveRuntimeHooks';
import type { GuestMemory } from '../../vm86/win32';
import type { GameRuntimeHooks } from '../runtimeHooks';
import { writeGameSpeedFlag } from '../shared/gameSpeedFlag';
import { skipStartupMovieBlock } from '../shared/startupMovieSkip';
import { createRa2FrameReader, RA2_SETTINGS_SIGNATURE } from './performance';

const STARTUP_MOVIE_BLOCK = 0x0051_263c;
const STARTUP_MOVIE_CONTINUATION = 0x0051_26f3;
const STARTUP_MOVIE_SIGNATURE = [0xe8, 0x8f, 0x6c, 0xef, 0xff] as const;
const RA2_SETTINGS_POINTER = 0x0083_9848;
const RA2_GAME_SPEED_OFFSET = 0x1108;

/** RA2 1.006 CPU benchmark loop at 0x5abf70; change sample duration and round count together. */
const CPU_CALIBRATION_ENTRY = 0x005a_bf70;
const CPU_CALIBRATION_SIGNATURE = [0x55, 0x8b, 0xec, 0x83, 0xec, 0x34, 0x53, 0x56] as const;
const CPU_CALIBRATION_CHECKS = [
  {
    address: 0x005a_bfee,
    expected: [0x3d, 0xe8, 0x03, 0x00, 0x00],
    replacement: [0x3d, 0x64, 0x00, 0x00, 0x00],
  },
  {
    address: 0x005a_c006,
    expected: [0x81, 0xfa, 0xe8, 0x03, 0x00, 0x00],
    replacement: [0x81, 0xfa, 0x64, 0x00, 0x00, 0x00],
  },
  {
    address: 0x005a_c0a9,
    expected: [0x83, 0xf8, 0x14],
    replacement: [0x83, 0xf8, 0x03],
  },
] as const;

/**
 * Native hardware detection busy-waits for at least three rounds of 1000 QPC ticks. With the VM's fixed 1000Hz QPC, CPU benchmarking alone takes over 3 seconds. Shorten samples to 100ms, retaining 50ms warmup per round; after the required three rounds, compute average frequency from accumulated QPC differences. v86 JIT/host scheduling jitter can repeatedly retry short samples, so also cap the count at three rounds. Change only this function's thresholds, preserving global clocks, game speed, and user-selected graphics detail.
 */
export function shortenRa2CpuCalibration(memory: GuestMemory): boolean {
  const matches = (bytes: Uint8Array, expected: readonly number[]): boolean =>
    bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
  if (!matches(memory.read_memory(CPU_CALIBRATION_ENTRY, CPU_CALIBRATION_SIGNATURE.length), CPU_CALIBRATION_SIGNATURE))
    return false;
  const current = CPU_CALIBRATION_CHECKS.map((check) => memory.read_memory(check.address, check.expected.length));
  if (
    !CPU_CALIBRATION_CHECKS.every(
      (check, index) => matches(current[index]!, check.expected) || matches(current[index]!, check.replacement),
    )
  )
    return false;
  for (const check of CPU_CALIBRATION_CHECKS) memory.write_memory(new Uint8Array(check.replacement), check.address);
  return true;
}

/** Accept only the original seven settings 0..6; see RA2_SETTINGS_POINTER for the Settings singleton pointer and field offset. */
export function writeRa2GameSpeed(memory: GuestMemory, value: number): number | null {
  return writeGameSpeedFlag(memory, RA2_SETTINGS_POINTER, RA2_GAME_SPEED_OFFSET, value);
}

/**
 * RA2 1.006's [Intro] Play=no controls only the first-run story introduction, not the WESTLOGO branch run on every startup. After verifying instruction signatures, skip the entire startup-movie selection block to its native cleanup. Campaign briefings still request Bink normally, then complete safely through the shim's sparse-movie compatibility policy.
 */
export function skipRa2StartupMovies(memory: GuestMemory): boolean {
  return skipStartupMovieBlock(memory, STARTUP_MOVIE_BLOCK, STARTUP_MOVIE_CONTINUATION, STARTUP_MOVIE_SIGNATURE);
}

export const RA2_RUNTIME_HOOKS: GameRuntimeHooks = Object.freeze({
  resolve(memory: GuestMemory, exe: Uint8Array): GameRuntimeHooks {
    return createAdaptiveRuntimeHooks(memory, exe, {
      label: 'RA2',
      createControl: createRa2Control,
      settingsSignature: RA2_SETTINGS_SIGNATURE,
      menuRegister: 0xbd,
      initialSendRate: 3,
      restorationFailureHint:
        '；存档对象引用恢复失败：对象数据缺失或不一致。旧版保存缺陷生成的不完整存档无法补回丢失的数据；请开始新游戏并创建新存档。',
      createFrameReader: createRa2FrameReader,
      patches: (layout) => [
        resolveRa2Movies(layout.image),
        resolveRa2Calibration(layout.image),
        resolveRa2ShortGame(layout.image, layout.settings.pointer),
      ],
    });
  },
  createFrameReader: createRa2FrameReader,
});
