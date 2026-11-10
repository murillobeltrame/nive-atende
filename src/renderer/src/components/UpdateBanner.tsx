import { useEffect, useState } from "react";
import type { UpdateState } from "../../../shared/types";
import { api } from "../lib/api";

/** Estado da atualização do programa, sempre atual. */
export function useUpdateState(): UpdateState | null {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  useEffect(() => {
    void api.getUpdateState().then(setUpdate);
    return api.onUpdate(setUpdate);
  }, []);
  return update;
}

/** Faixa abaixo do status: aparece só quando há versão nova para instalar ou baixar. */
export function UpdateBanner() {
  const update = useUpdateState();
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!update || !update.version || dismissed === update.version) return null;

  if (update.status === "ready") {
    return (
      <div className="update-banner" role="status">
        <span>
          <strong>Nova versão {update.version} pronta.</strong> O programa fecha e abre de novo em alguns segundos; as mensagens que chegarem
          nesse intervalo são respondidas quando ele voltar.
        </span>
        <span className="update-actions">
          <button
            className="update-btn primary"
            disabled={installing}
            onClick={async () => {
              setInstalling(true);
              if (!(await api.installUpdate())) setInstalling(false);
            }}
          >
            {installing ? "Atualizando…" : "Atualizar agora"}
          </button>
          <button className="update-btn" disabled={installing} onClick={() => setDismissed(update.version)}>
            Depois
          </button>
        </span>
      </div>
    );
  }

  if (update.status === "manual") {
    const url = update.downloadUrl;
    return (
      <div className="update-banner" role="status">
        <span>
          <strong>Nova versão {update.version} disponível.</strong> Baixe o instalador e instale por cima desta.
        </span>
        <span className="update-actions">
          {url && (
            <button className="update-btn primary" onClick={() => void api.openExternal(url)}>
              Baixar
            </button>
          )}
          <button className="update-btn" onClick={() => setDismissed(update.version)}>
            Depois
          </button>
        </span>
      </div>
    );
  }
  return null;
}
