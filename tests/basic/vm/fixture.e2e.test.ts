/**
 * Synthetic PE end-to-end smoke tests protect core regressions in CI without original game assets: PE loading, hypercall handshake, heap/virtual memory, file reads, critical sections, WndProc callback trampolines (synchronous SendMessage and GetMessage/DispatchMessage pump), Sleep suspend/wake, and ExitProcess exit codes.
 *
 * The guest calls ExitProcess with the checkpoint number on failure; a nonzero exit code identifies the failed step.
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_ABI } from '../../fixture/fixtureProgram';
import { runFixture, type FixtureMode } from '../../fixture/runFixture';

/** Imports that must perform real hypercalls in both modes (_lread/critical sections use guest stubs in fast mode). */
const COMMON_EXPECTED_CALLS = [
  'KERNEL32.DLL!GetVersion',
  'KERNEL32.DLL!GetCommandLineA',
  'KERNEL32.DLL!lstrlenA',
  'KERNEL32.DLL!HeapCreate',
  'KERNEL32.DLL!HeapAlloc',
  'KERNEL32.DLL!HeapFree',
  'KERNEL32.DLL!VirtualAlloc',
  'KERNEL32.DLL!VirtualFree',
  'KERNEL32.DLL!_lopen',
  'KERNEL32.DLL!_llseek',
  'KERNEL32.DLL!_lclose',
  'KERNEL32.DLL!CreateFileA',
  'KERNEL32.DLL!DeleteCriticalSection',
  'KERNEL32.DLL!Sleep',
  'KERNEL32.DLL!ExitProcess',
  'USER32.DLL!RegisterClassA',
  'USER32.DLL!CreateWindowExA',
  'USER32.DLL!SendMessageA',
  'USER32.DLL!PostMessageA',
  'USER32.DLL!PostQuitMessage',
  'USER32.DLL!GetMessageA',
  'USER32.DLL!DispatchMessageA',
  'USER32.DLL!DefWindowProcA',
];
/** Imports handled by guest fast stubs without hypercalls in fast mode. */
const FAST_PATH_CALLS = [
  'KERNEL32.DLL!_lread',
  'KERNEL32.DLL!InitializeCriticalSection',
  'KERNEL32.DLL!EnterCriticalSection',
  'KERNEL32.DLL!LeaveCriticalSection',
  // Since RA2, GetLastError/SetLastError access the shared page directly in fast mode, bypassing the host.
  'KERNEL32.DLL!GetLastError',
];

describe.each(['slow', 'fast'] as FixtureMode[])('fixture PE 端到端（%s 模式）', (mode) => {
  it('全部检查点通过，ExitProcess(0)', async () => {
    const result = await runFixture(mode);
    // A nonzero exit code identifies the failed guest self-check step (see the list at the top of fixtureProgram.ts).
    expect(result.exitCode).toBe(0);
    expect(result.firstCall).toBe('KERNEL32.DLL!GetVersion');

    for (const key of COMMON_EXPECTED_CALLS) {
      expect(result.callCounts.get(key) ?? 0, `缺少 hypercall: ${key}`).toBeGreaterThanOrEqual(1);
    }
    // Message-pump round trips match exactly: 3x WM_USER + WM_QUIT.
    expect(result.callCounts.get('USER32.DLL!GetMessageA')).toBe(4);
    expect(result.callCounts.get('USER32.DLL!DispatchMessageA')).toBe(3);
    expect(result.callCounts.get('USER32.DLL!PostMessageA')).toBe(3);
    expect(result.callCounts.get('USER32.DLL!SendMessageA')).toBe(2);

    if (mode === 'slow') {
      // In slow mode, all imports cross the host; fast-path imports must also appear the expected number of times.
      expect(result.callCounts.get('KERNEL32.DLL!_lread')).toBe(2);
      for (const key of FAST_PATH_CALLS.slice(1)) {
        expect(result.callCounts.get(key) ?? 0, `缺少 hypercall: ${key}`).toBeGreaterThanOrEqual(1);
      }
      expect(result.callCounts.get('KERNEL32.DLL!EnterCriticalSection')).toBe(2);
      expect(result.callCounts.get('KERNEL32.DLL!LeaveCriticalSection')).toBe(2);
    } else {
      // Fast mode: _lread and uncontended critical-section Enter/Leave complete inside the guest.
      for (const key of FAST_PATH_CALLS) {
        expect(result.callCounts.get(key) ?? 0, `${key} 不应产生 hypercall`).toBe(0);
      }
    }
    // Coverage completeness: every fixture ABI import is either called or handled by a fast stub.
    for (const key of Object.keys(FIXTURE_ABI)) {
      const called = (result.callCounts.get(key) ?? 0) > 0;
      const fastPathed = mode === 'fast' && FAST_PATH_CALLS.includes(key);
      expect(called || fastPathed, `fixture 未覆盖导入: ${key}`).toBe(true);
    }
  }, 60_000);
});
