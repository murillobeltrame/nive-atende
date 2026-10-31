import { useState } from "react";
import { Modal } from "./Modal";

/** Termo de uso obrigatório no primeiro acesso. */
export function TermsModal({ onAccept }: { onAccept: () => Promise<void> }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Antes de começar" wide>
      <p>O Nive Atende responde seus clientes no WhatsApp em nome da sua loja. Leia e confirme:</p>
      <ul className="terms-list">
        <li>
          A conexão com o WhatsApp usada pelo Nive Atende <b>não é oficial</b>. Existe risco de o WhatsApp bloquear o
          número. Para reduzir esse risco, o sistema <b>só responde quem chamou</b> e nunca envia mensagens em massa.
        </li>
        <li>
          O custo da inteligência artificial é <b>seu</b>: é cobrado direto pela OpenAI, na chave e nos créditos que
          você cadastrar.
        </li>
        <li>
          Você é <b>responsável pelas respostas</b> enviadas e pelas configurações escolhidas. Pode desligar o
          atendimento automático a qualquer momento.
        </li>
        <li>
          As respostas automáticas só funcionam enquanto <b>este computador estiver ligado</b>, com internet e com o
          programa aberto (pode ficar no canto da tela, ao lado do relógio).
        </li>
        <li>Consultas de contas de clientes ficam registradas neste computador para você conferir.</li>
      </ul>
      <label className="inline-check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>Li e concordo com os pontos acima.</span>
      </label>
      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
        <button
          className="btn primary"
          disabled={!checked || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onAccept();
            } finally {
              setBusy(false);
            }
          }}
        >
          Concordo e quero continuar
        </button>
      </div>
    </Modal>
  );
}
