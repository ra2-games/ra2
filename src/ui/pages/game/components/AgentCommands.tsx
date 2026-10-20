import { useStore } from '../../../shared/state/useStore';
import { t } from '../../../shared/i18n/translate';
import { controlJournal } from '../controlSession';
import type { CommandEntry } from '../state/controlJournal';

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    'ui.quickStart': t('快速开始'),
    'exit-battle': t('退出战斗'),
    'select-power': t('选择支援能力'),
    'target-power': t('指定支援目标'),
    produce: t('生产'),
    place: t('放置建筑'),
    camera: t('移动镜头'),
    move: t('移动'),
    attack: t('攻击'),
    'attack-move': t('攻击移动'),
    stop: t('停止'),
    guard: t('警戒'),
    deploy: t('部署'),
    scatter: t('散开'),
    repair: t('维修'),
    sell: t('出售'),
    suspend: t('暂停生产'),
    cancel: t('取消生产'),
  };
  return labels[action] ?? action;
}

function stateLabel(state: string, action: string) {
  if (action === 'select-power' && state === 'submitted') return t('侧栏操作已提交');
  if (action === 'camera' && state === 'submitted') return t('镜头已移动');
  if (action === 'ui.quickStart' && state === 'submitted') return t('已请求启动');
  const labels: Record<string, string> = {
    receiving: t('正在下令'),
    pending: t('等待游戏处理'),
    submitted: t('已进入游戏队列'),
    rejected: t('游戏未接受'),
    failed: t('下令失败'),
    expired: t('指令已过期'),
    'queue-full': t('游戏队列已满'),
    unknown: t('结果待确认'),
  };
  return labels[state] ?? t('结果待确认');
}

function description(entry: CommandEntry) {
  return [
    actionLabel(entry.action),
    entry.type,
    entry.unit && `#${entry.unit}`,
    entry.unitCount > 0 && t('{0} 个单位', entry.unitCount),
    entry.target && `→ #${entry.target}`,
    entry.cell && `(${entry.cell})`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function AgentCommands() {
  const entries = useStore(controlJournal);
  if (!entries.length) return null;
  const latest = entries[0]!;
  return (
    <details className="agent-commands">
      <summary>
        {t('AI 指令')} · {description(latest)} · {stateLabel(latest.state, latest.action)}
      </summary>
      <p>{t('显示最近 50 条指令。入队不代表执行完成，实际效果以战场为准。')}</p>
      <ol aria-label={t('AI 指令记录')}>
        {entries.map((entry) => (
          <li key={entry.key} data-command-id={entry.commandId} data-state={entry.state}>
            <time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleTimeString()}</time>{' '}
            <strong>{description(entry)}</strong>
            <span>{stateLabel(entry.state, entry.action)}</span>
            {entry.error && <small>{entry.error}</small>}
          </li>
        ))}
      </ol>
    </details>
  );
}
