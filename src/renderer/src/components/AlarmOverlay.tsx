import { useEffect, useRef, useState } from "react";
import type { ActionAlarm } from "../../../shared/types";
import { api } from "../lib/api";
import { IconBag, IconBell, IconChat } from "./Icons";

const RING_EVERY_MS = 6_000;

/** Dois bipes pelo Web Audio (sem arquivo): toca mesmo com o som de notificação do Windows desligado. */
function ring(ctx: AudioContext): void {
  const now = ctx.currentTime;
  [880, 1175].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    const start = now + i * 0.22;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.4, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.2);
  });
}

/**
 * Aviso "aguardando ação" que toca na tela do Nive Atende quando nenhuma tela do Nive ERP mostrou
 * (ninguém com o ERP aberto) ou o ERP está fora. Toca até alguém clicar.
 */
export function AlarmOverlay({ onOpenConversation }: { onOpenConversation: (conversationId: string, kind: ActionAlarm["kind"]) => void }) {
  const [alarms, setAlarms] = useState<ActionAlarm[]>([]);
  const audio = useRef<AudioContext | null>(null);

  useEffect(() => api.onAlarm(setAlarms), []);

  const key = alarms.map((a) => a.ref).join(",");
  useEffect(() => {
    if (!key) return;
    try {
      audio.current ??= new AudioContext();
    } catch {
      return;
    }
    const ctx = audio.current;
    const play = () => {
      void ctx.resume().then(() => ring(ctx)).catch(() => undefined);
    };
    play();
    const t = window.setInterval(play, RING_EVERY_MS);
    return () => window.clearInterval(t);
  }, [key]);

  if (!alarms.length) return null;
  const dismiss = (refs: string[]) => {
    setAlarms((list) => list.filter((a) => !refs.includes(a.ref)));
    void api.dismissAlarm(refs);
  };
  const offline = alarms.some((a) => a.erpOffline);

  return (
    <div className="modal-backdrop alarm-backdrop">
      <div className="modal alarm" role="alertdialog" aria-modal="true" aria-labelledby="alarm-title">
        <div className="alarm-head">
          <IconBell size={18} />
          <h2 id="alarm-title">Aguardando ação{alarms.length > 1 ? ` (${alarms.length})` : ""}</h2>
        </div>
        <p className="alarm-sub">
          {offline
            ? "O Nive ERP não respondeu, então o aviso está aqui."
            : "Ninguém está com o Nive ERP aberto para ver este aviso."}
        </p>
        <ul className="alarm-list">
          {alarms.map((a) => (
            <li key={a.ref}>
              <span className="alarm-icon">{a.kind === "reservation" ? <IconBag size={16} /> : <IconChat size={16} />}</span>
              <div className="alarm-body">
                <strong>{a.title}</strong>
                <span>{a.message}</span>
                <div className="alarm-actions">
                  <button
                    className="btn primary sm"
                    onClick={() => {
                      dismiss([a.ref]);
                      onOpenConversation(a.conversationId, a.kind);
                    }}
                  >
                    {a.kind === "reservation" ? "Ver reserva" : "Responder"}
                  </button>
                  <button className="btn sm" onClick={() => dismiss([a.ref])}>
                    Vou ver
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
        {alarms.length > 1 && (
          <button className="btn sm alarm-all" onClick={() => dismiss(alarms.map((a) => a.ref))}>
            Silenciar todos
          </button>
        )}
      </div>
    </div>
  );
}
