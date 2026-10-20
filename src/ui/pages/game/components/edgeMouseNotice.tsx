import { useRef, useState } from 'react';
import { createStore } from '../../../shared/state/store';
import { Modal } from './Modal';
import './edgeMouseNotice.css';

const SETTINGS_ADDRESS = 'edge://settings/appearance';
const SKIPPED_KEY = 'ra2-vm-edge-mouse-notice-skipped';

export function isDesktopEdge(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string }> } }).userAgentData
    ?.brands;
  return (
    !/Android|iPhone|iPad/i.test(navigator.userAgent) &&
    (navigator.userAgent.includes('Edg/') || !!brands?.some((item) => item.brand === 'Microsoft Edge'))
  );
}

/** Edge 的鼠标手势由浏览器接管；只提醒设置方式，跳过偏好保存在当前浏览器。 */
export async function showEdgeMouseNotice(force = false): Promise<void> {
  if (!isDesktopEdge()) return;
  try {
    if (!force && localStorage.getItem(SKIPPED_KEY) === '1') return;
  } catch {
    // 浏览器拒绝存储时仍允许用户阅读并关闭提示，不影响进入游戏。
  }
  if (edgeRequest.getSnapshot()) return;
  await new Promise<void>((resolve) =>
    edgeRequest.set({
      close() {
        edgeRequest.set(null);
        resolve();
      },
    }),
  );
}

export const edgeRequest = createStore<{ close(): void } | null>(null);

export function EdgeNotice({ close }: { close(): void }) {
  const address = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  return (
    <Modal open title="Edge 鼠标手势提醒" onClose={close} className="edge-mouse-notice">
      <h2>Edge 鼠标手势提醒</h2>
      <p>检测到你正在使用 Edge。如果开启了“鼠标手势”，右键点击或拖动可能导致鼠标解锁，或触发浏览器后退。</p>
      <p>请在 Edge 设置中搜索“鼠标手势”，关闭“启用鼠标手势”；也可以在手势设置的阻止列表中添加本站。</p>
      <label htmlFor="edge-mouse-settings">复制下面的地址，在新标签页的地址栏中打开：</label>
      <div className="edge-mouse-settings">
        <input
          id="edge-mouse-settings"
          ref={address}
          value={SETTINGS_ADDRESS}
          readOnly
          aria-label="Edge 设置地址"
          onClick={() => address.current?.select()}
        />
        <button
          className="toolbar-button"
          type="button"
          data-monitor-action="copy-edge-settings"
          onClick={() => {
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(SETTINGS_ADDRESS))
              .then(
                () => setStatus('已复制，请粘贴到新标签页的地址栏。'),
                () => {
                  address.current?.focus();
                  address.current?.select();
                  setStatus('请手动复制已选中的设置地址。');
                },
              );
          }}
        >
          复制设置地址
        </button>
      </div>
      <output role="status">{status}</output>
      <div className="edge-mouse-actions">
        <button
          className="toolbar-button"
          type="button"
          data-monitor-action="skip-edge-notice"
          autoFocus
          onClick={close}
        >
          本次跳过
        </button>
        <button
          className="toolbar-button"
          type="button"
          data-monitor-action="dismiss-edge-notice"
          data-remember
          onClick={() => {
            try {
              localStorage.setItem(SKIPPED_KEY, '1');
            } catch {
              // 拒绝存储也允许关闭提示。
            }
            close();
          }}
        >
          跳过，以后不再提示
        </button>
      </div>
    </Modal>
  );
}
