import { useEffect, useState } from "react";
import type { QrState } from "../../../shared/types";
import { api } from "../lib/api";
import { Modal } from "./Modal";

/** Conectar o WhatsApp da loja: mostra o QR Code (e o código de pareamento) até conectar. */
export function QrModal({ onClose }: { onClose: () => void }) {
  const [qr, setQr] = useState<QrState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let closed = false;
    setQr(null);
    setError(null);
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
  }, [attempt]);

  const expired = qr?.state === "close";

  // "Conectar com número de telefone" (sem câmera)
  const [phone, setPhone] = useState("");
  const [pair, setPair] = useState<{ ok: boolean; code: string | null; message: string } | null>(null);
  const [pairing, setPairing] = useState(false);
  const requestCode = async () => {
    setPairing(true);
    setPair(null);
    try {
      setPair(await api.whatsappPairingCode(phone));
    } catch (e) {
      setPair({ ok: false, code: null, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPairing(false);
    }
  };

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
            {qr?.qrBase64 && !expired ? (
              <img src={qr.qrBase64} alt="QR Code para conectar o WhatsApp" />
            ) : expired ? (
              <button className="btn primary" onClick={() => setAttempt((a) => a + 1)}>
                Gerar novo código
              </button>
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
            <div className="pair-alt">
              <div className="field-label">Ou conecte sem câmera, com o número de telefone</div>
              {pair?.ok && pair.code ? (
                <>
                  <div className="pair-code" aria-live="polite">{pair.code}</div>
                  <small style={{ color: "var(--muted)" }}>
                    No celular: <b>Aparelhos conectados</b> › <b>Conectar aparelho</b> › <b>Conectar com número de telefone</b> e
                    digite o código. Ele vale por poucos minutos.
                  </small>
                </>
              ) : (
                <>
                  <div className="btn-row" style={{ flexWrap: "nowrap" }}>
                    <label className="sr-only" htmlFor="pair-phone">
                      Número do WhatsApp da loja
                    </label>
                    <input
                      id="pair-phone"
                      className="input"
                      inputMode="numeric"
                      placeholder="5548999990000"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, ""))}
                    />
                    <button className="btn" onClick={() => void requestCode()} disabled={pairing || phone.length < 12}>
                      {pairing ? "Gerando…" : "Gerar código"}
                    </button>
                  </div>
                  <small style={{ color: pair && !pair.ok ? "#8A2A12" : "var(--muted)" }}>
                    {pair && !pair.ok ? pair.message : "Número do WhatsApp da loja com 55 e DDD."}
                  </small>
                </>
              )}
            </div>
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
