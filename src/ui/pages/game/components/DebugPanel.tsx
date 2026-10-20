import { t, localizeLabel, localizeText } from '../../../shared/i18n/translate';
import { useLayoutEffect, useRef, useState } from 'react';
import type { VmShell } from '../../../../adapter/runtime';

export function DebugPanel({
  title,
  phase,
  calls,
  performance,
  detail,
  hot,
  trace,
  getVm,
}: {
  title: string;
  phase: string;
  calls: number;
  performance: string;
  detail: string;
  hot: Array<[string, number]>;
  trace: string;
  getVm(): VmShell | null;
}) {
  const [tab, setTab] = useState('state'),
    [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false);
  const [recordStatus, setRecordStatus] = useState(t('未录制')),
    [result, setResult] = useState('');
  const started = useRef(0),
    log = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [trace]);
  const record = async (stop: boolean) => {
    const vm = getVm();
    if (!vm) {
      setRecordStatus(t('VM 未启动'));
      return;
    }
    setBusy(true);
    try {
      if (!stop) {
        const ok = await vm.startMemRecord();
        setRecording(ok);
        started.current = Date.now();
        setRecordStatus(ok ? t('录制中…') : t('启动失败'));
        setResult('');
      } else {
        const value = await vm.stopMemRecord();
        setRecording(false);
        if (!value) {
          setRecordStatus(t('未在录制'));
          return;
        }
        setRecordStatus(
          t(
            '已录制 {0}s · 采样 {1} 次 · 改动 {2} 段 / {3} 字节{4}',
            ((Date.now() - started.current) / 1000).toFixed(1),
            value.samples,
            value.rangeCount,
            value.totalBytes.toLocaleString(),
            value.truncated ? t(' · 计数已截断') : '',
          ),
        );
        setResult(
          value.counts
            .slice(0, 200)
            .map(({ address, count }) => `0x${address.toString(16).padStart(8, '0')} ×${count}`)
            .join('\n') || t('无改动'),
        );
      }
    } catch (error) {
      setRecordStatus(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel mono">
      <h3>
        {localizeLabel(title)} {t('· 调试（` 收起）')}
      </h3>
      <div className="vm-debug-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'state'} onClick={() => setTab('state')}>
          {t('游戏状态')}{' '}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'trace'} onClick={() => setTab('trace')}>
          Call Trace
        </button>
      </div>
      <div className="vm-debug-summary vm-debug-pane" role="tabpanel" hidden={tab !== 'state'}>
        <section className="vm-debug-section">
          <h4>{t('运行状态')}</h4>
          <table>
            <tbody>
              {[
                [t('阶段'), phase],
                ['Hypercall', t('{0} 次', calls.toLocaleString())],
                [t('性能'), performance],
                [t('详情'), localizeText(detail)],
              ].map(([name, value]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="vm-debug-section">
          <h4>{t('内存改动录制')}</h4>
          <button type="button" disabled={busy || recording} onClick={() => void record(false)}>
            {t('开始录制')}{' '}
          </button>
          <button type="button" disabled={busy || !recording} onClick={() => void record(true)}>
            {t('结束录制')}{' '}
          </button>
          <span>{localizeText(recordStatus)}</span>
          <pre>{result}</pre>
        </section>
      </div>
      <div className="vm-debug-trace vm-debug-pane" role="tabpanel" hidden={tab !== 'trace'}>
        <section className="vm-debug-section">
          <h4>{t('调用热点')}</h4>
          <table>
            <tbody>
              {hot.length ? (
                hot.map(([key, count]) => (
                  <tr key={key}>
                    <th scope="row" title={key}>
                      {key.split('!')[1] ?? key}
                    </th>
                    <td>{count.toLocaleString()}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2}>{t('暂无采样')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <pre ref={log} className="vm-debug-log">
          {localizeText(trace) || t('等待原版主程序进入点…')}
        </pre>
      </div>
    </section>
  );
}
