import { t, localizeText } from '../../../shared/i18n/translate';
import { useEffect, useRef, useState } from 'react';
import type { SupportedGameId } from '../../../../games/catalog';
import { loadCustomMapFiles, saveCustomMapFiles } from '../../../../adapter/cachedGameFiles';
import { readCustomMapPackage } from '../../../../adapter/customMapPackage';
import { Modal } from './Modal';

export function CustomMapDialog({
  gameId,
  applyLive,
  finish,
}: {
  gameId: SupportedGameId;
  applyLive?: (files: ReadonlyMap<string, Uint8Array>) => Promise<string>;
  finish(changed: boolean): void;
}) {
  const [files, setFiles] = useState(new Map<string, Uint8Array>());
  const [busy, setBusy] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [status, setStatus] = useState(t('正在读取已保存的地图…'));
  const [applied, setApplied] = useState(false);
  const alive = useRef(true);
  const fail = (error: unknown) => {
    if (alive.current) setStatus(error instanceof Error ? error.message : String(error));
  };
  useEffect(() => {
    alive.current = true;
    void loadCustomMapFiles(gameId)
      .then(
        (value) => {
          if (alive.current) {
            setFiles(value);
            setStatus('');
          }
        },
        (error) => {
          if (alive.current) {
            setReadFailed(true);
            fail(error);
          }
        },
      )
      .finally(() => {
        if (alive.current) setBusy(false);
      });
    return () => {
      alive.current = false;
    };
  }, [gameId]);
  const importFiles = async (archives: File[]) => {
    if (!archives.length || busy) return;
    setBusy(true);
    try {
      const staged = new Map(files);
      const replaced = new Set<string>();
      for (const archive of archives) {
        setStatus(t('正在读取 {0}…', archive.name));
        const extracted = await readCustomMapPackage(new Uint8Array(await archive.arrayBuffer()), (message) => {
          if (alive.current) setStatus(message);
        });
        if (!alive.current) return;
        for (const [name, bytes] of extracted) {
          if (staged.has(name)) replaced.add(name);
          staged.set(name, bytes);
        }
      }
      if (replaced.size && !window.confirm(t('将覆盖已添加的同名文件：\n{0}\n是否继续？', [...replaced].join('\n'))))
        return;
      setFiles(staged);
      setStatus(t('已暂存 {0} 个文件，点击应用后生效。', staged.size));
    } catch (error) {
      fail(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const apply = async () => {
    if (busy || readFailed) return;
    setBusy(true);
    try {
      await saveCustomMapFiles(gameId, files);
      if (!alive.current) return;
      if (!applyLive) {
        finish(true);
        return;
      }
      try {
        setStatus(await applyLive(files));
        setApplied(true);
      } catch (error) {
        throw new Error(t('文件已保存，但动态挂载失败：{0}', error instanceof Error ? error.message : String(error)));
      }
    } catch (error) {
      fail(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal open title={t('自定义地图包')} className="custom-map-dialog" busy={busy} onClose={() => finish(false)}>
      <h3>
        {t('自定义地图包 ·')} {gameId.toUpperCase()}
      </h3>
      <p>
        {t(
          '探索压缩包及嵌套归档，挂载 .yrm 和 .mpr；.csf 仅保存，暂不挂载。保留地图扩展名，不转换地图版本。应用后每次启动自动加载。',
        )}{' '}
        {applyLive && t('本次仅动态新增文件，不重启 VM、不刷新地图列表；同名替换和移除下次启动生效。')}
      </p>
      <input
        type="file"
        accept=".zip,.7z,.rar"
        multiple
        aria-label={t('添加自定义地图压缩包')}
        disabled={busy || readFailed}
        onChange={(event) => {
          const archives = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          void importFiles(archives);
        }}
      />
      <ul>
        {[...files].map(([name, bytes]) => (
          <li key={name}>
            {name}（{bytes.length} B）{name.endsWith('.csf') ? t('〔暂不挂载〕') : ''}{' '}
            <button
              type="button"
              data-monitor-action="remove-custom-map"
              disabled={busy}
              aria-label={t('移除 {0}', name)}
              onClick={() =>
                setFiles((previous) => {
                  const next = new Map(previous);
                  next.delete(name);
                  return next;
                })
              }
            >
              {t('移除')}{' '}
            </button>
          </li>
        ))}
      </ul>
      <p role="status">{localizeText(status)}</p>
      <button
        type="button"
        data-monitor-action="apply-custom-map"
        disabled={busy || readFailed}
        onClick={() => void apply()}
      >
        {applyLive ? t('应用到运行中的 VM') : t('应用')}
      </button>
      <button type="button" data-monitor-action="close-custom-map" disabled={busy} onClick={() => finish(false)}>
        {applied ? t('关闭') : t('取消')}
      </button>
    </Modal>
  );
}
