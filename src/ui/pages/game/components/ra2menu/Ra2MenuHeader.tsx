import type { ReactNode } from 'react';
import './ra2menu.css';

/** Top-right status area shared by resource selection and startup. */
export function Ra2MenuHeader({ children }: { children: ReactNode }) {
  return <header className="ra2-menu-header">{children}</header>;
}
