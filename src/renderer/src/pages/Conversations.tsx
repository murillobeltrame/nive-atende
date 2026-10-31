import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, ChatMessage, Conversation, ConversationFilter } from "../../../shared/types";
import { Composer } from "../components/Composer";
import { IconCheck, IconSearch, IconShield, IconSpark, IconUser } from "../components/Icons";
import { MessageBubble } from "../components/MessageBubble";
import { StateTag } from "../components/Tag";
import { api } from "../lib/api";
import { auxLine, avatarColors, initials, listTime, maskPhone, previewPrefix, usd } from "../lib/format";

interface Props {
  filter: ConversationFilter;
  onFilter: (f: ConversationFilter) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  settings: AppSettings | null;
  onOpenSettings: (section: string) => void;
  onConnectWhatsapp: () => void;
  needsHumanCount: number;
  whatsappOk: boolean;
}

function Avatar({ name, seed, small }: { name: string; seed: string; small?: boolean }) {
  const [bg, fg] = avatarColors(seed);
  return (
    <div className={`avatar ${small ? "sm" : ""}`} style={{ background: bg, color: fg }} aria-hidden="true">
      {initials(name)}
    </div>
  );
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Hoje";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
}

function SetupChecklist({
  settings,
  whatsappOk,
  onOpenSettings,
  onConnectWhatsapp,
}: {
  settings: AppSettings;
  whatsappOk: boolean;
  onOpenSettings: (s: string) => void;
  onConnectWhatsapp: () => void;
}) {
  const steps = [
    {
      done: settings.nive.hasApiKey && !!settings.nive.storeSlug,
      title: "Conectar ao sistema Nive",
      desc: "Gere uma chave de API no ERP da Nive e cole aqui com o identificador da loja.",
      action: () => onOpenSettings("conexoes"),
      label: "Configurar",
    },
    {
      done: settings.openai.hasApiKey,
      title: "Configurar a inteligência artificial",
      desc: "Crie uma conta na OpenAI, adicione créditos e cole a chave. O passo a passo está na tela.",
      action: () => onOpenSettings("ia"),
      label: "Ver passo a passo",
    },
    {
      done: settings.evolution.mode !== "evolution" || settings.evolution.hasApiKey,
      title: "Configurar o servidor Evolution",
      desc: "Você escolheu usar um servidor Evolution externo: informe o endereço e a chave dele. (Com o WhatsApp dentro do programa este passo não é necessário.)",
      action: () => onOpenSettings("conexoes"),
      label: "Configurar",
    },
    {
      done: whatsappOk,
      title: "Conectar o WhatsApp da loja",
      desc: "Leia o QR Code com o celular da loja, igual ao WhatsApp Web.",
      action: onConnectWhatsapp,
      label: "Conectar",
    },
  ];
  const total = steps.filter((s) => s.done).length;
  return (
    <div className="chat-empty">
      <div className="setup-card">
        <div>
          <h2 className="card-title" style={{ fontSize: 18 }}>
            Vamos deixar o atendimento pronto
          </h2>
          <p className="card-sub" style={{ marginBottom: 0 }}>
            {total} de {steps.length} etapas concluídas.
          </p>
        </div>
        {steps.map((s) => (
          <div key={s.title} className={`setup-step ${s.done ? "done" : ""}`}>
            <span className="setup-check" aria-hidden="true">
              {s.done && <IconCheck size={14} />}
            </span>
            <div className="setup-step-text">
              <b>
                {s.title}
                <span className="sr-only">{s.done ? " (concluída)" : " (pendente)"}</span>
              </b>
              <span>{s.desc}</span>
            </div>
            {!s.done && (
              <button className="btn sm primary" onClick={s.action}>
                {s.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ClientPanel({ c }: { c: Conversation }) {
  return (
    <aside className="client-panel" aria-label="Dados do cliente">
      <div className="stack" style={{ gap: 6 }}>
        <span className="panel-label">Cliente</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{c.customerName ?? c.displayName}</span>
        {c.verifiedBy ? (
          <span className="verified">
            <IconShield size={15} />
            Verificado pelo {c.verifiedBy === "phone" ? "telefone" : "CPF"}
          </span>
        ) : (
          <span className="unverified">Não identificado no cadastro</span>
        )}
        <span style={{ color: "var(--muted)" }}>{maskPhone(c.phone)}</span>
      </div>
      <div className="panel-sep" />
      <div className="stack" style={{ gap: 9 }}>
        <span className="panel-label">O que a IA fez</span>
        {c.lastAiActions.length === 0 ? (
          <span className="unverified">Nada ainda nesta conversa.</span>
        ) : (
          <ol className="ai-steps">
            {c.lastAiActions.map((a, i) => (
              <li key={`${a.at}-${i}`} className={a.kind}>
                <span className="n">{i + 1}</span>
                <span>{a.label}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="panel-sep" />
      <div className="stack" style={{ gap: 6 }}>
        <span className="panel-label">Nesta conversa</span>
        <div className="kv">
          <span>Respostas da IA</span>
          <b style={{ color: "var(--ia)" }}>{c.aiRepliesCount}</b>
        </div>
        <div className="kv">
          <span>Respostas humanas</span>
          <b style={{ color: "var(--human)" }}>{c.humanRepliesCount}</b>
        </div>
        <div className="kv">
          <span>Custo de IA</span>
          <b>{usd(c.costUsd)}</b>
        </div>
      </div>
    </aside>
  );
}

function ChatView({ conversation }: { conversation: Conversation }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getMessages(conversation.id)
      .then((ms) => {
        if (alive) setMessages(ms);
      })
      .finally(() => alive && setLoading(false));
    void api.markRead(conversation.id);
    const off = api.onMessage((m) => {
      if (m.conversationId !== conversation.id) return;
      setMessages((prev) => {
        const i = prev.findIndex((x) => x.id === m.id);
        if (i === -1) return [...prev, m];
        const next = prev.slice();
        next[i] = m;
        return next;
      });
      void api.markRead(conversation.id);
    });
    return () => {
      alive = false;
      off();
    };
  }, [conversation.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, conversation.id]);

  const sorted = useMemo(() => [...messages].sort((a, b) => a.createdAt - b.createdAt), [messages]);

  const toggleOwner = async () => {
    setBusy(true);
    try {
      if (humanMode) await api.returnToAi(conversation.id);
      else await api.takeOver(conversation.id);
    } finally {
      setBusy(false);
    }
  };
  const humanMode =
    conversation.state === "humano" || (conversation.aiPausedUntil !== null && conversation.aiPausedUntil > Date.now());

  const ident = conversation.verifiedBy
    ? `cliente identificado pelo ${conversation.verifiedBy === "phone" ? "telefone" : "CPF"}`
    : "não identificado";

  let lastDay = "";
  return (
    <section className="chat" aria-label={`Conversa com ${conversation.displayName}`}>
      <header className="chat-head">
        <div className="chat-head-id">
          <Avatar name={conversation.displayName} seed={conversation.displayName} small />
          <div style={{ minWidth: 0 }}>
            <div className="chat-head-name">{conversation.displayName}</div>
            <div className="chat-head-sub">
              {maskPhone(conversation.phone)} · {ident}
            </div>
          </div>
        </div>
        {conversation.state !== "ignorado" &&
          (humanMode ? (
            <button className="btn-ia" onClick={toggleOwner} disabled={busy}>
              <IconSpark size={14} />
              Devolver para a IA
            </button>
          ) : (
            <button className="btn-human" onClick={toggleOwner} disabled={busy}>
              <IconUser size={14} />
              Assumir conversa
            </button>
          ))}
      </header>
      <div className="messages" ref={listRef} aria-live="polite" aria-busy={loading}>
        {loading && sorted.length === 0 && <div className="empty">Carregando mensagens…</div>}
        {sorted.map((m) => {
          const day = dayLabel(m.createdAt);
          const sep = day !== lastDay;
          lastDay = day;
          return (
            <Fragment key={m.id}>
              {sep && <div className="day-sep">{day}</div>}
              <MessageBubble
                m={m}
                onResendSticker={
                  m.origin === "consumidor" && m.kind === "sticker"
                    ? (id) => void api.resendSticker(conversation.id, id)
                    : undefined
                }
              />
            </Fragment>
          );
        })}
        <div ref={endRef} />
      </div>
      <Composer conversation={conversation} />
    </section>
  );
}

export function ConversationsPage({
  filter,
  onFilter,
  selectedId,
  onSelect,
  settings,
  onOpenSettings,
  onConnectWhatsapp,
  needsHumanCount,
  whatsappOk,
}: Props) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [, setTick] = useState(0);

  const reload = useCallback(async () => {
    const list = await api.listConversations(filter, q);
    setItems(list);
    setLoaded(true);
  }, [filter, q]);

  useEffect(() => {
    const t = setTimeout(() => void reload(), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [reload, q]);

  useEffect(() => {
    const off = api.onConversation((c) => {
      setItems((prev) => {
        const matches =
          filter === "todas" ||
          (filter === "precisa" && c.state === "precisa_humano") ||
          (filter === "ia" && c.state === "ia") ||
          (filter === "humano" && c.state === "humano");
        const without = prev.filter((x) => x.id !== c.id);
        const term = q.trim().toLowerCase();
        const termOk = !term || c.displayName.toLowerCase().includes(term) || c.phone.includes(term);
        const next = matches && termOk ? [c, ...without] : without;
        return next.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      });
    });
    const tick = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [filter, q]);

  const [selected, setSelected] = useState<Conversation | null>(null);
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const inList = items.find((c) => c.id === selectedId);
    if (inList) setSelected(inList);
    else void api.getConversation(selectedId).then((c) => setSelected(c));
  }, [selectedId, items]);

  useEffect(() => {
    const off = api.onConversation((c) => {
      setSelected((cur) => (cur && cur.id === c.id ? c : cur));
    });
    return off;
  }, []);

  const needsSetup =
    settings &&
    (!settings.nive.hasApiKey || !settings.openai.hasApiKey || (settings.evolution.mode === "evolution" && !settings.evolution.hasApiKey) || !whatsappOk);

  const chips: Array<{ f: ConversationFilter; label: string; cls?: string }> = [
    { f: "todas", label: "Todas" },
    { f: "precisa", label: `Precisam de você${needsHumanCount ? ` · ${needsHumanCount}` : ""}`, cls: "chip-need" },
    { f: "ia", label: "IA" },
    { f: "humano", label: "Humano" },
  ];

  return (
    <div className="inbox">
      <div className="conv-list">
        <div className="conv-list-head">
          <label className="search">
            <IconSearch size={16} />
            <span className="sr-only">Buscar conversa</span>
            <input placeholder="Buscar conversa" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="filters" role="group" aria-label="Filtrar conversas">
            {chips.map((c) => (
              <button
                key={c.f}
                className={`chip ${c.cls ?? ""}`}
                aria-pressed={filter === c.f}
                onClick={() => onFilter(c.f)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <ul className="conv-items" aria-label="Conversas">
          {loaded && items.length === 0 && (
            <li className="empty">
              {q ? "Nenhuma conversa encontrada." : filter === "precisa" ? "Nada esperando por você." : "Nenhuma conversa ainda."}
            </li>
          )}
          {items.map((c) => {
            const hot = c.state === "precisa_humano";
            return (
              <li key={c.id}>
                <button
                  className={`conv-item ${c.state === "ignorado" ? "ignored" : ""}`}
                  aria-current={selectedId === c.id ? "true" : undefined}
                  onClick={() => onSelect(c.id)}
                >
                  <Avatar name={c.displayName} seed={c.displayName} />
                  <div className="conv-body">
                    <div className="conv-row">
                      <span className="conv-name">{c.displayName}</span>
                      <span className={`conv-time ${hot ? "hot" : ""}`}>{listTime(c.lastMessageAt)}</span>
                    </div>
                    <div className="conv-preview">
                      {previewPrefix(c.lastOrigin)}
                      {c.lastPreview}
                    </div>
                    <div className="conv-meta">
                      <StateTag state={c.state} />
                      <span className="conv-aux">{auxLine(c)}</span>
                      {c.unread > 0 && (
                        <span className="unread" aria-label={`${c.unread} não lidas`}>
                          {c.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {selected ? (
        <>
          <ChatView conversation={selected} />
          <ClientPanel c={selected} />
        </>
      ) : needsSetup && settings ? (
        <SetupChecklist
          settings={settings}
          whatsappOk={whatsappOk}
          onOpenSettings={onOpenSettings}
          onConnectWhatsapp={onConnectWhatsapp}
        />
      ) : (
        <div className="chat-empty">
          <div className="empty">Escolha uma conversa na lista para ver as mensagens.</div>
        </div>
      )}
    </div>
  );
}
