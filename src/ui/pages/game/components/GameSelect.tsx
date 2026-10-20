import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GameScrollbar } from './GameScrollbar';
import { usePortalHost } from '../../../shared/portalHost';
import './GameSelect.css';

/** Shared RA2 dropdown: place the popup outside the toolbar's scrolling container to avoid landscape clipping. */
export function GameSelect({
  id,
  nativeId = id,
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  id: string;
  nativeId?: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 220 });
  const portalHost = usePortalHost();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const show = () => {
    if (!disabled) {
      setActive(selected);
      setOpen(true);
    }
  };
  const choose = (index: number) => {
    setOpen(false);
    trigger.current?.focus();
    onChange(options[index]!.value);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const bounds = trigger.current!.getBoundingClientRect();
    const hostBounds = portalHost.getBoundingClientRect();
    const rect = {
      left: bounds.left - hostBounds.left,
      top: bounds.top - hostBounds.top,
      bottom: bounds.bottom - hostBounds.top,
      width: bounds.width,
    };
    const below = portalHost.clientHeight - rect.bottom - 8;
    const height = Math.min(220, options.length * 30 + 4);
    const above = below < height && rect.top > below;
    const maxHeight = Math.max(30, Math.min(height, above ? rect.top - 8 : below));
    setPosition({
      left: Math.max(4, Math.min(rect.left, portalHost.clientWidth - rect.width - 4)),
      top: above ? rect.top - maxHeight - 2 : rect.bottom + 2,
      width: rect.width,
      maxHeight,
    });
  }, [open, options.length, portalHost]);
  useEffect(() => {
    if (open) items.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node))
        setOpen(false);
    };
    const close = () => setOpen(false);
    // Close the popup when the toolbar scrolls; scrolling within options neither closes it nor scrolls the game canvas.
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className="game-select" id={`${id}-widget`}>
      <button
        ref={trigger}
        id={`${id}-toggle`}
        type="button"
        className="game-select-value"
        disabled={disabled}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={(event) => {
          if (!popup.current?.contains(event.relatedTarget)) setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            setOpen(false);
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
          if (!open) {
            show();
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            choose(active);
            return;
          }
          setActive((index) =>
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? options.length - 1
                : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))),
          );
        }}
      >
        <span id={`${id}-label`}>{options[selected]?.label}</span>
      </button>
      <select
        id={nativeId}
        aria-label={label}
        hidden
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {open &&
        createPortal(
          <div ref={popup} className="game-select-popup" style={position} onWheel={(event) => event.stopPropagation()}>
            <div
              ref={viewport}
              id={`${id}-options`}
              role="listbox"
              aria-label={label}
              className="game-select-options"
              style={{ maxHeight: position.maxHeight }}
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  ref={(node) => {
                    items.current[index] = node;
                  }}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={value === option.value}
                  className={`game-select-option${active === index ? ' active' : ''}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(index)}
                >
                  {option.label}
                </div>
              ))}
            </div>
            <GameScrollbar viewport={viewport} controls={`${id}-options`} />
          </div>,
          portalHost,
        )}
    </div>
  );
}
