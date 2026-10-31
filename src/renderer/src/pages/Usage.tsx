import { useEffect, useState } from "react";
import type { AuditEntry, UsageSummary } from "../../../shared/types";
import { api } from "../lib/api";
import { formatPhone, usd } from "../lib/format";

// Nomes gravados pelo processo principal (src/main/engine/identity.ts e src/main/ai/tools.ts).
const ACTION_LABEL: Record<string, string> = {
  consulta_contas: "Consulta de contas",
  identificacao_telefone: "Identificação pelo telefone",
  identificacao_cpf: "CPF informado · aguardando data de nascimento",
  identificacao_cpf_telefone: "Identificação por CPF + telefone",
  identificacao_cpf_nascimento: "Identificação por CPF + data de nascimento",
  identificacao_cpf_numero_diferente: "CPF informado de outro número",
  identificacao_falhou: "Identificação não confirmada",
  identificacao_bloqueada: "Consulta bloqueada por tentativas",
};

function Stat({ label, value, foot, cls }: { label: string; value: string; foot?: string; cls?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${cls ?? ""}`}>{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

export function UsagePage({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [u, setU] = useState<UsageSummary | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  useEffect(() => {
    void api.getUsage().then(setU);
    void api.listAudit(50).then(setAudit);
  }, []);
  if (!u) return <div className="page"><div className="page-pad">Carregando…</div></div>;

  const over = u.monthlyAlertUsd > 0 && u.month.costUsd >= u.monthlyAlertUsd;
  const pct = u.monthlyAlertUsd > 0 ? Math.min(100, (u.month.costUsd / u.monthlyAlertUsd) * 100) : 0;
  const max = Math.max(1, ...u.byDay.map((d) => d.aiReplies + d.humanReplies));

  return (
    <div className="page">
      <div className="page-pad">
        <h1 className="page-title">Consumo</h1>
        <p className="page-sub">
          Quantas respostas a IA deu e quanto isso custou na sua conta da OpenAI. Os valores são estimados neste
          computador; o valor oficial está no site da OpenAI.
        </p>
        {over && (
          <div className="callout" role="alert" style={{ marginBottom: 16 }}>
            O gasto estimado deste mês ({usd(u.month.costUsd)}) passou do seu alerta de {usd(u.monthlyAlertUsd)}.{" "}
            <button className="ext-link" onClick={onOpenGuide}>
              Ver como adicionar créditos
            </button>
          </div>
        )}
        <h2 className="section-h" style={{ marginTop: 0 }}>Hoje</h2>
        <div className="stats">
          <Stat label="Respostas da IA" value={String(u.today.aiReplies)} cls="ia" />
          <Stat label="Respostas humanas" value={String(u.today.humanReplies)} cls="human" />
          <Stat label="Custo estimado" value={usd(u.today.costUsd)} />
          <Stat label="Áudios transcritos" value={`${Math.round(u.today.transcriptionSeconds / 60)} min`} />
        </div>
        <h2 className="section-h">Este mês</h2>
        <div className="stats">
          <Stat label="Respostas da IA" value={String(u.month.aiReplies)} cls="ia" />
          <Stat label="Respostas humanas" value={String(u.month.humanReplies)} cls="human" />
          <div className="stat">
            <div className="stat-label">Custo estimado</div>
            <div className="stat-value">{usd(u.month.costUsd)}</div>
            {u.monthlyAlertUsd > 0 && (
              <>
                <div className={`month-meter ${over ? "over" : ""}`} aria-hidden="true">
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="stat-foot">alerta em {usd(u.monthlyAlertUsd)}</div>
              </>
            )}
          </div>
          <Stat
            label="Áudios transcritos"
            value={`${Math.round(u.month.transcriptionSeconds / 60)} min`}
            foot={`${(u.month.inputTokens + u.month.outputTokens).toLocaleString("pt-BR")} tokens`}
          />
        </div>
        <div className="card">
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <div className="card-title">Respostas por dia</div>
            <div className="legend">
              <span>
                <i style={{ background: "var(--ia)" }} />
                IA
              </span>
              <span>
                <i style={{ background: "#57b58f" }} />
                Humano
              </span>
            </div>
          </div>
          <div className="bars" role="img" aria-label="Gráfico de respostas por dia nos últimos dias">
            {u.byDay.map((d) => {
              const total = d.aiReplies + d.humanReplies;
              return (
                <div className="bar-col" key={d.day} title={`${d.day}: ${d.aiReplies} IA, ${d.humanReplies} humanas, ${usd(d.costUsd)}`}>
                  <div className="bar-stack">
                    <div className="bar-ia" style={{ height: `${(d.aiReplies / max) * 100}%`, borderRadius: d.humanReplies ? "4px 4px 0 0" : 4 }} />
                    <div className="bar-human" style={{ height: `${(d.humanReplies / max) * 100}%` }} />
                  </div>
                  <span className="bar-day">{d.day.slice(8, 10)}/{d.day.slice(5, 7)}</span>
                  <span className="sr-only">{total} respostas</span>
                </div>
              );
            })}
          </div>
        </div>
        <h2 className="section-h">Consultas sensíveis registradas</h2>
        <p className="page-sub" style={{ marginBottom: 10 }}>
          Toda consulta de conta de cliente fica registrada aqui, para você conferir quem consultou o quê.
        </p>
        {audit.length === 0 ? (
          <div className="card empty">Nenhuma consulta registrada.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Número</th>
                  <th>Ação</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td>{new Date(a.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                    <td>{formatPhone(a.phone)}</td>
                    <td>{ACTION_LABEL[a.action] ?? a.action}</td>
                    <td>{a.result}</td>
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
