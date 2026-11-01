import { useCallback, useEffect, useRef, useState } from "react";
import { IconX } from "./Icons";

const MIN = 1;
const MAX = 6;

/**
 * Foto em tela cheia com zoom: roda do mouse/pinça amplia no ponto do cursor, duplo clique alterna 1x/2,5x,
 * arrastar move a foto ampliada, + / − / 0 no teclado, Esc fecha.
 */
export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const view = useRef({ scale: 1, x: 0, y: 0 });
  view.current = { scale, ...pos };

  /** Muda o zoom mantendo fixo o ponto (cx, cy) relativo ao centro da tela. */
  const zoomTo = useCallback((next: number, cx = 0, cy = 0) => {
    const cur = view.current;
    const s = Math.min(MAX, Math.max(MIN, next));
    const p = s === 1 ? { x: 0, y: 0 } : { x: cx - ((cx - cur.x) * s) / cur.scale, y: cy - ((cy - cur.y) * s) / cur.scale };
    view.current = { scale: s, ...p };
    setScale(s);
    setPos(p);
  }, []);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomTo(view.current.scale * 1.4);
      else if (e.key === "-") zoomTo(view.current.scale / 1.4);
      else if (e.key === "0") zoomTo(1);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose, zoomTo]);

  // roda do mouse (passivo: false para poder impedir a rolagem da página)
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      zoomTo(view.current.scale * factor, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  const center = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const;
  };

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Foto ampliada">
      <div className="viewer-bar">
        <span className="viewer-zoom" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <button className="viewer-btn" onClick={() => zoomTo(scale / 1.4)} disabled={scale <= MIN} aria-label="Diminuir zoom" title="Diminuir (−)">
          −
        </button>
        <button className="viewer-btn" onClick={() => zoomTo(scale * 1.4)} disabled={scale >= MAX} aria-label="Aumentar zoom" title="Aumentar (+)">
          +
        </button>
        <button className="viewer-btn text" onClick={() => zoomTo(1)} disabled={scale === 1} title="Tamanho original (0)">
          Ajustar
        </button>
        <button ref={closeRef} className="viewer-btn" onClick={onClose} aria-label="Fechar" title="Fechar (Esc)">
          <IconX size={18} />
        </button>
      </div>
      <div
        ref={stage}
        className={`viewer-stage ${scale > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in"}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          if (scale > 1) {
            setDragging(true);
            setPos({ x: d.px + dx, y: d.py + dy });
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          setDragging(false);
          if (d?.moved) return;
          // clique simples fora da foto fecha; na foto, sem zoom, amplia
          if ((e.target as HTMLElement).tagName !== "IMG") onClose();
          else if (scale === 1) zoomTo(2.5, ...center(e));
        }}
        onDoubleClick={(e) => (scale > 1 ? zoomTo(1) : zoomTo(2.5, ...center(e)))}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, transition: dragging ? "none" : "transform 0.12s ease-out" }}
        />
      </div>
      <div className="viewer-hint">Role o mouse ou clique para ampliar · arraste para mover · Esc para fechar</div>
    </div>
  );
}
