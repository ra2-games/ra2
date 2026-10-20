import type { ReactNode } from 'react';
import './ra2menu.css';

/** Vertical command column on the right edge; add `.ra2-menu-blank` or `.ra2-spacer` children for spacing. */
export function Ra2MenuNav({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav className="ra2-menu-nav" aria-label={label}>
      {children}
    </nav>
  );
}
