import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, ChatMessage, Conversation, ConversationFilter } from "../../../shared/types";
import { aiConfigured } from "../../../shared/ai-catalog";
import { Composer } from "../components/Composer";
import { IconCheck, IconPencil, IconSearch, IconShield, IconSpark, IconTrash, IconUser, IconX } from "../components/Icons";
import { MessageBubble } from "../components/MessageBubble";
import { StateTag } from "../components/Tag";
import { api } from "../lib/api";
import { auxLine, avatarColors, conversationName, formatPhone, initials, listTime, previewPrefix, usd } from "../lib/format";

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

const avatarCache = new Map<string, string | null>();

type TypingState = "composing" | "recording";

/**
 * Quem está digitando/gravando agora. O WhatsApp nem sempre avisa que parou, então cada aviso
 * vale por alguns segundos; uma mensagem nova do cliente também encerra.
 */
function useTyping(): Record<string, TypingState> {
  const [map, setMap] = useState<Record<string, TypingState>>({});
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const clear = (id: string) => {
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.delete(id);
      setMap((m) => {
        if (!(id in m)) return m;
        const next = { ...m };
        delete next[id];
        return next;
      });
    };
    const offTyping = api.onTyping(({ conversationId, state }) => {
      if (!state) return clear(conversationId);
      const t = timers.get(conversationId);
      if (t) clearTimeout(t);
      timers.set(conversationId, setTimeout(() => clear(conversationId), state === "recording" ? 35_000 : 15_000));
      setMap((m) => (m[conversationId] === state ? m : { ...m, [conversationId]: state }));
    });
    const offMsg = api.onMessage((m) => {
      if (m.origin === "consumidor") clear(m.conversationId);
    });
    return () => {
      offTyping();
      offMsg();
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);
  return map;
}

const typingLabel = (s: TypingState) => (s === "recording" ? "gravando áudio…" : "digitando…");

