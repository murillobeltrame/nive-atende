import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconX } from "./Icons";

interface Props {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  wide?: boolean;
}

/** Diálogo modal acessível: foca o conteúdo ao abrir, Esc fecha (se houver onClose). */
export function Modal({ title, onClose, children, wide }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
        style={wide ? { maxWidth: 680 } : undefined}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Fechar">
              <IconX />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
