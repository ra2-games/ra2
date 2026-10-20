import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from 'react';
import './ra2menu.css';

/** Menu command: textured metal plate with muted gold text and a brighter red hover state.
    Long labels shrink instead of overflowing the fixed 155px plate. */
export function Ra2MenuButton({ className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const label = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = label.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = '';
      let size = 13;
      el.style.fontSize = `${size}px`;
      while (size > 9 && el.scrollWidth > el.clientWidth) el.style.fontSize = `${--size}px`;
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(el);
    // Locale or label changes keep the same plate size, so watch the text itself too.
    const mutate = new MutationObserver(fit);
    mutate.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      resize.disconnect();
      mutate.disconnect();
    };
  }, []);
  return (
    <button type="button" className={`ra2-menu-btn${className ? ` ${className}` : ''}`} {...rest}>
      <span ref={label} className="ra2-menu-btn-label">
        {children}
      </span>
    </button>
  );
}
