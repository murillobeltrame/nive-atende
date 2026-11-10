import type { StatusActionKind, StatusSnapshot } from "../../../shared/types";
import { IconAlert, IconStop } from "./Icons";

interface Props {
  status: StatusSnapshot | null;
  onAction: (kind: StatusActionKind) => void;
  onToggleAuto: (enabled: boolean) => void;
  busy: boolean;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `há ${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `há ${m} min` : `há ${Math.round(m / 60)} h`;
}

/** Faixa fixa no topo: diz em linguagem simples se o atendimento está funcionando. */
export function StatusBar({ status, onAction, onToggleAuto, busy }: Props) {
  if (!status) {
    return (
      <div className="statusbar ok" role="status">
        <div className="status-main">
          <span className="status-headline">Verificando conexões…</span>
        </div>
      </div>
    );
  }
  const { level } = status;
  return (
    <div className={`statusbar ${level}`} role="status" aria-live="polite">
      <div className="status-main">
        {level === "ok" && <span className="status-dot" aria-hidden="true" />}
        {level === "warn" && <IconAlert size={18} className="status-icon" />}
        {level === "error" && <IconStop size={18} className="status-icon" />}
        <div className="status-text">
          <span className="status-headline">{status.headline}</span>
          <span className="status-detail">
            {status.detail}
            {level === "ok" ? ` · última verificação ${ago(status.lastCheckAt)}` : ""}
          </span>
        </div>
      </div>
      <div className="status-right">
        {status.action && (
          <button className="status-action" onClick={() => status.action && onAction(status.action.kind)} disabled={busy}>
            {status.action.label}
          </button>
        )}
        <label
          className={`switch${level === "error" ? " dim" : ""}`}
          title={level === "error" ? "Só volta a valer quando o problema acima for resolvido" : undefined}
        >
          <span className="switch-label">Atendimento automático</span>
          <input
            type="checkbox"
            role="switch"
            checked={status.autoEnabled}
            onChange={(e) => onToggleAuto(e.target.checked)}
          />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">
            <strong>{status.autoEnabled ? "Ligado" : "Desligado"}</strong>
          </span>
        </label>
      </div>
    </div>
  );
}
