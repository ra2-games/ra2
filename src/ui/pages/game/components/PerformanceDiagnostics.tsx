import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, localizeText } from '../../../shared/i18n/translate';
import type { RuntimeToolbarCallbacks } from '../runtimeToolbar';
import { Modal } from './Modal';
import './PerformanceDiagnostics.css';

export function PerformanceDiagnostics({
  collect,
  available,
}: {
  collect: NonNullable<RuntimeToolbarCallbacks['onCollectPerformance']>;
  available: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [report, setReport] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setRemaining(null);
    setReport('');
    setNotice('');
    setOpen(false);
    return () => {
      const controller = active.current;
      active.current = null;
      controller?.abort();
    };
  }, [collect]);
  useEffect(() => {
    if (!available) active.current?.abort();
  }, [available]);

  const start = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setNotice('');
    setReport('');
    setRemaining(20);
    setOpen(false);
    try {
      const result = await collect(controller.signal, (seconds) => {
        if (active.current === controller) setRemaining(seconds);
      });
      if (active.current === controller) setReport(result);
    } catch (error) {
      if (active.current === controller)
        setNotice(localizeText(error instanceof Error ? error.message : String(error)));
    } finally {
      if (active.current === controller) {
        active.current = null;
        setRemaining(null);
        setOpen(true);
      }
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setNotice(t('报告已复制'));
    } catch {
      text.current?.focus();
      text.current?.select();
      setNotice(t('无法自动复制，请长按报告文字选择并复制。'));
    }
  };

  return (
    <>
      <button
        id="vm-performance-diagnostics"
        className="toolbar-button"
        type="button"
        disabled={!available && !report && remaining === null}
        onClick={() => setOpen(true)}
      >
        {remaining === null ? t('性能诊断…') : t('采样中 · {0}s', remaining)}
      </button>
      {createPortal(
        <Modal
          open={open}
          title={t('性能诊断')}
          onClose={() => setOpen(false)}
          className="performance-diagnostics message-box"
        >
          <header>
            <h2>{t('性能诊断')}</h2>
            <button
              className="toolbar-button"
              type="button"
              data-monitor-action="close-performance-diagnostics"
              onClick={() => setOpen(false)}
            >
              {t('关闭')}
            </button>
          </header>
          <p>
            {t(
              '进入对局后开始采样，保持前台并正常操作 20 秒。请在两个浏览器使用相同地图、游戏速度、分辨率和画质设置。',
            )}
          </p>
          <p>{t('采样结束后复制报告发回。报告包含浏览器、运行模式和性能数据，不包含存档或游戏资源。')}</p>
          <div className="performance-diagnostics-actions">
            <button
              className="toolbar-button"
              type="button"
              data-monitor-action="start-performance-diagnostics"
              disabled={!available || remaining !== null}
              onClick={() => void start()}
            >
              {t('开始 20 秒采样')}
            </button>
            {remaining !== null && (
              <button
                className="toolbar-button"
                type="button"
                data-monitor-action="stop-performance-diagnostics"
                onClick={() => active.current?.abort()}
              >
                {t('停止采样')}
              </button>
            )}
            {report && (
              <button
                className="toolbar-button"
                type="button"
                data-monitor-action="copy-performance-report"
                onClick={() => void copy()}
              >
                {t('复制报告')}
              </button>
            )}
          </div>
          {remaining !== null && <p role="status">{t('采样中 · {0}s', remaining)}</p>}
          {notice && <p role="status">{notice}</p>}
          {report && <textarea ref={text} aria-label={t('性能诊断报告')} readOnly value={report} spellCheck={false} />}
        </Modal>,
        document.body,
      )}
    </>
  );
}
