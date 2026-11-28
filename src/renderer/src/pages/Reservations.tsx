import { useEffect, useState, type ReactNode } from "react";
import { IconAlert, IconBag, IconBan, IconChat, IconCheck, IconCheckCheck, IconClock, IconTrash, IconX } from "../components/Icons";
import { EmptyState, PageTitle } from "../components/PageTitle";
import type { Reservation, ReservationStatus } from "../../../shared/types";
import { api } from "../lib/api";
import { money } from "../lib/format";
import { prettyName } from "../../../shared/format";
import { approveLabel, customerInfo } from "../lib/reservation";
import { type Choice, CustomerChoice, needsChoice } from "../components/CustomerChoice";

const STATUS: Record<ReservationStatus, { label: string; cls: string; icon: ReactNode }> = {
  pending_approval: { label: "Aguardando aprovação", cls: "tag-warn", icon: <IconClock size={11} /> },
  created: { label: "Rascunho criado", cls: "tag-ok", icon: <IconCheck size={11} /> },
  failed: { label: "Falhou", cls: "tag-fail", icon: <IconAlert size={11} /> },
  rejected: { label: "Recusada", cls: "tag-ignored", icon: <IconBan size={11} /> },
  expired: { label: "Vencida", cls: "tag-ignored", icon: <IconClock size={11} /> },
  completed: { label: "Finalizada", cls: "tag-ok", icon: <IconCheckCheck size={12} /> },
  removed: { label: "Removida", cls: "tag-ignored", icon: <IconTrash size={11} /> },
  cancelled: { label: "Cancelada", cls: "tag-ignored", icon: <IconX size={11} /> },
};

function dt(ts: number) {
  return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ReservationsPage({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const [items, setItems] = useState<Reservation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  useEffect(() => {
    void api.listReservations().then(setItems);
    return api.onReservation((r) =>
      setItems((prev) => {
        const i = prev.findIndex((x) => x.id === r.id);
        if (i === -1) return [r, ...prev];
        const next = prev.slice();
        next[i] = r;
        return next;
      }),
    );
  }, []);

  const act = async (id: string, fn: (id: string) => Promise<Reservation>) => {
    setBusy(id);
    setError(null);
    try {
      const r = await fn(id);
      setItems((prev) => prev.map((x) => (x.id === r.id ? r : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page-pad">
        <PageTitle icon={<IconBag size={20} />}>Reservas</PageTitle>
        <p className="page-sub">
          Produtos que clientes pediram para separar pelo WhatsApp. Cada reserva vira uma venda em rascunho no
          sistema Nive, com a conversa na observação. Se você excluir ou cancelar o rascunho por lá, o cliente é avisado. Se a venda não for finalizada até o fim da validade, o rascunho é cancelado e as peças voltam ao
          estoque.
        </p>
        {error && (
          <div className="callout danger" role="alert">
            <IconAlert size={16} />
            {error}
          </div>
        )}
        {items.length === 0 ? (
          <EmptyState icon={<IconBag size={22} />} title="Nenhuma reserva ainda.">
            As reservas aparecem aqui quando um cliente pede para separar um produto pelo WhatsApp.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Produto</th>
                  <th>Valor</th>
                  <th>Situação</th>
                  <th>Validade</th>
                  <th>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="cell-strong">{r.customerName}</div>
                      {customerInfo(r) && <div className={`sub cust-${customerInfo(r)!.tone}`}>{customerInfo(r)!.text}</div>}
                      {(r.status === "pending_approval" || r.status === "failed") && (
                        <CustomerChoice r={r} value={choices[r.id]} onChange={(c) => setChoices((p) => ({ ...p, [r.id]: c }))} />
                      )}
                      <div className="sub">pedido em {dt(r.createdAt)}</div>
                    </td>
                    <td>
                      <div>
                        {r.quantity}× {prettyName(r.productDescription)}
                      </div>
                      {r.variantLabel !== "Único" && <div className="sub">{r.variantLabel}</div>}
                    </td>
                    <td className="cell-num">{money(r.unitPrice * r.quantity)}</td>
                    <td>
                      <span className={`tag ${STATUS[r.status].cls}`}>
                        {STATUS[r.status].icon}
                        {STATUS[r.status].label}
                      </span>
                      {r.status === "created" && (
                        <div className="sub" style={{ marginTop: 4 }}>
                          {r.orderNumber ? `Pedido #${r.orderNumber}` : "Rascunho no sistema Nive"}
                        </div>
                      )}
                      {(r.status === "completed" || r.status === "removed") && r.orderNumber && (
                        <div className="sub" style={{ marginTop: 4 }}>
                          Pedido #{r.orderNumber}
                        </div>
                      )}
                      {r.status === "removed" && <div className="sub">Excluída ou cancelada no sistema Nive</div>}
                      {r.status === "failed" && r.error && (
                        <div className="sub" style={{ marginTop: 4, color: "var(--red-text)" }}>
                          {r.error}
                        </div>
                      )}
                    </td>
                    <td>{dt(r.expiresAt)}</td>
                    <td>
                      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                        <button className="btn sm" onClick={() => onOpenConversation(r.conversationId)}>
                          <IconChat size={14} />
                          Conversa
                        </button>
                        {r.status === "created" &&
                          (confirmCancel === r.id ? (
                            <>
                              <button className="btn sm" disabled={busy === r.id} onClick={() => setConfirmCancel(null)}>
                                Voltar
                              </button>
                              <button
                                className="btn sm danger"
                                disabled={busy === r.id}
                                onClick={() => {
                                  setConfirmCancel(null);
                                  void act(r.id, api.cancelReservation);
                                }}
                              >
                                {busy === r.id ? "Cancelando…" : "Confirmar: cancelar rascunho"}
                              </button>
                            </>
                          ) : (
                            <button className="btn sm danger" disabled={busy === r.id} onClick={() => setConfirmCancel(r.id)}>
                              <IconX size={14} />
                              Cancelar reserva
                            </button>
                          ))}
                        {(r.status === "pending_approval" || r.status === "failed") && (
                          <>
                            <button
                              className="btn sm danger"
                              disabled={busy === r.id}
                              onClick={() => act(r.id, api.rejectReservation)}
                            >
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
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
