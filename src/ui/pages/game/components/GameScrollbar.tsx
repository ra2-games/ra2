import { t } from '../../../shared/i18n/translate';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Skirmish-style narrow red scrollbar; the browser still scrolls content. Synchronize position without simulating option clicks. */
export function GameScrollbar({
  viewport,
  controls,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  controls: string;
}) {
  const [metrics, setMetrics] = useState({ top: 0, max: 0, height: 0 });
  const drag = useRef<{ pointer: number; y: number; top: number } | null>(null);
  const delay = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const repeat = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const stop = () => {
    clearTimeout(delay.current);
    clearInterval(repeat.current);
  };
  useLayoutEffect(() => {
    const node = viewport.current!;
    const measure = () =>
      setMetrics({
        top: node.scrollTop,
        max: Math.max(0, node.scrollHeight - node.clientHeight),
        height: node.clientHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener('scroll', measure);
    window.addEventListener('blur', stop);
    return () => {
      stop();
      observer.disconnect();
      node.removeEventListener('scroll', measure);
      window.removeEventListener('blur', stop);
    };
  }, [viewport]);
  if (metrics.max === 0) return null;
  // Also subtract the scrollbar's own 1px top/bottom borders so the thumb cannot overlap the down arrow at the bottom.
  const travel = Math.max(1, metrics.height - 42 - 18);
  const thumbTop = (metrics.top / metrics.max) * travel;
  return (
    <div className="game-scrollbar" onPointerDown={(event) => event.preventDefault()}>
      {([-1, 1] as const).map((direction) => (
        <button
          key={direction}
          type="button"
          tabIndex={-1}
          className={`game-scroll-arrow ${direction === -1 ? 'up' : 'down'}`}
          aria-label={direction === -1 ? t('向上滚动') : t('向下滚动')}
          onPointerDown={(event) => {
            event.preventDefault();
            stop();
            event.currentTarget.setPointerCapture(event.pointerId);
            viewport.current!.scrollTop += direction * 30;
            delay.current = setTimeout(() => {
              repeat.current = setInterval(() => {
                if (viewport.current) viewport.current.scrollTop += direction * 30;
              }, 80);
            }, 350);
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
          onClick={(event) => {
            if (event.detail === 0) viewport.current!.scrollTop += direction * 30;
          }}
        />
      ))}
      <div
        className="game-scroll-track"
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const offset = event.clientY - rect.top;
          viewport.current!.scrollTop += (offset < thumbTop ? -1 : 1) * metrics.height;
        }}
      >
        <div
          className="game-scroll-thumb"
          role="scrollbar"
          aria-label={t('选项滚动条')}
          aria-controls={controls}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={metrics.max}
          aria-valuenow={Math.round(metrics.top)}
          tabIndex={-1}
          style={{ top: thumbTop }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointer: event.pointerId,
              y: event.clientY,
              top: viewport.current!.scrollTop,
            };
          }}
          onPointerMove={(event) => {
            if (drag.current?.pointer === event.pointerId)
              viewport.current!.scrollTop =
                drag.current.top + ((event.clientY - drag.current.y) * metrics.max) / travel;
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const node = viewport.current!;
            if (event.key === 'Home') node.scrollTop = 0;
            else if (event.key === 'End') node.scrollTop = metrics.max;
            else
              node.scrollTop +=
                (event.key.endsWith('Up') ? -1 : 1) * (event.key.startsWith('Page') ? metrics.height : 30);
          }}
        />
      </div>
    </div>
  );
}
