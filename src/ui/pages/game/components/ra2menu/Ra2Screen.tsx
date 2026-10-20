import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './ra2menu.css';

/** Full-viewport RA2 menu backdrop with a scrollable panel and bottom fade. */
export function Ra2Screen({ children }: { children: ReactNode }) {
  const screen = useRef<HTMLDivElement>(null);
  const [panelZoom, setPanelZoom] = useState(1);
  useLayoutEffect(() => {
    const element = screen.current;
    if (!element) return;
    const updateZoom = () => {
      // The panel remains 4:3 and leaves room for its footer; narrow phones use the separate mobile layout.
      if (element.clientWidth <= 560) return setPanelZoom(1);
      setPanelZoom(
        Math.min(Math.max(0.6, (element.clientWidth - 32) / 800), Math.max(0.6, (element.clientHeight - 112) / 600)),
      );
    };
    const observer = new ResizeObserver(updateZoom);
    observer.observe(element);
    updateZoom();
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={screen} className="ra2-screen" style={{ '--ra2-panel-zoom': panelZoom } as CSSProperties}>
      <p className="ea-notice" lang="en">
        EA has not endorsed and does not support this product.
      </p>
      {children}
    </div>
  );
}
