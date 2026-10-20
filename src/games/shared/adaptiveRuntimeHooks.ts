import type { GuestMemory } from '../../vm86/win32';
import type { GameRuntimeHooks } from '../runtimeHooks';
import { resolveNativeLayout, matchesLoaded, type NativeLayoutPolicy } from './nativeLayout';
import { applyNativePatches, type NativePatchPlan } from './nativePatches';
import { writeGameSpeedFlag } from './gameSpeedFlag';
import { installStartupTrampoline } from './startupTrampoline';
import { installBattleStartup } from './battleStartup';
import { makeLanStartupTiming, lanTimingCall } from './lanStartupTiming';

export interface AdaptiveRuntimePolicy extends NativeLayoutPolicy {
  createControl?: GameRuntimeHooks['createControl'];
  label: string;
  initialSendRate: number;
  restorationFailureHint?: string;
  createFrameReader: NonNullable<GameRuntimeHooks['createFrameReader']>;
  patches: (layout: NonNullable<ReturnType<typeof resolveNativeLayout>>) => (NativePatchPlan | null)[];
}

/** One immutable resolution per VM. No shared executable mutation or process-global address cache. */
export function createAdaptiveRuntimeHooks(
  memory: GuestMemory,
  exe: Uint8Array,
  policy: AdaptiveRuntimePolicy,
): GameRuntimeHooks {
  const layout = resolveNativeLayout(memory, exe, policy);
  const plans = layout ? policy.patches(layout) : [];
  const unsupported = () => new Error(`${policy.label}：无法唯一识别原生启动入口或指令签名不匹配`);
  return {
    createControl: policy.createControl,
    createFrameReader: policy.createFrameReader,
    prepareImage(memory) {
      if (plans.some((plan) => plan && !matchesLoaded(memory, plan.evidence)))
        throw new Error(`${policy.label}：兼容补丁指令签名不匹配`);
      for (const plan of plans) {
        if (plan && !applyNativePatches(memory, plan)) throw new Error(`${policy.label}：兼容补丁指令签名不匹配`);
      }
    },
    prepareStartupPage(memory, page, reserve) {
      if (!['lan', 'skirmish', 'battle'].includes(page)) throw new Error(`${policy.label}：不支持启动页面 ${page}`);
      const menu = layout?.menu;
      if (!menu || !matchesLoaded(memory, menu.evidence)) throw unsupported();
      const navigate = (m: GuestMemory, allocate: (size: number) => number) =>
        installStartupTrampoline(m, allocate, {
          label: policy.label,
          site: menu.site,
          signature: menu.signature,
          movOperand: menu.movOperand,
          target: page === 'lan' ? 3 : 11,
        });
      if (page !== 'battle') {
        navigate(memory, reserve);
        return;
      }
      const battle = layout?.battle;
      if (!battle || !matchesLoaded(memory, battle.evidence)) throw unsupported();
      installBattleStartup(memory, reserve, {
        label: policy.label,
        site: battle.site,
        handler: battle.handler,
        navigate,
      });
    },
    writeGameSpeedFlag(memory, value) {
      const settings = layout?.settings;
      if (!settings || !matchesLoaded(memory, settings.evidence)) return null;
      return writeGameSpeedFlag(memory, settings.pointer, settings.offset, value);
    },
    prepareNetwork(memory, allocateCode) {
      const lan = layout?.lan;
      if (!lan) return false;
      if (!matchesLoaded(memory, lan.evidence)) throw new Error(`${policy.label} LAN：指令签名不匹配或重复安装`);
      const patches = lan.sites.map((site) => ({
        address: site.address,
        bytes: lanTimingCall(
          site.address,
          allocateCode(
            makeLanStartupTiming(
              layout.counters.sessionSpeed,
              layout.counters.requestedFps,
              site.bytes[0]!,
              policy.initialSendRate,
            ),
          ),
        ),
      }));
      for (const patch of patches) memory.write_memory(patch.bytes, patch.address);
      memory.write_memory([31], lan.report.address + 2);
      memory.write_memory([0xa8, 63], lan.negotiate.address + 5);
      return true;
    },
    crashHint(vector, eip) {
      if (policy.restorationFailureHint && vector === 0 && layout?.restorationFault === eip)
        return policy.restorationFailureHint;
      return vector === 0 && layout?.repair?.divide === eip ? `；${policy.label} 原生 RepairRate 除法异常` : '';
    },
  };
}
