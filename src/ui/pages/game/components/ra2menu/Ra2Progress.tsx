import type { CSSProperties } from 'react';
import './ra2menu.css';

/** Shared installation-style track; omit value when the operation has no known total. */
export function Ra2Progress({ label, value }: { label: string; value?: number }) {
  const percent = value === undefined ? undefined : Math.min(100, Math.max(0, value));
  return (
    <div className="ra2-progress-frame">
      <div
        className={`ra2-progress-track${percent === undefined ? ' indeterminate' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{ '--ra2-progress': `${percent ?? 0}%` } as CSSProperties}
      >
        <span className="ra2-progress-fill" />
        <span className="ra2-progress-label">{label}</span>
      </div>
    </div>
  );
}
