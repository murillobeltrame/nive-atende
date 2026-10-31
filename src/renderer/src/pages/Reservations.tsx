import { useEffect, useState } from "react";
import type { Reservation, ReservationStatus } from "../../../shared/types";
import { api } from "../lib/api";
import { money } from "../lib/format";
import { prettyName } from "../../../shared/format";
import { approveLabel, customerInfo } from "../lib/reservation";

const STATUS: Record<ReservationStatus, { label: string; cls: string }> = {
  pending_approval: { label: "Aguardando aprovação", cls: "tag-warn" },
  created: { label: "Rascunho criado", cls: "tag-ok" },
  failed: { label: "Falhou", cls: "tag-fail" },
  rejected: { label: "Recusada", cls: "tag-ignored" },
  expired: { label: "Vencida", cls: "tag-ignored" },
  completed: { label: "Finalizada", cls: "tag-ok" },
  removed: { label: "Removida", cls: "tag-ignored" },
};

function dt(ts: number) {
  return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ReservationsPage({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const [items, setItems] = useState<Reservation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page-pad">
        <h1 className="page-title">Reservas</h1>
        <p className="page-sub">
          Produtos que clientes pediram para separar pelo WhatsApp. Cada reserva aprovada vira uma venda em rascunho no
          sistema Nive. Se a venda não for finalizada até o fim da validade, o rascunho é cancelado e as peças voltam ao
          estoque.
        </p>
        {error && (
          <div className="callout danger" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        {items.length === 0 ? (
          <div className="card empty">Nenhuma reserva ainda.</div>
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
                      <div>{r.customerName}</div>
                      {customerInfo(r) && <div className={`sub cust-${customerInfo(r)!.tone}`}>{customerInfo(r)!.text}</div>}
                      <div className="sub">pedido em {dt(r.createdAt)}</div>
                    </td>
                    <td>
                      <div>
                        {r.quantity}× {prettyName(r.productDescription)}
                      </div>
                      {r.variantLabel !== "Único" && <div className="sub">{r.variantLabel}</div>}
                    </td>
                    <td>{money(r.unitPrice * r.quantity)}</td>
                    <td>
                      <span className={`tag ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
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
                          Conversa
                        </button>
                        {(r.status === "pending_approval" || r.status === "failed") && (
                          <>
                            <button
                              className="btn sm danger"
                              disabled={busy === r.id}
                              onClick={() => act(r.id, api.rejectReservation)}
                            >
                              Recusar
                            </button>
                            <button
                              className="btn sm primary"
                              disabled={busy === r.id}
                              onClick={() => act(r.id, api.approveReservation)}
                            >
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
