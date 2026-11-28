import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, ChatMessage, Conversation, ConversationFilter } from "../../../shared/types";
import { aiConfigured } from "../../../shared/ai-catalog";
import { Composer } from "../components/Composer";
import {
  IconAlert,
  IconBell,
  IconBellOff,
  IconChart,
  IconChat,
  IconCheck,
  IconCheckCheck,
  IconChevronDown,
  IconInfo,
  IconPencil,
  IconPersonFill,
  IconPhone,
  IconSearch,
  IconShield,
  IconSpark,
  IconTrash,
  IconUser,
  IconX,
} from "../components/Icons";
import { MessageBubble, groupKey } from "../components/MessageBubble";
import { StateTag } from "../components/Tag";
import { api } from "../lib/api";
import { auxLine, conversationName, formatPhone, listTime, usd } from "../lib/format";

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
const PANEL_KEY = "nive-atende:painel-cliente";

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

/** Foto de perfil do contato no WhatsApp; sem foto, a silhueta cinza padrão do WhatsApp. */
function Avatar({ conversationId, size }: { conversationId?: string; size?: "sm" | "lg" }) {
  const [photo, setPhoto] = useState<string | null>(conversationId ? (avatarCache.get(conversationId) ?? null) : null);
  useEffect(() => {
    if (!conversationId) return;
    if (avatarCache.has(conversationId)) {
      setPhoto(avatarCache.get(conversationId) ?? null);
      return;
    }
    setPhoto(null);
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
  const cls = `avatar ${size ?? ""}`;
  if (photo) return <img className={`${cls} avatar-photo`} src={photo} alt="" aria-hidden="true" onError={() => setPhoto(null)} />;
  return (
    <div className={`${cls} avatar-default`} aria-hidden="true">
      <IconPersonFill size={size === "lg" ? 84 : size === "sm" ? 34 : 40} />
    </div>
  );
}

/** Rótulo de seção do painel do cliente, sempre com ícone. */
function PanelLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="panel-label">
      {icon}
      {children}
    </span>
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
          <h2 className="card-title setup-title">
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

/** Lembretes de reserva, avisos de chegada e retomadas: o cliente pode pedir para parar (PARAR) e o lojista vê e muda aqui. */
function AutoMessages({ c }: { c: Conversation }) {
  const [busy, setBusy] = useState(false);
  const off = Boolean(c.autoMessagesOff);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await api.setAutoMessages(c.id, on);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="panel-section">
        <PanelLabel icon={off ? <IconBellOff size={14} /> : <IconBell size={14} />}>Mensagens automáticas</PanelLabel>
        <label className={`switch auto-msgs${off ? " off" : ""}`} title="Lembrete de reserva, aviso de chegada e retomada de conversa parada">
          <span className="switch-label">
            <strong>{off ? "Desligadas" : "Ligadas"}</strong>
          </span>
          <input type="checkbox" role="switch" checked={!off} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
        </label>
        <span className="unverified">
          {off
            ? "Este cliente não recebe lembretes nem avisos. A IA continua respondendo o que ele perguntar."
            : "O cliente pode desligar respondendo PARAR."}
        </span>
      </div>
    </>
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
      <div className="panel-section">
        <PanelLabel icon={<IconSpark size={14} />}>A IA lembra</PanelLabel>
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

function ClientPanel({ c, onClose }: { c: Conversation; onClose: () => void }) {
  return (
    <aside className="client-panel" aria-label="Dados do cliente">
      <header className="panel-head">
        <button className="icon-btn" onClick={onClose} aria-label="Fechar dados do cliente" title="Fechar">
          <IconX size={20} />
        </button>
        <h2>Dados do cliente</h2>
      </header>
      <div className="panel-body">
        <div className="panel-profile">
          <Avatar conversationId={c.id} size="lg" />
          <span className="panel-name">{c.customerName ?? conversationName(c)}</span>
          <span className="panel-phone">
            <IconPhone size={13} />
            {formatPhone(c.phone)}
          </span>
          {c.verifiedBy ? (
            <span className="verified">
              <IconShield size={14} />
              Verificado pelo {c.verifiedBy === "phone" ? "telefone" : "CPF"}
            </span>
          ) : (
            <span className="unverified">Não identificado no cadastro</span>
          )}
        </div>
        <AutoMessages c={c} />
        <CustomerNotes c={c} />
        <div className="panel-section">
          <PanelLabel icon={<IconCheckCheck size={14} />}>O que a IA fez</PanelLabel>
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
        <div className="panel-section">
          <PanelLabel icon={<IconChart size={14} />}>Nesta conversa</PanelLabel>
          <div className="kv">
            <span>Respostas da IA</span>
            <b className="kv-ia">{c.aiRepliesCount}</b>
          </div>
          <div className="kv">
            <span>Respostas humanas</span>
            <b className="kv-human">{c.humanRepliesCount}</b>
          </div>
          <div className="kv">
            <span>Custo de IA</span>
            <b>{usd(c.costUsd)}</b>
          </div>
        </div>
        <div className="panel-section">
          <DeleteConversation c={c} />
        </div>
      </div>
    </aside>
  );
}

function ChatView({
  conversation,
  typing,
  panelOpen,
  onTogglePanel,
}: {
  conversation: Conversation;
  typing?: TypingState;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // longe do fim da conversa aparece o botão de voltar para a última mensagem, como no WhatsApp
  const [away, setAway] = useState(false);
  const onScroll = () => {
    const el = listRef.current;
    if (el) setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 160);
  };

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

  // "Responder com a IA": só quando a última mensagem é do cliente e ninguém respondeu
  const lastReal = [...sorted].reverse().find((m) => m.origin !== "sistema" && m.status !== "deleted");
  const unanswered = lastReal?.origin === "consumidor";
  const [replying, setReplying] = useState(false);
  const [replyNote, setReplyNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setReplyNote(null), [conversation.id]);
  useEffect(() => {
    if (!replyNote) return;
    const t = setTimeout(() => setReplyNote(null), 6000);
    return () => clearTimeout(t);
  }, [replyNote]);
  const replyNow = async () => {
    setReplying(true);
    setReplyNote(null);
    try {
      const r = await api.replyNow(conversation.id);
      setReplyNote({ ok: r.sent, text: r.message });
    } catch (e) {
      setReplyNote({ ok: false, text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Não foi possível responder." });
    } finally {
      setReplying(false);
    }
  };

  const ident = conversation.verifiedBy
    ? `cliente identificado pelo ${conversation.verifiedBy === "phone" ? "telefone" : "CPF"}`
    : "não identificado";

  let lastDay = "";
  let lastGroup = "";
  return (
    <section className="chat" aria-label={`Conversa com ${conversationName(conversation)}`}>
      <header className="chat-head">
        <div className="chat-head-id">
          <Avatar conversationId={conversation.id} size="sm" />
          <ContactHeader conversation={conversation} ident={ident} typing={typing} />
        </div>
        <div className="chat-head-actions">
          {conversation.state !== "ignorado" && (unanswered || replying) && (
            <button
              className="btn-pill ia"
              onClick={() => void replyNow()}
              disabled={replying}
              title="A IA lê as mensagens do cliente que ficaram sem resposta e responde agora"
            >
              <IconSpark size={15} />
              <span className="btn-pill-label">{replying ? "Respondendo…" : "Responder com a IA"}</span>
            </button>
          )}
          {conversation.state !== "ignorado" &&
            (humanMode ? (
              <button className="btn-pill ia" onClick={toggleOwner} disabled={busy} title="Devolver para a IA">
                <IconSpark size={15} />
                <span className="btn-pill-label">Devolver para a IA</span>
              </button>
            ) : (
              <button className="btn-pill human" onClick={toggleOwner} disabled={busy} title="Assumir conversa">
                <IconUser size={15} />
                <span className="btn-pill-label">Assumir conversa</span>
              </button>
            ))}
          <button
            className="icon-btn"
            onClick={onTogglePanel}
            aria-pressed={panelOpen}
            aria-label="Dados do cliente"
            title="Dados do cliente"
          >
            <IconInfo size={20} />
          </button>
        </div>
      </header>
      {replyNote && (
        <div className={`chat-head-note ${replyNote.ok ? "ok" : "warn"}`} role="status">
          {replyNote.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
          {replyNote.text}
        </div>
      )}
      <div className="messages-wrap">
        <div className="messages" ref={listRef} onScroll={onScroll} aria-live="polite" aria-busy={loading}>
          {loading && sorted.length === 0 && (
            <div className="sys loading">
              <span className="spinner" aria-hidden="true" />
              Carregando mensagens…
            </div>
          )}
          {sorted.map((m) => {
            const day = dayLabel(m.createdAt);
            const sep = day !== lastDay;
            lastDay = day;
            const group = groupKey(m);
            const first = sep || group !== lastGroup;
            lastGroup = group;
            return (
              <Fragment key={m.id}>
                {sep && <div className="day-sep">{day}</div>}
                <MessageBubble
                  m={m}
                  first={first}
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
            <div className="customer-typing" role="status" aria-label={`Cliente ${typingLabel(typing)}`}>
              <span className="ai-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {typing === "recording" && "gravando áudio"}
            </div>
          )}
          <AiActivity conversationId={conversation.id} />
          <div ref={endRef} />
        </div>
        {away && (
          <button
            className="to-bottom"
            onClick={() => endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })}
            aria-label="Ir para a última mensagem"
            title="Ir para a última mensagem"
          >
            <IconChevronDown size={22} />
          </button>
        )}
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
    <div className="chat-head-text">
      <div className="chat-head-name">
        <span className="chat-head-name-text">{conversationName(conversation)}</span>
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
      <IconSpark size={13} />
      {label}
      <span className="ai-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
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
  // painel "Dados do cliente": abre e fecha pelo botão do topo da conversa; a escolha fica guardada
  const [panelOpen, setPanelOpen] = useState(() => {
    // janela estreita: o painel abre por cima da conversa, então começa fechado
    if (window.innerWidth < 1240) return false;
    try {
      const saved = localStorage.getItem(PANEL_KEY);
      if (saved) return saved === "1";
    } catch {
      // sem armazenamento: usa o padrão
    }
    return window.innerWidth >= 1240;
  });
  const togglePanel = (open: boolean) => {
    setPanelOpen(open);
    try {
      localStorage.setItem(PANEL_KEY, open ? "1" : "0");
    } catch {
      // segue sem guardar
    }
  };

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

  const chips: Array<{ f: ConversationFilter; label: string; icon?: ReactNode; count?: number; cls?: string }> = [
    { f: "todas", label: "Todas" },
    { f: "precisa", label: "Precisam de você", icon: <IconAlert size={13} />, count: needsHumanCount, cls: "chip-need" },
    { f: "ia", label: "IA", icon: <IconSpark size={13} /> },
    { f: "humano", label: "Humano", icon: <IconUser size={13} /> },
  ];

  return (
    <div className="inbox">
      <div className="conv-list">
        <div className="conv-list-head">
          <h1 className="conv-list-title">Conversas</h1>
          <label className="search">
            <IconSearch size={16} />
            <span className="sr-only">Buscar conversa</span>
            <input placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button className="search-clear" type="button" onClick={() => setQ("")} aria-label="Limpar busca">
                <IconX size={14} />
              </button>
            )}
          </label>
          <div className="filters" role="group" aria-label="Filtrar conversas">
            {chips.map((c) => (
              <button
                key={c.f}
                className={`chip ${c.cls ?? ""}`}
                aria-pressed={filter === c.f}
                onClick={() => onFilter(c.f)}
              >
                {c.icon}
                {c.label}
                {c.count ? <span className="chip-count">{c.count}</span> : null}
              </button>
            ))}
          </div>
        </div>
        <ul className="conv-items" aria-label="Conversas" aria-busy={!loaded}>
          {!loaded && (
            <li className="empty">
              <span className="spinner" aria-hidden="true" />
              Carregando conversas…
            </li>
          )}
          {loaded && items.length === 0 && (
            <li className="empty">
              <span className="empty-icon">{q ? <IconSearch size={22} /> : <IconChat size={22} />}</span>
              {q ? "Nenhuma conversa encontrada." : filter === "precisa" ? "Nada esperando por você." : "Nenhuma conversa ainda."}
            </li>
          )}
          {items.map((c) => {
            const hot = c.state === "precisa_humano";
            const mine = c.lastOrigin === "humano_app" || c.lastOrigin === "humano_celular";
            const aux = auxLine(c);
            return (
              <li key={c.id}>
                <button
                  className={`conv-item ${c.state === "ignorado" ? "ignored" : ""}`}
                  aria-current={selectedId === c.id ? "true" : undefined}
                  onClick={() => onSelect(c.id)}
                >
                  <Avatar conversationId={c.id} />
                  <div className="conv-body">
                    <div className="conv-row">
                      <span className="conv-name">{conversationName(c)}</span>
                      <span className={`conv-time ${hot ? "hot" : c.unread > 0 ? "new" : ""}`}>{listTime(c.lastMessageAt)}</span>
                    </div>
                    <div className="conv-row">
                      <span className="conv-preview">
                        {typing[c.id] ? (
                          <span className="typing-text">{typingLabel(typing[c.id]!)}</span>
                        ) : (
                          <>
                            {c.lastOrigin === "ia" && <IconSpark size={14} className="pv-icon ia" />}
                            {mine && <IconCheckCheck size={16} className="pv-icon" />}
                            <span className="pv-text">{c.lastPreview}</span>
                          </>
                        )}
                      </span>
                      {c.unread > 0 && (
                        <span className={`unread ${hot ? "hot" : ""}`} aria-label={`${c.unread} não lidas`}>
                          {c.unread}
                        </span>
                      )}
                    </div>
                    <div className="conv-meta">
                      <StateTag state={c.state} />
                      {aux && <span className="conv-aux">{aux}</span>}
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
          <ChatView
            conversation={selected}
            typing={typing[selected.id]}
            panelOpen={panelOpen}
            onTogglePanel={() => togglePanel(!panelOpen)}
          />
          {panelOpen && <ClientPanel c={selected} onClose={() => togglePanel(false)} />}
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
          <div className="chat-welcome">
            <span className="chat-welcome-icon">
              <IconChat size={34} />
            </span>
            <h2>Nive Atende</h2>
            <p>Escolha uma conversa na lista para ver as mensagens e responder.</p>
          </div>
        </div>
      )}
    </div>
  );
}