/** Foto de perfil pública do contato; sem foto, as iniciais. */
function Avatar({ name, seed, small, conversationId }: { name: string; seed: string; small?: boolean; conversationId?: string }) {
  const [bg, fg] = avatarColors(seed);
  const [photo, setPhoto] = useState<string | null>(conversationId ? (avatarCache.get(conversationId) ?? null) : null);
  useEffect(() => {
    if (!conversationId) return;
    if (avatarCache.has(conversationId)) {
      setPhoto(avatarCache.get(conversationId) ?? null);
      return;
    }
    let alive = true;
    void api
      .getAvatar(conversationId)
      .then((url) => {
        avatarCache.set(conversationId, url);
        if (alive) setPhoto(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [conversationId]);
  if (photo)
    return <img className={`avatar avatar-photo ${small ? "sm" : ""}`} src={photo} alt="" aria-hidden="true" onError={() => setPhoto(null)} />;
  const isNumber = /^\+?[\d\s()-]+$/.test(name.trim());
  return (
    <div className={`avatar ${small ? "sm" : ""}`} style={{ background: bg, color: fg }} aria-hidden="true">
      {isNumber ? <IconUser size={small ? 18 : 20} /> : initials(name)}
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
      done: aiConfigured(settings),
      title: "Configurar a inteligência artificial",
      desc: "Escolha a plataforma (OpenAI, Claude ou Gemini), adicione créditos e cole a chave. O passo a passo está na tela.",
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

/** Preferências que a IA lembra deste cliente (o lojista pode apagar). */
function CustomerNotes({ c }: { c: Conversation }) {
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => {
    void api.getCustomerNotes(c.id).then(setNotes).catch(() => setNotes([]));
  }, [c.id, c.lastAiActions.length]);
  if (!notes.length) return null;
  return (
    <>
      <div className="panel-sep" />
      <div className="stack" style={{ gap: 6 }}>
        <span className="panel-label">A IA lembra</span>
        <ul className="notes">
          {notes.map((n) => (
            <li key={n}>
              <span>{n}</span>
              <button
                className="icon-btn sm"
                aria-label={`Esquecer: ${n}`}
                title="Esquecer"
                onClick={() => void api.removeCustomerNote(c.id, n).then(setNotes)}
              >
                <IconX size={12} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** "Apagar conversa", com confirmação. Apaga só no app; o WhatsApp do celular continua igual. */
function DeleteConversation({ c }: { c: Conversation }) {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setStep("idle");
    setError(null);
  }, [c.id]);
  const run = async () => {
    setStep("busy");
    setError(null);
    try {
      await api.deleteConversation(c.id);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Não foi possível apagar.");
      setStep("confirm");
    }
  };
  if (step === "idle")
    return (
      <button className="btn sm danger delete-conv" onClick={() => setStep("confirm")}>
        <IconTrash size={14} />
        Apagar conversa
      </button>
    );
  return (
    <div className="delete-confirm" role="alertdialog" aria-label="Confirmar exclusão da conversa">
      <b>Apagar esta conversa?</b>
      <span>
        Some do app com todas as mensagens e fotos. No WhatsApp do celular ela continua. Se o cliente mandar mensagem de novo, começa uma
        conversa nova. Reservas não são apagadas.
      </span>
      {error && <span className="delete-error">{error}</span>}
      <div className="btn-row">
        <button className="btn sm" onClick={() => setStep("idle")} disabled={step === "busy"}>
          Cancelar
        </button>
        <button className="btn sm danger-solid" onClick={() => void run()} disabled={step === "busy"}>
          {step === "busy" ? "Apagando…" : "Apagar"}
        </button>
      </div>
    </div>
  );
}

function ClientPanel({ c }: { c: Conversation }) {
  return (
    <aside className="client-panel" aria-label="Dados do cliente">
      <div className="stack" style={{ gap: 6 }}>
        <span className="panel-label">Cliente</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{c.customerName ?? conversationName(c)}</span>
        {c.verifiedBy ? (
          <span className="verified">
            <IconShield size={15} />
            Verificado pelo {c.verifiedBy === "phone" ? "telefone" : "CPF"}
          </span>
        ) : (
          <span className="unverified">Não identificado no cadastro</span>
        )}
        <span style={{ color: "var(--muted)" }}>{formatPhone(c.phone)}</span>
      </div>
      <CustomerNotes c={c} />
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
      <div className="panel-sep" />
      <DeleteConversation c={c} />
    </aside>
  );
}

function ChatView({ conversation, typing }: { conversation: Conversation; typing?: TypingState }) {
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
  }, [messages.length, conversation.id, !!typing]);

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
    <section className="chat" aria-label={`Conversa com ${conversationName(conversation)}`}>
      <header className="chat-head">
        <div className="chat-head-id">
          <Avatar name={conversation.displayName} seed={conversation.displayName} small conversationId={conversation.id} />
          <ContactHeader conversation={conversation} ident={ident} typing={typing} />
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
        {typing && (
          <div className="customer-typing" role="status">
            <span className="ai-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Cliente {typingLabel(typing)}
          </div>
        )}
        <AiActivity conversationId={conversation.id} />
        <div ref={endRef} />
      </div>
      <Composer conversation={conversation} />
    </section>
  );
}

/** Nome no topo da conversa, com "~nome do perfil" e o botão de renomear/salvar contato. */
function ContactHeader({ conversation, ident, typing }: { conversation: Conversation; ident: string; typing?: TypingState }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [toPhone, setToPhone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setEditing(false);
    setNote(null);
  }, [conversation.id]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);
  const open = () => {
    setName(conversation.savedName ?? conversation.customerName ?? conversation.pushName ?? "");
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.saveContact(conversation.id, name, toPhone);
      setNote(r.message);
      setEditing(false);
    } catch (e) {
      setNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  };
  const showPush = conversation.pushName && conversation.pushName !== conversation.displayName;
  if (editing)
    return (
      <form
        className="contact-edit"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          className="input"
          autoFocus
          value={name}
          maxLength={80}
          placeholder={conversation.pushName ?? "Nome do contato"}
          aria-label="Nome do contato"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        />
        <label className="check-inline">
          <input type="checkbox" checked={toPhone} onChange={(e) => setToPhone(e.target.checked)} />
          Salvar também nos contatos do WhatsApp
        </label>
        <div className="btn-row">
          <button type="button" className="btn sm" onClick={() => setEditing(false)} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn sm primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    );
  return (
    <div style={{ minWidth: 0 }}>
      <div className="chat-head-name">
        {conversationName(conversation)}
        <button className="icon-btn sm rename-btn" onClick={open} aria-label="Renomear e salvar contato" title="Renomear e salvar contato">
          <IconPencil size={14} />
        </button>
      </div>
      <div className="chat-head-sub">
        {typing ? (
          <span className="typing-text">{typingLabel(typing)}</span>
        ) : (
          <>
            {formatPhone(conversation.phone)}
            {showPush && <span className="push-name"> · ~{conversation.pushName}</span>} · {ident}
          </>
        )}
      </div>
      {note && (
        <div className="chat-head-note" role="status">
          {note}
        </div>
      )}
    </div>
  );
}

/** "IA buscando produtos no sistema…" logo abaixo da última mensagem. */
function AiActivity({ conversationId }: { conversationId: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    setLabel(null);
    return api.onActivity((a) => {
      if (a.conversationId === conversationId) setLabel(a.label);
    });
  }, [conversationId]);
  useEffect(() => {
    if (label) document.querySelector(".messages")?.scrollTo({ top: 1e9, behavior: "smooth" });
  }, [label]);
  if (!label) return null;
  return (
    <div className="ai-activity" role="status">
      <span className="ai-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label}
    </div>
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
  const typing = useTyping();

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

  // conversa apagada: sai da lista e, se estava aberta, fecha
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(
    () =>
      api.onConversationDeleted((id) => {
        setItems((prev) => prev.filter((x) => x.id !== id));
        if (selectedRef.current === id) onSelect(null);
      }),
    [onSelect],
  );

  const needsSetup =
    settings &&
    (!settings.nive.hasApiKey || !aiConfigured(settings) || (settings.evolution.mode === "evolution" && !settings.evolution.hasApiKey) || !whatsappOk);

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
                  <Avatar name={c.displayName} seed={c.displayName} conversationId={c.id} />
                  <div className="conv-body">
                    <div className="conv-row">
                      <span className="conv-name">{conversationName(c)}</span>
                      <span className={`conv-time ${hot ? "hot" : ""}`}>{listTime(c.lastMessageAt)}</span>
                    </div>
                    <div className="conv-preview">
                      {typing[c.id] ? (
                        <span className="typing-text">{typingLabel(typing[c.id]!)}</span>
                      ) : (
                        <>
                          {previewPrefix(c.lastOrigin)}
                          {c.lastPreview}
                        </>
                      )}
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
          <ChatView conversation={selected} typing={typing[selected.id]} />
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
