import { useEffect, useState } from "react";
import type { QrState } from "../../../shared/types";
import { api } from "../lib/api";
import { Modal } from "./Modal";

/** Conectar o WhatsApp da loja: mostra o QR Code (e o código de pareamento) até conectar. */
export function QrModal({ onClose }: { onClose: () => void }) {
  const [qr, setQr] = useState<QrState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    const off = api.onQr((q) => {
      if (closed) return;
      setQr(q);
    });
    api
      .whatsappConnect()
      .then((q) => !closed && setQr(q))
      .catch((e: unknown) => !closed && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      closed = true;
      off();
    };
  }, []);

  useEffect(() => {
    if (qr?.state === "open") {
      const t = setTimeout(onClose, 1500);
      return () => clearTimeout(t);
    }
  }, [qr?.state, onClose]);

  return (
    <Modal title="Conectar o WhatsApp da loja" onClose={onClose}>
      {error ? (
        <div className="callout danger">Não foi possível gerar o QR Code: {error}</div>
      ) : qr?.state === "open" ? (
        <div className="callout info">WhatsApp conectado. O atendimento já pode começar.</div>
      ) : (
        <div className="qr-box">
          <div className="qr-img">
            {qr?.qrBase64 ? (
              <img src={qr.qrBase64} alt="QR Code para conectar o WhatsApp" />
            ) : (
              <span>Gerando QR Code…</span>
            )}
          </div>
          <div className="stack" style={{ flex: 1, minWidth: 220 }}>
            <ol className="terms-list">
              <li>Abra o WhatsApp no celular da loja.</li>
              <li>
                Toque em <b>Aparelhos conectados</b> › <b>Conectar aparelho</b>.
              </li>
              <li>Aponte a câmera para o código ao lado.</li>
            </ol>
            {qr?.pairingCode && (
              <div>
                <div className="field-label">Ou use o código de pareamento</div>
                <div className="pair-code">{qr.pairingCode}</div>
              </div>
            )}
            {qr?.message && <small style={{ color: "var(--muted)" }}>{qr.message}</small>}
          </div>
        </div>
      )}
      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}
