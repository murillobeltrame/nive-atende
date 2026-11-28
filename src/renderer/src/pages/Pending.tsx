import { useEffect, useState } from "react";
import { approveLabel, customerInfo } from "../lib/reservation";
import { type Choice, CustomerChoice, needsChoice } from "../components/CustomerChoice";
import { prettyName } from "../../../shared/format";
import type { Conversation, Reservation } from "../../../shared/types";
import { api } from "../lib/api";
import { conversationName, listTime, money, waitingSince } from "../lib/format";
import { IconAlert, IconBag, IconChat, IconCheck, IconClock, IconInbox, IconX } from "../components/Icons";
import { EmptyState, PageTitle, SectionTitle } from "../components/PageTitle";

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

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

  // "há 5 min" precisa andar sozinho
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const resolve = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.returnToAi(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setBusy(null);
    }
  };

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
        <PageTitle icon={<IconInbox size={20} />}>Pendências</PageTitle>
        <p className="page-sub">O que precisa de você agora: conversas que a IA passou para a loja e reservas para aprovar.</p>
        {error && (
          <div className="callout danger" role="alert">
            <IconAlert size={16} />
            {error}
          </div>
        )}
        <SectionTitle icon={<IconChat size={17} />} count={convs.length}>
          Conversas que precisam de você
        </SectionTitle>
        {convs.length === 0 ? (
          <EmptyState icon={<IconCheck size={22} />} title="Nenhuma conversa esperando por você.">
            Quando a IA não souber responder, ou o cliente pedir para falar com uma pessoa, a conversa aparece aqui.
          </EmptyState>
        ) : (
          <div className="pending-list">
            {convs.map((c) => (
              <div className="pending-item" key={c.id}>
                <span className="pending-icon need" aria-hidden="true">
                  <IconChat size={18} />
                </span>
                <div className="grow">
                  <div className="title">
                    {c.customerName ?? conversationName(c)}
                    <span className="pending-wait" title={new Date(c.lastMessageAt).toLocaleString("pt-BR")}>
                      <IconClock size={13} />
                      esperando {waitingSince(c.lastMessageAt)}
                    </span>
                  </div>
                  <div className="desc">
                    <span className="tag tag-need">{capitalize(c.handoffReason ?? "a IA passou para humano")}</span>
                    {c.lastPreview ? <span className="pending-preview">“{c.lastPreview}”</span> : null}
                  </div>
                </div>
                <div className="btn-row">
                  <button
                    className="btn sm"
                    disabled={busy === c.id}
                    title="Tira da lista. A IA volta a responder este cliente na próxima mensagem."
                    onClick={() => void resolve(c.id)}
                  >
                    <IconCheck size={14} />
                    Marcar como resolvida
                  </button>
                  <button className="btn sm primary" onClick={() => onOpenConversation(c.id)}>
                    <IconChat size={14} />
                    Abrir conversa
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <SectionTitle icon={<IconBag size={17} />} count={res.length}>
          Reservas aguardando aprovação
        </SectionTitle>
        {res.length === 0 ? (
          <EmptyState icon={<IconBag size={22} />} title="Nenhuma reserva para aprovar.">
            Quando um cliente pedir para separar um produto pelo WhatsApp, o pedido aparece aqui para você aprovar ou recusar.
          </EmptyState>
        ) : (
          <div className="pending-list">
            {res.map((r) => (
              <div className="pending-item" key={r.id}>
                <span className="pending-icon warn" aria-hidden="true">
                  <IconBag size={18} />
                </span>
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
                    <IconChat size={14} />
                    Ver conversa
                  </button>
                  <button className="btn sm danger" disabled={busy === r.id} onClick={() => act(r.id, api.rejectReservation)}>
                    <IconX size={14} />
                    Recusar
                  </button>
                  <button
                    className="btn sm primary"
                    disabled={busy === r.id || needsChoice(r, choices[r.id])}
                    onClick={() => act(r.id, (id) => api.approveReservation(id, choices[r.id]))}
                  >
                    <IconCheck size={14} />
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
