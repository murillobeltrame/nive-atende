import { useEffect, useState, type ReactNode } from "react";
import { IconAlert, IconBag, IconCalendar, IconChart, IconChat, IconClock, IconMic, IconShield, IconSpark, IconUser, IconWallet } from "../components/Icons";
import { EmptyState, PageTitle, SectionTitle } from "../components/PageTitle";
import type { AuditEntry, DailySummary, UsageSummary } from "../../../shared/types";
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

function Stat({ label, value, foot, cls, icon }: { label: string; value: string; foot?: string; cls?: string; icon: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">
        <span className={`stat-icon ${cls ?? ""}`} aria-hidden="true">
          {icon}
        </span>
        {label}
      </div>
      <div className={`stat-value ${cls ?? ""}`}>{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

export function UsagePage({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [u, setU] = useState<UsageSummary | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  useEffect(() => {
    void api.getDailySummary().then(setSummary).catch(() => undefined);
    void api.getUsage().then(setU);
    void api.listAudit(50).then(setAudit);
  }, []);
  if (!u)
    return (
      <div className="page">
        <div className="page-pad">
          <div className="empty" role="status">
            <span className="spinner" aria-hidden="true" />
            Carregando consumo…
          </div>
        </div>
      </div>
    );

  const over = u.monthlyAlertUsd > 0 && u.month.costUsd >= u.monthlyAlertUsd;
  const pct = u.monthlyAlertUsd > 0 ? Math.min(100, (u.month.costUsd / u.monthlyAlertUsd) * 100) : 0;
  const max = Math.max(1, ...u.byDay.map((d) => d.aiReplies + d.humanReplies));

  return (
    <div className="page">
      <div className="page-pad">
        <PageTitle icon={<IconChart size={20} />}>Consumo</PageTitle>
        <p className="page-sub">
          Quantas respostas a IA deu e quanto isso custou na sua conta da plataforma de IA. Os valores são estimados neste
          computador; o valor oficial está no site da plataforma (OpenAI, Anthropic ou Google).
        </p>
        {over && (
          <div className="callout" role="alert">
            <IconAlert size={16} />
            <span>
            O gasto estimado deste mês ({usd(u.month.costUsd)}) passou do seu alerta de {usd(u.monthlyAlertUsd)}.{" "}
            <button className="ext-link" onClick={onOpenGuide}>
              Ver como adicionar créditos
            </button>
            </span>
          </div>
        )}
        {summary && (
          <div className="card day-summary">
            <h2 className="card-title">
              <IconCalendar size={17} />
              Resumo de hoje
            </h2>
            <ul>
              <li>
                <IconChat size={15} />
                <span>
                <b>{summary.conversations}</b> conversa(s) com clientes ({summary.newContacts} novo(s))
                </span>
              </li>
              <li>
                <IconBag size={15} />
                <span>
                <b>{summary.reservationsCreated}</b> reserva(s) pedida(s) hoje
                {summary.reservationsPending ? ` · ${summary.reservationsPending} aguardando sua aprovação` : ""}
                </span>
              </li>
              <li className={summary.unanswered ? "warn" : ""}>
                <IconAlert size={15} />
                <span>
                  <b>{summary.unanswered}</b> conversa(s) esperando resposta
                </span>
              </li>
              <li>
                <IconClock size={15} />
                <span>
                  <b>{summary.waitlist}</b> cliente(s) esperando produto chegar
                </span>
              </li>
            </ul>
          </div>
        )}
        <SectionTitle icon={<IconClock size={17} />}>Hoje</SectionTitle>
        <div className="stats">
          <Stat icon={<IconSpark size={15} />} label="Respostas da IA" value={String(u.today.aiReplies)} cls="ia" />
          <Stat icon={<IconUser size={15} />} label="Respostas humanas" value={String(u.today.humanReplies)} cls="human" />
          <Stat icon={<IconWallet size={15} />} label="Custo estimado" value={usd(u.today.costUsd)} />
          <Stat icon={<IconMic size={15} />} label="Áudios transcritos" value={`${Math.round(u.today.transcriptionSeconds / 60)} min`} />
        </div>
        <SectionTitle icon={<IconCalendar size={17} />}>Este mês</SectionTitle>
        <div className="stats">
          <Stat icon={<IconSpark size={15} />} label="Respostas da IA" value={String(u.month.aiReplies)} cls="ia" />
          <Stat icon={<IconUser size={15} />} label="Respostas humanas" value={String(u.month.humanReplies)} cls="human" />
          <div className="stat">
            <div className="stat-label">
              <span className="stat-icon" aria-hidden="true">
                <IconWallet size={15} />
              </span>
              Custo estimado
            </div>
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
            icon={<IconMic size={15} />}
            label="Áudios transcritos"
            value={`${Math.round(u.month.transcriptionSeconds / 60)} min`}
            foot={`${(u.month.inputTokens + u.month.outputTokens).toLocaleString("pt-BR")} tokens`}
          />
        </div>
        <div className="card">
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <div className="card-title">
              <IconChart size={17} />
              Respostas por dia
            </div>
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
        <SectionTitle icon={<IconShield size={17} />}>Consultas sensíveis registradas</SectionTitle>
        <p className="page-sub section-sub">
          Toda consulta de conta de cliente fica registrada aqui, para você conferir quem consultou o quê.
        </p>
        {audit.length === 0 ? (
          <EmptyState icon={<IconShield size={22} />} title="Nenhuma consulta registrada." />
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
