import { t } from '../../shared/i18n/translate';
import type { VmNetworkStatus } from '../../../vm86/win32';
import { RA2NET_MAX_LAN_MEMBERS } from '../../../games/ra2/networkWire';

/** Status text must not describe relay RTT as opponent latency or promise automatic native-game recovery. */
export function formatNetworkStatus(status: VmNetworkStatus): string {
  if (status.phase === 'connecting') return t('联机：正在连接中继…');
  if (status.phase === 'disconnected' && status.detail === 'closed') return t('联机：已关闭');
  if (status.phase === 'connected') {
    return (
      t('联机：已连接 · 其他成员 {0}', status.peers) +
      (status.relayRttMs === undefined ? '' : t(' · 中继 RTT {0} ms', status.relayRttMs))
    );
  }
  const reasons: Record<string, string> = {
    'handshake timeout': t('中继握手超时'),
    'hello timeout': t('中继握手超时'),
    'version mismatch': t('游戏版本不一致'),
    'room full': t('虚拟 LAN 已满（最多 {0} 人）', RA2NET_MAX_LAN_MEMBERS),
    'slow consumer': t('发送积压超过上限'),
    'relay closing': t('中继正在关闭'),
    'rate limit exceeded': t('发送频率超过限制'),
    'code=1006': t('网络异常断开'),
    closed: t('连接已关闭'),
    'relay draining': t('中继维护中，暂不接纳新玩家'),
    'relay busy': t('中继连接数已达上限'),
  };
  return t('联机不可用：{0}。当前不支持断线续局，请退出对局后重新启动游戏。', reasons[status.detail] ?? status.detail);
}
