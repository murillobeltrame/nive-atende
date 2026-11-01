// Simulador: o lojista conversa com a IA como se fosse um cliente, sem usar o WhatsApp.
import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../shared/types";
import { MessageBubble } from "../components/MessageBubble";
import { IconSend } from "../components/Icons";
import { api } from "../lib/api";

const IDEAS = ["Oi, vocês têm perfume?", "Quero um presente pra minha mãe até R$ 200", "Tem chocolate amargo?", "Só tem essas opções?"];

export function SimulatorPage({ onOpenSettings }: { onOpenSettings: (section: string) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activity, setActivity] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void api.simMessages().then(setMessages);
    return api.onSim((e) => {
      if (e.message) {
        const m = e.message;
        setMessages((prev) => {
          const i = prev.findIndex((x) => x.id === m.id);
          if (i === -1) return [...prev, m];
          const next = prev.slice();
          next[i] = m;
          return next;
        });
      }
      if (e.activity !== undefined) setActivity(e.activity);
    });
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, activity]);

  const send = async (value: string) => {
    const t = value.trim();
    if (!t) return;
    setText("");
    setError(null);
    try {
      await api.simSend(t);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    }
  };

  const reset = async () => {
    await api.simReset();
    setMessages([]);
    setActivity(null);
  };

  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="page sim-page">
      <div className="sim-head">
        <div>
          <h1 className="page-title">Testar a IA</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            Converse como se fosse um cliente. A IA usa o catálogo real da loja e as mesmas configurações de
            personalidade e contexto, mas nada vai para o WhatsApp: reservas e cadastros aqui são só de teste e a consulta
            de contas fica desligada. Consome créditos da OpenAI normalmente.
          </p>
        </div>
        <div className="btn-row">
          <button className="btn sm" onClick={() => onOpenSettings("personalidade")}>
            Ajustar personalidade
          </button>
          <button className="btn sm" onClick={() => void reset()}>
            Recomeçar conversa
          </button>
        </div>
      </div>
      <div className="messages sim-messages" aria-live="polite">
        {sorted.length === 0 && (
          <div className="sim-empty">
            <p>Mande uma mensagem como um cliente mandaria. Algumas ideias:</p>
            <div className="btn-row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
              {IDEAS.map((i) => (
                <button key={i} className="chip" onClick={() => void send(i)}>
                  {i}
                </button>
              ))}
            </div>
          </div>
        )}
        {sorted.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        {activity && (
          <div className="ai-activity" role="status">
            <span className="ai-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {activity}
          </div>
        )}
        <div ref={endRef} />
      </div>
      {error && (
        <div className="callout danger" role="alert" style={{ margin: "0 16px 8px" }}>
          {error}
        </div>
      )}
      <form
        className="sim-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          className="input"
          value={text}
          placeholder="Escreva como se fosse o cliente…"
          aria-label="Mensagem de teste"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={!text.trim()} aria-label="Enviar">
          <IconSend size={16} />
        </button>
      </form>
    </div>
  );
}
