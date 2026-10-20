import { useEffect, useState } from 'react';
import { connectControlChannel } from '../../../../platform/browser/controlConnection';
import { t } from '../../../shared/i18n/translate';
import { controlSession } from '../controlSession';
import { useStore } from '../../../shared/state/useStore';
import { controlReady } from '../state/uiState';
import { AgentCommands } from './AgentCommands';

export function AgentConnection() {
  const ready = useStore(controlReady);
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [connected, setConnected] = useState(false);
  useEffect(() => () => controlSession.disconnect(), []);
  return (
    <>
      <AgentCommands />
      <details className="agent-connection">
        <summary>{t('连接 AI')}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              controlSession.connect((request) =>
                connectControlChannel({
                  channel,
                  request,
                  status(value) {
                    const labels = {
                      connected: t('AI 已连接'),
                      'connection failed': t('AI 连接失败'),
                      disconnected: t('AI 已断开'),
                    };
                    setStatus(labels[value]);
                    setConnected(value === 'connected');
                  },
                }),
              );
              setStatus(t('正在连接 AI…'));
            } catch (error) {
              setStatus(String(error));
            }
          }}
        >
          <label>
            Channel{' '}
            <input
              aria-label={t('AI 频道')}
              value={channel}
              maxLength={64}
              pattern="[a-zA-Z0-9_-]+"
              required
              onChange={(e) => setChannel(e.target.value)}
            />
          </label>
          <button type="submit" disabled={connected || !ready}>
            {t('连接')}
          </button>
          <button
            type="button"
            onClick={() => {
              controlSession.disconnect();
              setConnected(false);
              setStatus(t('AI 已断开'));
            }}
          >
            {t('断开连接')}
          </button>
          <p role="status">{status}</p>
        </form>
      </details>
    </>
  );
}
