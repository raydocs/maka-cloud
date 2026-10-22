import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Minimize2, X } from 'lucide-react';

const SWIPE_DISTANCE = 80;

/**
 * A result opened large over a blurred, dimmed page: close at the top left, collapse at the bottom
 * right, a status pill with the result beside it. Escape, either button, or a swipe down goes back.
 * Focus moves in and returns to what opened it; Tab stays inside.
 */
export function Viewer({
  label,
  status,
  onClose,
  children,
}: {
  label: string;
  status: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      } else if (event.key === 'Tab' && dialog.current) {
        const buttons = [...dialog.current.querySelectorAll<HTMLElement>('button')];
        const first = buttons[0];
        const last = buttons.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  // In the body, not in the card that opened it: a card's backdrop filter would make it the
  // containing block of anything fixed inside it, and the viewer would be clipped to the card.
  return createPortal(
    <div className="viewer" role="dialog" aria-modal="true" aria-label={label} ref={dialog}>
      <button
        type="button"
        className="round-button quiet viewer-close"
        aria-label="Close"
        onClick={onClose}
      >
        <X aria-hidden="true" size={18} strokeWidth={2} />
      </button>
      <div
        className="viewer-body"
        onPointerDown={(event) => {
          start.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const from = start.current;
          start.current = null;
          if (!from) return;
          const down = event.clientY - from.y;
          if (down > SWIPE_DISTANCE && Math.abs(event.clientX - from.x) < down / 2) onClose();
        }}
      >
        {children}
      </div>
      <span className="viewer-status chip" role="status">
        {status}
      </span>
      <button
        type="button"
        className="round-button quiet viewer-collapse"
        aria-label="Collapse"
        onClick={onClose}
      >
        <Minimize2 aria-hidden="true" size={16} strokeWidth={2} />
      </button>
    </div>,
    document.body,
  );
}
