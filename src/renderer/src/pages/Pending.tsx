import { useEffect, useState } from "react";
import { approveLabel, customerInfo } from "../lib/reservation";
import { type Choice, CustomerChoice, needsChoice } from "../components/CustomerChoice";
import { prettyName } from "../../../shared/format";
import type { Conversation, Reservation } from "../../../shared/types";
import { api } from "../lib/api";
import { contactName, listTime, money } from "../lib/format";

interface Props {
  onOpenConversation: (id: string) => void;
}

export function PendingPage({ onOpenConversation }: Props) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [res, setRes] = useState<Reservation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [c, r] = await Promise.all([api.listConversations("precisa"), api.listReservations()]);
    setConvs(c);
    setRes(r.filter((x) => x.status === "pending_approval"));
  };

  useEffect(() => {
    void load();
    const off1 = api.onConversation(() => void load());
    const off2 = api.onReservation(() => void load());
    return () => {
      off1();
      off2();
    };
  }, []);

  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const act = async (id: string, fn: (id: string) => Promise<Reservation>) => {
    setBusy(id);
    setError(null);
    try {
      await fn(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page-pad">
        <h1 className="page-title">Pendências</h1>
        <p className="page-sub">O que precisa de você agora: conversas que a IA passou para a loja e reservas para aprovar.</p>
        {error && (
          <div className="callout danger" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        <h2 className="section-h">Conversas que precisam de você ({convs.length})</h2>
        {convs.length === 0 ? (
          <div className="card empty">Nenhuma conversa esperando por você.</div>
        ) : (
          <div className="pending-list">
            {convs.map((c) => (
              <div className="pending-item" key={c.id}>
                <span className="tag tag-need">PRECISA DE VOCÊ</span>
                <div className="grow">
                  <div className="title">{contactName(c.displayName)}</div>
                  <div className="desc">
                    {c.handoffReason ?? "A IA passou para humano"} · “{c.lastPreview}” · {listTime(c.lastMessageAt)}
                  </div>
                </div>
                <button className="btn sm primary" onClick={() => onOpenConversation(c.id)}>
                  Abrir conversa
                </button>
              </div>
            ))}
          </div>
        )}
        <h2 className="section-h">Reservas aguardando aprovação ({res.length})</h2>
        {res.length === 0 ? (
          <div className="card empty">Nenhuma reserva para aprovar.</div>
        ) : (
          <div className="pending-list">
            {res.map((r) => (
              <div className="pending-item" key={r.id}>
                <span className="tag tag-warn">RESERVA</span>
                <div className="grow">
                  <div className="title">
                    {r.quantity}× {prettyName(r.productDescription)} {r.variantLabel !== "Único" ? r.variantLabel : ""} · em nome de <b>{r.customerName}</b>
                  </div>
                  <div className="desc">
                    {money(r.unitPrice * r.quantity)} · pedido às {listTime(r.createdAt)}
                  </div>
                  {customerInfo(r) && <div className={`desc cust-${customerInfo(r)!.tone}`}>{customerInfo(r)!.text}</div>}
                  <CustomerChoice r={r} value={choices[r.id]} onChange={(c) => setChoices((p) => ({ ...p, [r.id]: c }))} />
                </div>
                <div className="btn-row">
                  <button className="btn sm" onClick={() => onOpenConversation(r.conversationId)}>
                    Ver conversa
                  </button>
                  <button className="btn sm danger" disabled={busy === r.id} onClick={() => act(r.id, api.rejectReservation)}>
                    Recusar
                  </button>
                  <button
                    className="btn sm primary"
                    disabled={busy === r.id || needsChoice(r, choices[r.id])}
                    onClick={() => act(r.id, (id) => api.approveReservation(id, choices[r.id]))}
                  >
                    {approveLabel(r)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
