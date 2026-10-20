import type { ReactNode } from 'react';
import { Ra2ConsoleArtwork } from './Ra2ConsoleArtwork';
import './ra2menu.css';

/** SVG equipment and live controls share the same 800x600 coordinate system. */
export function Ra2MenuPanel({ children }: { children: ReactNode }) {
  return (
    <div className="ra2-panel-wrap">
      <div className="ra2-panel">
        <Ra2ConsoleArtwork />
        {children}
      </div>
    </div>
  );
}
