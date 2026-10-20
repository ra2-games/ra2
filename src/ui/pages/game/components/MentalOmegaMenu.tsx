import { useEffect, useState } from 'react';
import type { GameSource } from '../../../../games/source';
import {
  createMentalOmegaLaunchFiles,
  readMentalOmegaMenu,
  type MentalOmegaMenu as Menu,
  type MentalOmegaSelection,
} from '../../../../games/mentalOmega/menu';
import { t } from '../../../shared/i18n/translate';
import { createMentalOmegaLoadFiles, listMentalOmegaSaves } from '../../../../games/mentalOmega/saves';
import './GameSourcePicker.css';
import './MentalOmegaMenu.css';

export function MentalOmegaMenu({
  source,
  finish,
}: {
  source: GameSource;
  finish(files: ReadonlyMap<string, Uint8Array> | null): void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<MentalOmegaSelection['mode'] | 'load' | null>(null);
  const [saves, setSaves] = useState<string[]>([]);
  const [id, setId] = useState('');
  const [side, setSide] = useState(0);
  const [opponents, setOpponents] = useState(1);
  const [difficulty, setDifficulty] = useState(1);
  const [credits, setCredits] = useState(10000);
  const [speed, setSpeed] = useState(2);
  useEffect(() => {
    let active = true;
    void readMentalOmegaMenu(source.files)
      .then((value) => {
        if (active) setMenu(value);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [source]);
  const mission = menu?.missions.find((entry) => entry.id === id);
  const map = menu?.maps.find((entry) => entry.id === id);
  const start = async () => {
    if (!menu || !mode || busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'load') {
        finish(await createMentalOmegaLoadFiles(source.files, id));
        return;
      }
      finish(
        await createMentalOmegaLaunchFiles(source.files, menu, {
          mode,
          id,
          side,
          opponents,
          difficulty,
          credits,
          speed,
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };
  return (
    <section className="message-box mo-menu" aria-label={t('心灵终结主菜单')}>
      <header>
        <span className="source-picker-brand">MENTAL OMEGA · 3.3.6</span>
        <h1>{t('心灵终结')}</h1>
        <p>{t('选择战役、遭遇战或加载存档。')}</p>
      </header>
      {!menu && !error && <p role="status">{t('正在读取任务和地图…')}</p>}
      {error && <p role="alert">{error}</p>}
      {menu && !mode && (
        <div className="mo-menu-choices">
          <button
            className="dialog-button"
            disabled={busy}
            onClick={() => {
              setMode('campaign');
              setId('');
            }}
          >
            {t('战役任务')}
          </button>
          <button
            className="dialog-button"
            disabled={busy}
            onClick={() => {
              setMode('skirmish');
              setId('');
            }}
          >
            {t('遭遇战')}
          </button>
          <button
            className="dialog-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                setSaves(await listMentalOmegaSaves(source.files));
                setMode('load');
                setId('');
              } catch (reason) {
                setError(String(reason));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('加载存档')}
          </button>
        </div>
      )}
      {menu && mode && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <h2>{mode === 'load' ? t('加载存档') : mode === 'campaign' ? t('战役任务') : t('遭遇战')}</h2>
          <label>
            {mode === 'load' ? t('选择存档') : mode === 'campaign' ? t('选择任务') : t('选择地图')}
            <select
              aria-label={mode === 'load' ? t('选择存档') : mode === 'campaign' ? t('选择任务') : t('选择地图')}
              value={id}
              disabled={busy}
              onChange={(event) => {
                setId(event.target.value);
                setOpponents(1);
              }}
            >
              <option value="">{t('请选择…')}</option>
              {(mode === 'load'
                ? saves.map((path) => ({ id: path, title: path }))
                : mode === 'campaign'
                  ? menu.missions
                  : menu.maps
              ).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          </label>
          {mode === 'load' && !saves.length && <p role="status">{t('未找到存档，请导入包含存档的游戏目录。')}</p>}
          {mode === 'campaign' && mission && <p className="mo-mission-description">{mission.description}</p>}
          {mode === 'skirmish' && (
            <div className="mo-settings">
              <label>
                {t('阵营')}
                <select value={side} disabled={busy} onChange={(event) => setSide(Number(event.target.value))}>
                  {menu.sides.map((name, index) => (
                    <option key={index} value={index}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('电脑数量')}
                <select
                  value={opponents}
                  disabled={busy || !map}
                  onChange={(event) => setOpponents(Number(event.target.value))}
                >
                  {Array.from({ length: (map?.players ?? 2) - 1 }, (_, index) => (
                    <option key={index} value={index + 1}>
                      {index + 1}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('电脑难度')}
                <select
                  value={difficulty}
                  disabled={busy}
                  onChange={(event) => setDifficulty(Number(event.target.value))}
                >
                  <option value={0}>{t('简单')}</option>
                  <option value={1}>{t('中等')}</option>
                  <option value={2}>{t('困难')}</option>
                </select>
              </label>
              <label>
                {t('初始资金')}
                <select value={credits} disabled={busy} onChange={(event) => setCredits(Number(event.target.value))}>
                  {[5000, 10000, 20000, 50000].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {mode !== 'load' && (
            <label>
              {t('游戏速度')}
              <select value={speed} disabled={busy} onChange={(event) => setSpeed(Number(event.target.value))}>
                {[0, 1, 2, 3, 4, 5, 6].map((value) => (
                  <option key={value} value={value}>
                    {value === 0 ? t('最快') : String(7 - value)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="mo-menu-choices">
            <button type="submit" className="dialog-button" disabled={!id || busy}>
              {busy ? t('正在准备…') : mode === 'load' ? t('加载存档') : t('开始游戏')}
            </button>
            <button
              type="button"
              className="dialog-button"
              disabled={busy}
              onClick={() => {
                setMode(null);
                setId('');
                setError('');
              }}
            >
              {t('返回主菜单')}
            </button>
          </div>
        </form>
      )}
      <button className="dialog-button" disabled={busy} onClick={() => finish(null)}>
        {t('更换游戏资源')}
      </button>
    </section>
  );
}
