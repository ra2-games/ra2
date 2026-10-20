import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Native modal behavior traps and restores focus; Esc closes only the page dialog without injecting VM keystrokes. */
export function Modal({
  open,
  onClose,
  title,
  className = '',
  busy = false,
  children,
  id,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  className?: string;
  busy?: boolean;
  children: ReactNode;
  id?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      id={id}
      className={className}
      aria-label={title}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
