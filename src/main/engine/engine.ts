// Motor de atendimento: recebe eventos do WhatsApp, decide quando a IA responde e grava quem respondeu.
import { EventEmitter } from "node:events";
import { prettyName, toWhatsApp } from "../ai/format";
import { classifyTopic } from "../ai/topic";
import { messageText } from "../ai/openai";
import { activeModel, transcribeModelFor } from "../../shared/ai-catalog";
import { normalizeName } from "../nive/client";

/** Palavras comuns em nomes de produto que não identificam um item. */
const GENERIC_WORDS = new Set(["perfume", "fem", "feminino", "masculino", "masc", "unissex", "com", "para", "edp", "edt", "parfum", "arabe", "kit", "tam", "cor", "unico"]);
import type { AppSettings, ChatMessage, Conversation, DailySummary, Reservation, ReservationCustomerStatus, SystemEventType } from "../../shared/types";
import type { Store } from "../store/db";
import type { NiveApi, NiveProduct } from "../nive/client";
import type { WhatsAppGateway } from "../evolution/client";
import type { InboundMessage } from "../evolution/parse";
import { AiError, estimateChatCost, estimateTranscriptionCost, type AiMessage, type AiProvider } from "../ai/openai";
import { buildSystemPrompt } from "../ai/prompt";
import { CatalogSummary } from "../ai/catalog";
import { addNickname, listNicknames, removeNickname } from "../ai/nicknames";
import type { ProductNickname } from "../../shared/types";
import { newRunState, runTool, toolsFor, type ToolRunState } from "../ai/tools";
import type { Transcoder } from "../audio/transcode";
import { IdentityService } from "./identity";
import { extractMoneyValues, formatBRL, guardText } from "./guard";
import { localDay } from "../store/db";
import { callerNational, digitsOnly, registeredToJid, samePhone } from "./phone";

export interface EngineDeps {
  store: Store;
  settings: () => AppSettings;
  nive: NiveApi;
  ai: AiProvider;
  wa: WhatsAppGateway;
  transcode: Transcoder;
  /** Motivo pelo qual o atendimento automático está parado (ou null quando pode responder). */
  blockedReason: () => string | null;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Tempo de espera para confirmar que uma mensagem "fromMe" desconhecida veio do celular. */
  echoGraceMs?: number;
  /** Teto da espera para juntar mensagens seguidas do cliente. */
  maxBatchWaitMs?: number;
  /** Baixa a foto do produto para enviar e mostrar na conversa do app. */
  fetchImage?: (url: string) => Promise<{ data: Buffer; mime: string } | null>;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Download padrão de imagem (com tempo e tamanho máximos). */
export async function defaultFetchImage(url: string): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!mime.startsWith("image/")) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_IMAGE_BYTES) return null;
    const data = Buffer.from(await res.arrayBuffer());
    return data.length && data.length <= MAX_IMAGE_BYTES ? { data, mime } : null;
  } catch {
    return null;
  }
}

/** "Avise-me quando chegar". */
export interface WaitEntry {
  conversationId: string;
  productId: string;
  description: string;
  at: number;
  status: "waiting" | "notified" | "expired";
}


export interface NotifyEvent {
  kind: "needs_human" | "message" | "reservation_pending" | "reservation_created" | "blocked";
  title: string;
  body: string;
  conversationId: string | null;
}

export interface EngineEvents {
  message: [ChatMessage];
  conversation: [Conversation];
  reservation: [Reservation];
  notify: [NotifyEvent];
  aiError: [AiError];
  activity: [{ conversationId: string; label: string | null }];
  /** O cliente está digitando/gravando áudio (null = parou). */
  typing: [{ conversationId: string; state: "composing" | "recording" | null }];
  conversationDeleted: [string];
  usage: [];
}

const MAX_TOOL_ROUNDS = 7;
/** Teto de espera enquanto o contato continua digitando. */
const MAX_TYPING_WAIT_MS = 90_000;
/** Limite de texto do histórico enviado à IA (mantém o custo previsível). */
const HISTORY_CHAR_BUDGET = 16000;
const OUT_OF_HOURS_NOTICE_INTERVAL_MS = 12 * 60 * 60 * 1000;

function customerNote(r: Reservation): string {
  switch (r.customerStatus) {
    case "new":
      return " (cliente novo: será cadastrado ao aprovar)";
    case "confirm":
      return " (há cadastros com nome parecido: confirme quem é ao aprovar)";
    case "found_by_name":
      return " (cliente encontrado no cadastro)";
    case "identified":
      return " (cliente identificado)";
    case "ambiguous":
      return " (há mais de um cliente com esse nome: o rascunho sai sem cliente vinculado)";
    default:
      return "";
  }
}

function preview(m: { kind: string; text: string | null; transcript?: string | null }): string {
  if (m.kind === "audio") return m.transcript ? `Áudio: ${m.transcript}` : "Áudio";
  if (m.kind === "image") return m.text ? `Foto: ${m.text}` : "Foto";
  if (m.kind === "video") return "Vídeo";
  if (m.kind === "document") return "Documento";
  if (m.kind === "sticker") return "Figurinha";
  if (m.kind === "location") return "Localização";
  if (m.kind === "contact") return "Contato";
  return (m.text ?? "").slice(0, 140);
}

function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(":").map((x) => Number(x));
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isWithinBusinessHours(s: AppSettings, ts: number): boolean {
  const bh = s.attendance.businessHours;
  if (!bh.enabled) return true;
  const d = new Date(ts);
  if (!bh.days.includes(d.getDay())) return false;
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes >= hhmmToMinutes(bh.start) && minutes < hhmmToMinutes(bh.end);
}

export class Engine extends EventEmitter<EngineEvents> {
  readonly identity: IdentityService;
  /** Resumo do que a loja vende (com estoque), para a IA não oferecer o que a loja não tem. */
  readonly catalog: CatalogSummary;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly timers = new Map<string, { timer: unknown; firstAt: number }>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();
  /** Até quando o contato aparece "digitando…"/"gravando áudio…" (WhatsApp embutido). */
  private readonly typingUntil = new Map<string, number>();
  /** Quantas vezes a resposta foi refeita porque chegou mensagem nova enquanto a IA pensava. */
  private readonly regenerations = new Map<string, number>();
  /** IDs de mensagens que o app está enviando agora (para não confundir com resposta do celular). */
  private readonly inFlight = new Set<string>();
  private inFlightCount = 0;

  constructor(private readonly deps: EngineDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    this.catalog = new CatalogSummary(deps.store, deps.nive, this.now);
    this.identity = new IdentityService({
      store: deps.store,
      nive: deps.nive,
      now: this.now,
      sendSummaryToRegisteredPhone: (c) => this.sendSummaryToRegisteredPhone(c),
      onBlocked: (conversationId) => {
        this.addSystemEvent(conversationId, "identification_blocked", "Consulta de contas bloqueada por tentativas erradas de identificação");
      },
    });
  }

  private get s(): AppSettings {
    return this.deps.settings();
  }

  // ======================================================================== entrada
  async handleInbound(m: InboundMessage): Promise<void> {
    if (m.ignorable) return;
    if (m.fromMe) return this.handleFromMe(m);

    const store = this.deps.store;
    if (store.getMessageByWaId(m.waMessageId)) return; // duplicado
    const conv = store.ensureConversation(m.remoteJid, m.phone, m.pushName);
    const ignored = this.s.attendance.ignoredNumbers.some((n) => samePhone(n, m.phone) || (digitsOnly(n).length >= 8 && digitsOnly(n) === m.phone));

    const msg = store.insertMessage({
      conversationId: conv.id,
      waMessageId: m.waMessageId,
      origin: "consumidor",
      kind: m.kind,
      text: m.text,
      mediaMime: m.mimetype,
      hasMedia: ["audio", "image", "video", "document", "sticker"].includes(m.kind),
      fileName: m.fileName,
      durationSec: m.durationSec,
      createdAt: m.timestamp,
      status: "received",
      processed: ignored,
    });
    if (m.base64 && msg.hasMedia) {
      store.saveMedia(msg.id, m.mimetype ?? "application/octet-stream", Buffer.from(m.base64, "base64"));
    }
    const updated = store.updateConversation(conv.id, {
      lastMessageAt: m.timestamp,
      lastPreview: preview(msg),
      lastOrigin: "consumidor",
      unread: conv.unread + 1,
      ...(ignored ? { state: "ignorado" as const } : {}),
      ...(m.pushName && !conv.customerName ? { displayName: m.pushName } : {}),
    });
    this.emit("message", msg);
    this.emit("conversation", updated);

    const s = this.s;
    if (s.app.notify === "todas" && !ignored) {
      this.emit("notify", { kind: "message", title: updated.customerName ?? updated.displayName, body: preview(msg), conversationId: conv.id });
    }
    if (ignored) return;

    // humano em atendimento: só avisa
    if (updated.aiPausedUntil && updated.aiPausedUntil > this.now()) {
      store.markProcessed([msg.id]);
      if (s.app.notify === "humano" && updated.state !== "ia") {
        this.emit("notify", { kind: "message", title: updated.customerName ?? updated.displayName, body: preview(msg), conversationId: conv.id });
      }
      return;
    }
    this.schedule(conv.id);
  }

  private handleFromMe(m: InboundMessage): void {
    const store = this.deps.store;
    if (store.getMessageByWaId(m.waMessageId)) return; // enviada pelo app
    if (this.inFlight.has(m.waMessageId)) return;
    // Pode ser o eco de um envio do app que ainda não recebeu a resposta HTTP: espera um pouco.
    const grace = this.inFlightCount > 0 ? (this.deps.echoGraceMs ?? 4000) : Math.min(this.deps.echoGraceMs ?? 4000, 1500);
    this.setTimer(() => {
      if (store.getMessageByWaId(m.waMessageId) || this.inFlight.has(m.waMessageId)) return;
      this.recordPhoneReply(m);
    }, grace);
  }

  /** Resposta enviada pela loja fora do app (celular / WhatsApp Web): marca como humana e pausa a IA. */
  private recordPhoneReply(m: InboundMessage): void {
    const store = this.deps.store;
    const conv = store.ensureConversation(m.remoteJid, m.phone, "");
    const msg = store.insertMessage({
      conversationId: conv.id,
      waMessageId: m.waMessageId,
      origin: "humano_celular",
      kind: m.kind,
      text: m.text,
      mediaMime: m.mimetype,
      hasMedia: ["audio", "image", "video", "document", "sticker"].includes(m.kind),
      fileName: m.fileName,
      durationSec: m.durationSec,
      createdAt: m.timestamp,
      status: "sent",
    });
    if (m.base64 && msg.hasMedia) store.saveMedia(msg.id, m.mimetype ?? "application/octet-stream", Buffer.from(m.base64, "base64"));
    this.emit("message", msg);
    const wasPaused = conv.aiPausedUntil !== null && conv.aiPausedUntil > this.now() && conv.state === "humano";
    const pauseUntil = this.now() + this.s.attendance.pauseOnHumanMinutes * 60_000;
    const updated = store.updateConversation(conv.id, {
      lastMessageAt: m.timestamp,
      lastPreview: preview(msg),
      lastOrigin: "humano_celular",
      state: conv.state === "ignorado" ? "ignorado" : "humano",
      aiPausedUntil: pauseUntil,
      handoffReason: null,
      humanRepliesCount: conv.humanRepliesCount + 1,
    });
    store.addUsage(this.now(), { humanReplies: 1 });
    this.cancelSchedule(conv.id);
    store.markProcessed(store.listUnprocessed(conv.id).map((x) => x.id));
    if (!wasPaused && conv.state !== "ignorado") {
      this.addSystemEvent(conv.id, "paused_by_phone", `Respondido pelo celular · IA pausada até ${this.fmtTime(pauseUntil)}`);
    }
    this.emit("conversation", store.getConversation(updated.id)!);
    this.emit("usage");
  }

  handleAck(waMessageId: string, status: string): void {
    const m = this.deps.store.getMessageByWaId(waMessageId);
    if (!m) return;
    if (/ERROR|FAILED/i.test(status) && m.status !== "failed") {
      this.emit("message", this.deps.store.updateMessage(m.id, { status: "failed" }));
    }
  }

  // ======================================================================== fila por conversa
  private schedule(conversationId: string): void {
    const s = this.s;
    const minMs = s.attendance.replyDelayMinSec * 1000;
    const maxMs = Math.max(minMs, s.attendance.replyDelayMaxSec * 1000);
    const delay = Math.round(minMs + this.random() * (maxMs - minMs));
    const existing = this.timers.get(conversationId);
    const firstAt = existing?.firstAt ?? this.now();
    if (existing) this.clearTimer(existing.timer);
    const cap = this.deps.maxBatchWaitMs ?? 25_000;
    const wait = Math.max(0, Math.min(delay, firstAt + cap - this.now()));
    this.arm(conversationId, wait, firstAt);
  }

  /** Dispara o atendimento depois de "wait" ms, adiando enquanto o contato estiver digitando. */
  private arm(conversationId: string, wait: number, firstAt: number): void {
    const timer = this.setTimer(() => {
      const typingUntil = this.typingUntil.get(conversationId) ?? 0;
      if (typingUntil > this.now() && this.now() - firstAt < MAX_TYPING_WAIT_MS) {
        // ainda digitando: confere de novo daqui a pouco
        this.arm(conversationId, Math.min(2000, typingUntil - this.now()), firstAt);
        return;
      }
      this.timers.delete(conversationId);
      void this.process(conversationId);
    }, wait);
    this.timers.set(conversationId, { timer, firstAt });
  }

  /** O contato começou/parou de digitar ou gravar áudio. */
  handleTyping(conversationId: string, state: "composing" | "recording" | "available"): void {
    this.emit("typing", { conversationId, state: state === "available" ? null : state });
    if (state === "available") {
      if (!this.typingUntil.delete(conversationId)) return;
      // parou de digitar: se havia resposta esperando, responde logo (pequena folga para a mensagem chegar)
      const t = this.timers.get(conversationId);
      if (t) {
        this.clearTimer(t.timer);
        this.arm(conversationId, 1500, t.firstAt);
      }
      return;
    }
    this.typingUntil.set(conversationId, this.now() + (state === "recording" ? 30_000 : 12_000));
  }

  private cancelSchedule(conversationId: string): void {
    const t = this.timers.get(conversationId);
    if (t) this.clearTimer(t.timer);
    this.timers.delete(conversationId);
  }

  /** Processa uma conversa (uma de cada vez por conversa). */
  process(conversationId: string): Promise<void> {
    const current = this.running.get(conversationId);
    if (current) {
      this.rerun.add(conversationId);
      return current;
    }
    const p = this.processOnce(conversationId)
      .catch((e) => {
        this.addSystemEvent(conversationId, "error", `Erro no atendimento automático: ${(e as Error).message}`);
      })
      .finally(() => {
        this.running.delete(conversationId);
        if (this.rerun.delete(conversationId)) void this.process(conversationId);
      });
    this.running.set(conversationId, p);
    return p;
  }

  /** Retoma as conversas que ficaram esperando enquanto o atendimento estava parado. */
  async resumeWaiting(): Promise<void> {
    for (const id of this.deps.store.conversationsWithUnprocessed()) await this.process(id);
  }

  /** Volta para "IA" as conversas cuja pausa de humano expirou. */
  sweepExpiredPauses(): void {
    const now = this.now();
    for (const c of this.deps.store.listConversations("humano")) {
      if (c.aiPausedUntil && c.aiPausedUntil <= now) {
        this.emit("conversation", this.deps.store.updateConversation(c.id, { state: "ia", aiPausedUntil: null }));
      }
    }
  }

  private async processOnce(conversationId: string): Promise<void> {
    const store = this.deps.store;
    const s = this.s;
    let conv = store.getConversation(conversationId);
    if (!conv) return;
    const pending = store.listUnprocessed(conversationId);
    if (!pending.length) return;
    const ids = pending.map((m) => m.id);

    if (conv.state === "ignorado") return store.markProcessed(ids);
    if (!s.attendance.autoEnabled) return store.markProcessed(ids);
    if (conv.aiPausedUntil && conv.aiPausedUntil > this.now()) return store.markProcessed(ids);
    if (conv.state === "humano" || conv.state === "precisa_humano") {
      conv = store.updateConversation(conv.id, { state: "ia", aiPausedUntil: null, handoffReason: null });
      this.emit("conversation", conv);
    }
    // Atendimento parado (WhatsApp caiu, IA sem crédito...): as mensagens ficam aguardando.
    if (this.deps.blockedReason()) return;

    // Mensagens antigas (chegaram com o app desligado): não responde automaticamente.
    const windowMs = s.attendance.catchUpWindowMinutes * 60_000;
    const fresh = pending.filter((m) => this.now() - m.createdAt <= windowMs);
    if (!fresh.length) {
      store.markProcessed(ids);
      return this.handoff(conv.id, "mensagem recebida com o atendimento parado", false);
    }

    if (!isWithinBusinessHours(s, this.now())) {
      store.markProcessed(ids);
      const last = store.getOutOfHoursNoticeAt(conv.id);
      if ((!last || this.now() - last > OUT_OF_HOURS_NOTICE_INTERVAL_MS) && !this.isRecentlyPersonal(conv.id)) {
        await this.sendAiText(conv.id, s.attendance.outOfHoursMessage, { countsAsAiReply: false });
        store.updateConversation(conv.id, { outOfHoursNoticeAt: this.now() });
      }
      return;
    }

    // limite diário de respostas da IA por conversa
    const today = localDay(this.now());
    const aiToday = store.listMessages(conv.id, 200).filter((m) => m.origin === "ia" && localDay(m.createdAt) === today).length;
    if (aiToday >= s.ai.maxAiRepliesPerConversationPerDay) {
      store.markProcessed(ids);
      return this.handoff(conv.id, "limite diário de respostas da IA nesta conversa");
    }

    // conversa pessoal do dono com esse contato? então não interfere
    if (s.attendance.onlyStoreTopics && !this.inActiveAiConversation(conv.id)) {
      const verdict = await this.checkTopic(conv.id);
      if (verdict && !verdict.store) {
        store.markProcessed(ids);
        store.setKv(`personal:${conv.id}`, this.now());
        const reason = verdict.reason ? ` (${verdict.reason})` : "";
        store.addAiAction(conv.id, { at: this.now(), label: `Não respondeu: parece conversa pessoal${reason}`, kind: "info" });
        if (!this.isRecentlyPersonal(conv.id, 6 * 60 * 60 * 1000, true)) {
          this.addSystemEvent(conv.id, "personal", `A IA não respondeu: parece conversa pessoal, não assunto da loja${reason}`);
        }
        store.setKv(`personalNotice:${conv.id}`, this.now());
        this.emit("conversation", store.getConversation(conv.id)!);
        return;
      }
    }

    // a partir daqui a IA vai trabalhar: lê as mensagens e o cliente vê "digitando…" enquanto ela busca e responde
    this.markAsRead(conv.id);
    this.startTyping(conv.id);
    try {
      await this.replyWithAi(conv, fresh, ids);
    } finally {
      this.stopTyping(conv.id);
    }
  }

  private async replyWithAi(conversation: Conversation, fresh: ChatMessage[], ids: string[]): Promise<void> {
    const store = this.deps.store;
    const s = this.s;
    let conv = conversation;
    // áudios: transcreve antes
    for (const m of fresh.filter((x) => x.kind === "audio" && !x.transcript)) {
      if (!s.audio.transcribe) {
        store.markProcessed(ids);
        return this.handoff(conv.id, "cliente mandou áudio (transcrição desligada)");
      }
      if (m.durationSec && m.durationSec > s.audio.maxSeconds) {
        store.markProcessed(ids);
        return this.handoff(conv.id, `áudio longo (${Math.round(m.durationSec)} s)`);
      }
      const ok = await this.transcribeMessage(m);
      if (!ok) {
        store.markProcessed(ids);
        return this.handoff(conv.id, "não foi possível entender o áudio");
      }
    }

    // identificação automática pelo número (só lê o cadastro; nada é mostrado sem verificação)
    if (s.accounts.enabled) {
      try {
        const session = await this.identity.autoIdentifyByPhone(conv.id, conv.phone);
        if (session.customerId && session.verifiedBy && conv.customerId !== session.customerId) {
          conv = store.updateConversation(conv.id, {
            customerId: session.customerId,
            customerName: session.customerName,
            verifiedBy: session.verifiedBy,
          });
          this.emit("conversation", conv);
        }
      } catch {
        // falha de rede na Nive: segue sem identificação
      }
    }

    // guarda CPF/datas digitados antes de montar o texto da IA
    const reloaded = fresh.map((m) => store.getMessage(m.id)!);
    for (const m of reloaded) {
      const g = guardText(m.transcript ?? m.text ?? "");
      this.identity.rememberSensitive(conv.id, g.cpfs, g.dates);
    }

    let result: { reply: string | null; state: ToolRunState };
    try {
      result = await this.runAi(conv.id, false);
    } catch (e) {
      if (e instanceof AiError && (e.kind === "no_credit" || e.kind === "invalid_key" || e.kind === "unavailable" || e.kind === "rate_limit")) {
        // deixa as mensagens aguardando; o monitor de status mostra o problema e retoma depois
        this.emit("aiError", e);
        return;
      }
      store.markProcessed(ids);
      return this.handoff(conv.id, "erro ao gerar resposta");
    }
    // Chegou mensagem nova enquanto a IA pensava? Descarta o rascunho e responde tudo de uma vez.
    const arrivedMeanwhile = store.listUnprocessed(conv.id).filter((m) => !ids.includes(m.id));
    const regen = this.regenerations.get(conv.id) ?? 0;
    if (arrivedMeanwhile.length && !result.state.sideEffect && regen < 3) {
      this.regenerations.set(conv.id, regen + 1);
      // a mensagem nova já agendou o atendimento (e espera o cliente parar de digitar)
      if (!this.timers.has(conv.id)) this.rerun.add(conv.id);
      return;
    }
    this.regenerations.delete(conv.id);
    store.markProcessed([...ids, ...arrivedMeanwhile.map((m) => m.id)]);
    const { reply, state } = result;

    for (const a of state.actions) store.addAiAction(conv.id, { at: this.now(), label: a.label, kind: a.kind });
    if (state.actions.length) this.emit("conversation", store.getConversation(conv.id)!);

    // validação final: valores em R$ citados precisam ter vindo das ferramentas ou da conversa
    if (reply) {
      const invalid = this.findUnconfirmedMoney(conv.id, reply, state);
      if (invalid.length) {
        return this.handoff(conv.id, `resposta com valor não confirmado (${invalid.map(formatBRL).join(", ")})`);
      }
    }

    const photos = state.photos.slice(0, 2);
    if (photos.length === 1 && reply && reply.length <= 1000) {
      // uma foto: vai junto com a resposta, como legenda (uma mensagem só, como no WhatsApp)
      await this.sendAiMedia(conv.id, photos[0]!.url, photos[0]!.caption, reply);
    } else {
      for (const photo of photos) await this.sendAiMedia(conv.id, photo.url, photo.caption, null);
      if (reply) await this.sendAiText(conv.id, reply, { countsAsAiReply: true });
    }
    if (state.handoffReason) return this.handoff(conv.id, state.handoffReason, false);
    if (!reply && !state.photos.length) return this.handoff(conv.id, "a IA não soube responder");
  }

  // ---------------------------------------------------------------- o que a IA está fazendo
  private setActivity(conversationId: string, label: string | null): void {
    this.emit("activity", { conversationId, label });
  }

  // ---------------------------------------------------------------- produtos já mostrados
  private getOffered(conversationId: string): Set<string> {
    const v = this.deps.store.getKv<{ at: number; ids: string[] }>(`offered:${conversationId}`);
    // esquece depois de 3 dias sem conversa
    if (!v || this.now() - v.at > 3 * 24 * 60 * 60 * 1000) return new Set();
    return new Set(v.ids);
  }

  /** Guarda quais produtos da busca apareceram na resposta enviada ao cliente. */
  private rememberOffered(conversationId: string, reply: string, state: ToolRunState): void {
    const text = normalizeName(reply);
    const ids = this.getOffered(conversationId);
    for (const p of state.products.values()) {
      const words = normalizeName(prettyName(p.description)).split(" ").filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
      const key = words.slice(0, 3).join(" ");
      if (key && (text.includes(key) || (words.length >= 2 && words.slice(0, 2).every((w) => text.includes(w)) && words.filter((w) => text.includes(w)).length >= Math.min(3, words.length))))
        ids.add(p.id);
    }
    this.deps.store.setKv(`offered:${conversationId}`, { at: this.now(), ids: [...ids].slice(-60) });
  }

  // ---------------------------------------------------------------- mensagens proativas
  /** Só manda mensagem por iniciativa própria em horário razoável (e dentro do horário da loja). */
  private canSendProactive(): boolean {
    const d = new Date(this.now());
    const minutes = d.getHours() * 60 + d.getMinutes();
    return minutes >= 8 * 60 && minutes <= 20 * 60 + 30 && isWithinBusinessHours(this.s, this.now());
  }

  private proactiveAllowed(conversationId: string): boolean {
    const c = this.deps.store.getConversation(conversationId);
    if (!c || c.state === "ignorado" || c.state === "precisa_humano") return false;
    if (c.aiPausedUntil && c.aiPausedUntil > this.now()) return false;
    return true;
  }

  addWaitlist(conversationId: string, productId: string, description: string): void {
    const list = this.deps.store.getKv<WaitEntry[]>("waitlist") ?? [];
    if (list.some((w) => w.conversationId === conversationId && w.productId === productId && w.status === "waiting")) return;
    list.push({ conversationId, productId, description, at: this.now(), status: "waiting" });
    this.deps.store.setKv("waitlist", list.slice(-500));
  }

  listWaitlist(): WaitEntry[] {
    return this.deps.store.getKv<WaitEntry[]>("waitlist") ?? [];
  }

  /** Lembretes de reserva, avisos de chegada e retomada de conversa parada. Chamado de tempos em tempos. */
  async runProactive(): Promise<void> {
    if (!this.s.attendance.autoEnabled || this.deps.blockedReason() || !this.canSendProactive()) return;
    await this.checkBackInStock().catch(() => undefined);
    await this.remindReservations().catch(() => undefined);
    await this.followUps().catch(() => undefined);
  }

  private async checkBackInStock(): Promise<void> {
    if (this.s.attendance.backInStock === false) return;
    const store = this.deps.store;
    const list = this.listWaitlist();
    let changed = false;
    const checked = new Map<string, boolean>();
    for (const w of list) {
      if (w.status !== "waiting") continue;
      if (this.now() - w.at > 30 * 86_400_000) {
        w.status = "expired";
        changed = true;
        continue;
      }
      if (!checked.has(w.productId)) {
        const p = await this.deps.nive.getProduct(w.productId);
        const ok = Boolean(
          p && p.active && (!p.tracksStock || p.variants.some((v) => v.stockQty - store.reservedQuantity(v.id, this.now()) >= 1)),
        );
        checked.set(w.productId, ok);
      }
      if (!checked.get(w.productId) || !this.proactiveAllowed(w.conversationId)) continue;
      await this.sendAiText(
        w.conversationId,
        `Oi! Passando pra avisar que o *${prettyName(w.description)}* que você queria chegou 😊 Quer que eu separe pra você?`,
        { countsAsAiReply: false },
      );
      store.addAiAction(w.conversationId, { at: this.now(), label: `Avisou que chegou: ${prettyName(w.description)}`, kind: "info" });
      w.status = "notified";
      changed = true;
    }
    if (changed) store.setKv("waitlist", list);
  }

  private async remindReservations(): Promise<void> {
    const s = this.s;
    if (s.reservation.reminder === false) return;
    const store = this.deps.store;
    const before = Math.max(1, s.reservation.reminderHours || 3) * 3_600_000;
    for (const r of store.listReservations(300)) {
      if (r.status !== "created" || r.expiresAt <= this.now() || r.expiresAt - this.now() > before) continue;
      if (this.now() - r.createdAt < 60 * 60_000) continue; // validade curta: não lembra logo depois de reservar
      if (store.getKv(`remind:${r.id}`)) continue;
      store.setKv(`remind:${r.id}`, this.now());
      if (!this.proactiveAllowed(r.conversationId)) continue;
      const prazo =
        s.reservation.showDeadline !== false
          ? ` até ${new Date(r.expiresAt).toLocaleString("pt-BR", { weekday: "long", hour: "2-digit", minute: "2-digit" })}`
          : "";
      await this.sendAiText(
        r.conversationId,
        `Oi! Passando pra lembrar que o *${prettyName(r.productDescription)}* está separado pra você${prazo}. Consegue passar pra buscar? 😊`,
        { countsAsAiReply: false },
      );
      store.addAiAction(r.conversationId, { at: this.now(), label: "Lembrou o cliente da reserva", kind: "info" });
    }
  }

  private async followUps(): Promise<void> {
    const s = this.s;
    if (s.attendance.followUpEnabled === false) return;
    const store = this.deps.store;
    const after = Math.max(1, s.attendance.followUpHours || 4) * 3_600_000;
    for (const c of store.listConversations("ia")) {
      if (!this.proactiveAllowed(c.id) || this.running.has(c.id)) continue;
      const msgs = store.listMessages(c.id, 30).filter((m) => m.origin !== "sistema");
      const last = msgs.at(-1);
      const lastCustomer = [...msgs].reverse().find((m) => m.origin === "consumidor");
      if (!last || !lastCustomer || last.origin !== "ia" || last.status !== "sent") continue;
      if (!(last.text ?? "").includes("?")) continue; // só quando a IA ficou esperando uma resposta
      if (this.now() - last.createdAt < after || this.now() - lastCustomer.createdAt > 22 * 3_600_000) continue;
      if (store.listReservations(50).some((r) => r.conversationId === c.id && r.createdAt >= lastCustomer.createdAt)) continue;
      if ((store.getKv<number>(`followup:${c.id}`) ?? 0) >= lastCustomer.createdAt) continue;
      store.setKv(`followup:${c.id}`, this.now());
      const { reply, state } = await this.runAi(
        c.id,
        true,
        "O cliente parou de responder há algumas horas. Escreva UMA mensagem curta, leve e gentil retomando o assunto (ex.: perguntar se ficou alguma dúvida, se quer ver uma foto ou se prefere outra opção). Não insista, não repita a lista de produtos, não ofereça desconto e não diga que é um lembrete automático.",
      );
      if (!reply || this.findUnconfirmedMoney(c.id, reply, state).length) continue;
      await this.sendAiText(c.id, reply, { countsAsAiReply: true });
      store.addAiAction(c.id, { at: this.now(), label: "Retomou a conversa parada", kind: "info" });
    }
  }

  /** Resumo de um dia (para o app e para o WhatsApp do dono). */
  dailySummary(day = this.now()): DailySummary {
    const d = new Date(day);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const to = from + 86_400_000;
    const store = this.deps.store;
    const nums = store.daySummary(from, to);
    const usage = store.usageBetween(localDay(from), localDay(from))[0];
    const waiting = this.listWaitlist().filter((w) => w.status === "waiting").length;
    return { day: localDay(from), ...nums, aiReplies: usage?.aiReplies ?? 0, humanReplies: usage?.humanReplies ?? 0, costUsd: usage?.costUsd ?? 0, waitlist: waiting };
  }

  // ---------------------------------------------------------------- apelidos de produtos
  listNicknames(): ProductNickname[] {
    return listNicknames(this.deps.store);
  }

  /** Lojista cadastra: "abelhinha" → "Atheeri". */
  addNickname(apelido: string, termo: string): ProductNickname[] {
    const ok = addNickname(this.deps.store, { apelido, termo, origem: "loja" }, this.now());
    if (!ok) throw new Error("Escreva o apelido e o nome do produto (pelo menos 3 letras cada).");
    return this.listNicknames();
  }

  removeNickname(apelido: string): ProductNickname[] {
    return removeNickname(this.deps.store, apelido);
  }

  // ---------------------------------------------------------------- memória do cliente
  getCustomerNotes(conversationId: string): string[] {
    return (this.deps.store.getKv<Array<{ at: number; text: string }>>(`notes:${conversationId}`) ?? []).map((n) => n.text);
  }

  addCustomerNote(conversationId: string, text: string): void {
    const list = this.deps.store.getKv<Array<{ at: number; text: string }>>(`notes:${conversationId}`) ?? [];
    const norm = normalizeName(text);
    const kept = list.filter((n) => normalizeName(n.text) !== norm);
    kept.push({ at: this.now(), text });
    this.deps.store.setKv(`notes:${conversationId}`, kept.slice(-15));
    this.emit("conversation", this.deps.store.getConversation(conversationId)!);
  }

  removeCustomerNote(conversationId: string, text: string): string[] {
    const list = this.deps.store.getKv<Array<{ at: number; text: string }>>(`notes:${conversationId}`) ?? [];
    this.deps.store.setKv(`notes:${conversationId}`, list.filter((n) => n.text !== text));
    return this.getCustomerNotes(conversationId);
  }

  /** Data URL da foto enviada pelo cliente (só formatos que a IA lê, até 4 MB). */
  private imageForAi(messageId: string): string | null {
    const media = this.deps.store.getMedia(messageId);
    if (!media) return null;
    const mime = media.mime.split(";")[0]!.trim();
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) || media.data.length > 4 * 1024 * 1024) return null;
    return `data:${mime};base64,${Buffer.from(media.data).toString("base64")}`;
  }

  /** Exemplos reais de respostas da equipe (para a IA imitar o jeito da loja). Valores e telefones saem. */
  private storeExamples(): string[] {
    if (this.s.ai.learnFromStore === false) return [];
    return this.deps.store
      .listRecentHumanReplies(40)
      .map((t) =>
        guardText(t)
          .safeText.replace(/R\$\s?\d[\d.]*(,\d{2})?/g, "R$ [valor]")
          .replace(/\+?\d[\d\s().-]{7,}\d/g, "[número]")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((t) => t.length >= 15 && t.length <= 400)
      .slice(0, 8);
  }

  /** Marca como lidas (tracinhos azuis) as mensagens do cliente que a IA vai responder. */
  private markAsRead(conversationId: string): void {
    if (this.s.attendance.markAsRead === false) return;
    const ids = this.deps.store
      .listUnprocessed(conversationId)
      .filter((m) => m.origin === "consumidor" && m.waMessageId)
      .map((m) => m.waMessageId!);
    if (ids.length) void this.deps.wa.markRead?.(conversationId, ids).catch(() => undefined);
  }

  /** A IA está no meio de um atendimento (respondeu há pouco e ninguém da loja entrou depois)? */
  private inActiveAiConversation(conversationId: string): boolean {
    const msgs = this.deps.store.listMessages(conversationId, 30).filter((m) => m.origin !== "consumidor" && m.origin !== "sistema");
    const last = msgs.at(-1);
    return Boolean(last && last.origin === "ia" && this.now() - last.createdAt < 30 * 60 * 1000);
  }

  private isRecentlyPersonal(conversationId: string, windowMs = 30 * 24 * 60 * 60 * 1000, noticeOnly = false): boolean {
    const at = this.deps.store.getKv<number>(`${noticeOnly ? "personalNotice" : "personal"}:${conversationId}`);
    return typeof at === "number" && this.now() - at < windowMs;
  }

  private async checkTopic(conversationId: string): Promise<{ store: boolean; reason: string } | null> {
    this.setActivity(conversationId, "Analisando a mensagem…");
    try {
      const v = await classifyTopic(this.deps.ai, activeModel(this.s), this.buildHistory(conversationId));
      const cost = estimateChatCost(activeModel(this.s), v.inputTokens, v.outputTokens);
      this.deps.store.addUsage(this.now(), { inputTokens: v.inputTokens, outputTokens: v.outputTokens, costUsd: cost });
      const c = this.deps.store.getConversation(conversationId)!;
      this.deps.store.updateConversation(conversationId, { costUsd: c.costUsd + cost });
      return v;
    } catch {
      return null; // falhou a análise: segue o atendimento normal
    } finally {
      this.setActivity(conversationId, null);
    }
  }

  /** Mostra "digitando…" para o cliente e renova a cada 8 s (o WhatsApp apaga sozinho depois de uns 25 s). */
  private typing = new Map<string, unknown>();

  private startTyping(jid: string): void {
    if (this.typing.has(jid)) return;
    this.setActivity(jid, "IA pensando na resposta…");
    const tick = () => {
      void this.deps.wa.sendPresence(jid, "composing", 9000).catch(() => undefined);
      this.typing.set(jid, this.setTimer(tick, 8000));
    };
    tick();
  }

  private stopTyping(jid: string): void {
    const t = this.typing.get(jid);
    if (t === undefined) return;
    this.clearTimer(t);
    this.typing.delete(jid);
    this.setActivity(jid, null);
    void this.deps.wa.sendPresence(jid, "paused", 0).catch(() => undefined);
  }

  private findUnconfirmedMoney(conversationId: string, reply: string, state: ToolRunState): number[] {
    const allowed = new Set(state.money);
    for (const m of this.deps.store.listMessages(conversationId, 30)) {
      for (const v of extractMoneyValues(m.text ?? m.transcript ?? "")) allowed.add(v);
    }
    return extractMoneyValues(reply).filter((v) => !allowed.has(v));
  }

  private async transcribeMessage(m: ChatMessage): Promise<boolean> {
    const store = this.deps.store;
    try {
      let media = store.getMedia(m.id);
      if (!media && m.waMessageId) {
        const fetched = await this.deps.wa.getMediaBase64(m.waMessageId, m.conversationId, false);
        if (fetched) {
          store.saveMedia(m.id, fetched.mimetype, Buffer.from(fetched.base64, "base64"));
          media = store.getMedia(m.id);
        }
      }
      if (!media) return false;
      const mp3 = await this.deps.transcode(media.data);
      const text = await this.deps.ai.transcribe(transcribeModelFor(this.s), mp3, "audio.mp3");
      const seconds = m.durationSec ?? 30;
      const cost = estimateTranscriptionCost(seconds);
      store.addUsage(this.now(), { transcriptionSeconds: seconds, costUsd: cost });
      const conv = store.getConversation(m.conversationId)!;
      store.updateConversation(conv.id, { costUsd: conv.costUsd + cost });
      if (!text) return false;
      const updated = store.updateMessage(m.id, { transcript: text });
      this.emit("message", updated);
      store.addAiAction(m.conversationId, { at: this.now(), label: `Transcreveu áudio${m.durationSec ? ` de ${Math.round(m.durationSec)} s` : ""}`, kind: "info" });
      return true;
    } catch (e) {
      if (e instanceof AiError && (e.kind === "no_credit" || e.kind === "invalid_key")) this.emit("aiError", e);
      return false;
    }
  }

  // ======================================================================== IA
  private buildHistory(conversationId: string): AiMessage[] {
    const size = Math.max(6, Math.min(100, Math.round(this.s.ai.historyMessages || 40)));
    const msgs = this.deps.store
      .listMessages(conversationId, size * 2 + 20)
      .filter((m) => m.origin !== "sistema" && m.status !== "deleted")
      .slice(-size);
    const out: AiMessage[] = [];
    let prevAt: number | null = null;
    for (const m of msgs) {
      let content: string;
      const raw = m.transcript ?? m.text ?? "";
      if (m.kind === "audio") content = raw ? `(áudio) ${raw}` : "(áudio que não foi possível entender)";
      else if (m.kind === "image" && m.origin === "ia") content = raw || `Foto enviada: ${m.fileName ?? "produto"}`;
      else if (m.kind === "image") content = `[imagem]${raw ? " " + raw : ""}`;
      else if (m.kind === "sticker") content = "[figurinha]";
      else if (m.kind === "video") content = `[vídeo]${raw ? " " + raw : ""}`;
      else if (m.kind === "document") content = `[documento${m.fileName ? " " + m.fileName : ""}]`;
      else if (m.kind === "location") content = `[localização] ${raw}`;
      else if (m.kind === "contact") content = `[contato] ${raw}`;
      else content = raw;
      // CPF e datas nunca vão para a IA
      content = guardText(content).safeText;
      if (!content.trim()) continue;
      // marca intervalos longos para a IA saber que a conversa foi retomada outro dia
      if (prevAt !== null && m.createdAt - prevAt > 6 * 60 * 60 * 1000) {
        const d = new Date(m.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
        content = `(conversa retomada em ${d}) ${content}`;
      }
      prevAt = m.createdAt;
      if (m.origin === "consumidor") {
        // foto recente do cliente: a IA vê a imagem para identificar o produto
        const img = m.kind === "image" && this.now() - m.createdAt < 30 * 60_000 ? this.imageForAi(m.id) : null;
        out.push({ role: "user", content: img ? [{ type: "text", text: content }, { type: "image_url", image_url: { url: img, detail: "low" } }] : content });
      }
      else out.push({ role: "assistant", content: m.origin === "ia" ? content : `(resposta da equipe da loja) ${content}` });
    }
    // corta as mais antigas se o texto passar do limite (sempre mantém as mais recentes)
    let total = out.reduce((n, m) => n + messageText(m).length, 0);
    while (out.length > 4 && total > HISTORY_CHAR_BUDGET) total -= messageText(out.shift()!).length;
    while (out.length && out[0]!.role === "assistant") out.shift();
    return out;
  }

  private async runAi(conversationId: string, readOnly: boolean, extraInstruction?: string): Promise<{ reply: string | null; state: ToolRunState }> {
    const store = this.deps.store;
    const s = this.s;
    const conv = store.getConversation(conversationId)!;
    const session = this.identity.load(conversationId);
    const verified = this.identity.verifiedCustomerId(conversationId);
    const system = buildSystemPrompt({
      settings: s,
      now: new Date(this.now()),
      identity: verified ? { name: verified.name, by: verified.by } : null,
      awaitingBirthDate: Boolean(session.pending),
      blocked: Boolean(session.blockedUntil),
      storeExamples: this.storeExamples(),
      customerNotes: this.getCustomerNotes(conversationId),
      catalogSummary: await this.catalog.get(),
      nicknames: listNicknames(store),
    });
    const messages: AiMessage[] = [{ role: "system", content: system }, ...this.buildHistory(conversationId)];
    if (extraInstruction) messages.push({ role: "system", content: extraInstruction });
    const tools = toolsFor(s, readOnly);
    const state = newRunState();
    let inTok = 0;
    let outTok = 0;
    let reply: string | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await this.deps.ai.chat(activeModel(s), messages, tools);
      inTok += res.inputTokens;
      outTok += res.outputTokens;
      if (!res.toolCalls.length) {
        reply = res.content ? toWhatsApp(res.content) || null : null;
        break;
      }
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls, ...(res.raw !== undefined ? { raw: res.raw } : {}) });
      for (const call of res.toolCalls) {
        let output: unknown;
        try {
          output = await runTool(call.function.name, call.function.arguments, {
            conversationId,
            phone: conv.phone,
            settings: s,
            store,
            nive: this.deps.nive,
            identity: this.identity,
            now: this.now,
            offered: this.getOffered(conversationId),
            addNote: (note) => !readOnly && this.addCustomerNote(conversationId, note),
            learnNickname: (apelido, termo, productId) =>
              !readOnly && Boolean(addNickname(store, { apelido, termo, origem: "ia", produtoId: productId }, this.now())),
            addWaitlist: (productId, description) => !readOnly && this.addWaitlist(conversationId, productId, description),
            activity: (label) => !readOnly && this.setActivity(conversationId, label),
            reserve: (input) => this.createReservation(conversationId, input),
          }, state);
        } catch (e) {
          console.error(`[ferramenta ${call.function.name}]`, (e as Error).message);
          output = { erro: "Falha ao consultar o sistema da loja", instrucao: "Diga que não conseguiu consultar agora e use transferir_para_humano." };
          state.actions.push({ label: `Falha em ${call.function.name}`, kind: "error" });
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }

    if (reply && !readOnly) this.rememberOffered(conversationId, reply, state);
    const cost = estimateChatCost(activeModel(s), inTok, outTok);
    store.addUsage(this.now(), { inputTokens: inTok, outputTokens: outTok, costUsd: cost });
    const c = store.getConversation(conversationId)!;
    store.updateConversation(conversationId, { costUsd: c.costUsd + cost });
    this.emit("usage");
    return { reply, state };
  }

  /** "Sugestão da IA" no campo de resposta: só leitura, nada é enviado. */
  async suggestReply(conversationId: string): Promise<string> {
    const { reply } = await this.runAi(conversationId, true);
    return reply ?? "";
  }

  // ======================================================================== envio
  private fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  private async withInFlight<T>(fn: () => Promise<T & { waMessageId: string | null }>): Promise<T & { waMessageId: string | null }> {
    this.inFlightCount++;
    try {
      const r = await fn();
      if (r.waMessageId) {
        this.inFlight.add(r.waMessageId);
        const id = r.waMessageId;
        this.setTimer(() => this.inFlight.delete(id), 30_000);
      }
      return r;
    } finally {
      this.inFlightCount--;
    }
  }

  private async sendAiText(conversationId: string, text: string, opts: { countsAsAiReply: boolean }): Promise<ChatMessage> {
    const store = this.deps.store;
    const msg = store.insertMessage({ conversationId, origin: "ia", kind: "text", text, status: "pending", createdAt: this.now() });
    this.emit("message", msg);
    try {
      // já está "digitando" desde que a IA começou; fora disso, mostra um instante antes de enviar
      if (!this.typing.has(conversationId)) {
        const typingMs = Math.min(4000, 800 + text.length * 25);
        await this.deps.wa.sendPresence(conversationId, "composing", typingMs);
      }
      const r = await this.withInFlight(() => this.deps.wa.sendText(conversationId, text));
      const sent = store.updateMessage(msg.id, { waMessageId: r.waMessageId, status: "sent" });
      this.emit("message", sent);
      const conv = store.getConversation(conversationId)!;
      const updated = store.updateConversation(conversationId, {
        lastMessageAt: this.now(),
        lastPreview: text.slice(0, 140),
        lastOrigin: "ia",
        ...(opts.countsAsAiReply ? { aiRepliesCount: conv.aiRepliesCount + 1 } : {}),
      });
      if (opts.countsAsAiReply) store.addUsage(this.now(), { aiReplies: 1 });
      this.emit("conversation", updated);
      this.emit("usage");
      return sent;
    } catch (e) {
      const failed = store.updateMessage(msg.id, { status: "failed" });
      this.emit("message", failed);
      throw e;
    }
  }

  /**
   * Envia a foto de um produto. Com "caption", a resposta da IA vai como legenda (conta como resposta);
   * sem legenda, só a foto. O nome do produto fica guardado para o histórico da IA.
   */
  private async sendAiMedia(conversationId: string, url: string, productName: string, caption: string | null): Promise<void> {
    const store = this.deps.store;
    // baixa a foto uma vez: o mesmo arquivo vai para o cliente e fica visível na conversa do app
    const img = await (this.deps.fetchImage ?? defaultFetchImage)(url).catch(() => null);
    const mime = img?.mime ?? "image/jpeg";
    const msg = store.insertMessage({
      conversationId,
      origin: "ia",
      kind: "image",
      text: caption,
      fileName: prettyName(productName),
      mediaMime: mime,
      hasMedia: Boolean(img),
      status: "pending",
      createdAt: this.now(),
    });
    if (img) store.saveMedia(msg.id, mime, img.data);
    this.emit("message", msg);
    try {
      const media = img ? img.data.toString("base64") : url;
      const r = await this.withInFlight(() => this.deps.wa.sendMedia(conversationId, { mediatype: "image", mimetype: mime, media, caption: caption ?? "" }));
      this.emit("message", store.updateMessage(msg.id, { waMessageId: r.waMessageId, status: "sent" }));
      if (caption) {
        const conv = store.getConversation(conversationId)!;
        const updated = store.updateConversation(conversationId, {
          lastMessageAt: this.now(),
          lastPreview: `Foto: ${caption.slice(0, 130)}`,
          lastOrigin: "ia",
          aiRepliesCount: conv.aiRepliesCount + 1,
        });
        store.addUsage(this.now(), { aiReplies: 1 });
        this.emit("conversation", updated);
        this.emit("usage");
      }
    } catch {
      this.emit("message", store.updateMessage(msg.id, { status: "failed" }));
    }
  }

  /** "Apagar para todos" uma mensagem que a loja enviou (pela IA, pelo app ou pelo celular). */
  async deleteMessage(messageId: string): Promise<ChatMessage> {
    const store = this.deps.store;
    const m = store.getMessage(messageId);
    if (!m) throw new Error("Mensagem não encontrada");
    if (m.origin === "consumidor" || m.origin === "sistema") throw new Error("Só dá para apagar mensagens enviadas pela loja.");
    if (m.status === "deleted") return m;
    if (!m.waMessageId || m.status !== "sent") throw new Error("Essa mensagem não chegou a ser enviada.");
    await this.deps.wa.deleteForEveryone(m.conversationId, m.waMessageId);
    const updated = store.updateMessage(m.id, { status: "deleted" });
    this.emit("message", updated);
    return updated;
  }

  /** Apaga a conversa do app (não apaga no celular). Se o cliente escrever de novo, começa uma conversa nova. */
  deleteConversation(conversationId: string): void {
    if (this.running.has(conversationId)) throw new Error("A IA está respondendo esta conversa agora. Tente de novo em alguns segundos.");
    this.cancelSchedule(conversationId);
    this.typingUntil.delete(conversationId);
    this.stopTyping(conversationId);
    this.deps.store.deleteConversation(conversationId);
    this.emit("conversationDeleted", conversationId);
  }

  /** O cliente (ou o celular da loja) apagou uma mensagem para todos. */
  handleRevoke(remoteJid: string, waMessageId: string): void {
    const store = this.deps.store;
    const m = store.getMessageByWaId(waMessageId);
    // só aceita apagar mensagem da mesma conversa
    if (!m || m.conversationId !== remoteJid || m.status === "deleted") return;
    this.emit("message", store.updateMessage(m.id, { status: "deleted" }));
  }

  /** Mensagem digitada pelo lojista no app. */
  async sendHumanText(conversationId: string, text: string, author: string): Promise<ChatMessage> {
    return this.sendHuman(conversationId, { kind: "text", text }, author, (jid) => this.deps.wa.sendText(jid, text));
  }

  async sendHumanMedia(conversationId: string, media: { fileName: string; mime: string; base64: string; caption?: string }, author: string): Promise<ChatMessage> {
    const mediatype = media.mime.startsWith("image/") ? "image" : media.mime.startsWith("video/") ? "video" : "document";
    const kind = mediatype === "image" ? "image" : mediatype === "video" ? "video" : "document";
    return this.sendHuman(
      conversationId,
      { kind, text: media.caption ?? null, mediaMime: media.mime, fileName: media.fileName, data: Buffer.from(media.base64, "base64") },
      author,
      (jid) => this.deps.wa.sendMedia(jid, { mediatype, mimetype: media.mime, media: media.base64, fileName: media.fileName, caption: media.caption }),
    );
  }

  async sendHumanAudio(conversationId: string, base64: string, mime: string, author: string): Promise<ChatMessage> {
    return this.sendHuman(
      conversationId,
      { kind: "audio", text: null, mediaMime: mime, data: Buffer.from(base64, "base64") },
      author,
      (jid) => this.deps.wa.sendAudio(jid, base64),
    );
  }

  async resendSticker(conversationId: string, messageId: string, author: string): Promise<ChatMessage> {
    const media = this.deps.store.getMedia(messageId);
    if (!media) throw new Error("Figurinha não disponível; abra-a na conversa primeiro.");
    const b64 = Buffer.from(media.data).toString("base64");
    return this.sendHuman(
      conversationId,
      { kind: "sticker", text: null, mediaMime: media.mime, data: Buffer.from(media.data) },
      author,
      (jid) => this.deps.wa.sendSticker(jid, b64),
    );
  }

  private async sendHuman(
    conversationId: string,
    content: { kind: ChatMessage["kind"]; text: string | null; mediaMime?: string; fileName?: string; data?: Buffer },
    author: string,
    send: (jid: string) => Promise<{ waMessageId: string | null }>,
  ): Promise<ChatMessage> {
    const store = this.deps.store;
    const conv = store.getConversation(conversationId);
    if (!conv) throw new Error("Conversa não encontrada");
    const msg = store.insertMessage({
      conversationId,
      origin: "humano_app",
      kind: content.kind,
      text: content.text,
      mediaMime: content.mediaMime ?? null,
      hasMedia: Boolean(content.data),
      fileName: content.fileName ?? null,
      status: "pending",
      author: author || "Equipe",
    });
    if (content.data) store.saveMedia(msg.id, content.mediaMime ?? "application/octet-stream", content.data);
    this.emit("message", msg);

    // humano respondendo: pausa a IA nesta conversa
    this.cancelSchedule(conversationId);
    store.markProcessed(store.listUnprocessed(conversationId).map((m) => m.id));
    const pauseUntil = this.now() + this.s.attendance.pauseOnHumanMinutes * 60_000;
    try {
      const r = await this.withInFlight(() => send(conversationId));
      const sent = store.updateMessage(msg.id, { waMessageId: r.waMessageId, status: "sent" });
      this.emit("message", sent);
      const updated = store.updateConversation(conversationId, {
        lastMessageAt: this.now(),
        lastPreview: preview(sent),
        lastOrigin: "humano_app",
        state: conv.state === "ignorado" ? "ignorado" : "humano",
        aiPausedUntil: pauseUntil,
        handoffReason: null,
        humanRepliesCount: conv.humanRepliesCount + 1,
        unread: 0,
      });
      store.addUsage(this.now(), { humanReplies: 1 });
      this.emit("conversation", updated);
      this.emit("usage");
      return sent;
    } catch (e) {
      this.emit("message", store.updateMessage(msg.id, { status: "failed" }));
      throw e;
    }
  }

  // ======================================================================== estados
  addSystemEvent(conversationId: string, eventType: SystemEventType, text: string): ChatMessage {
    const msg = this.deps.store.insertMessage({ conversationId, origin: "sistema", kind: "event", text, status: "sent", eventType });
    this.emit("message", msg);
    return msg;
  }

  handoff(conversationId: string, reason: string, notifyCustomer = false): void {
    const store = this.deps.store;
    const conv = store.getConversation(conversationId);
    if (!conv) return;
    void notifyCustomer;
    const pauseUntil = this.now() + this.s.attendance.pauseOnHumanMinutes * 60_000;
    const updated = store.updateConversation(conversationId, { state: "precisa_humano", handoffReason: reason, aiPausedUntil: pauseUntil });
    store.addAiAction(conversationId, { at: this.now(), label: `Passou para humano: ${reason}`, kind: "handoff" });
    this.addSystemEvent(conversationId, "handoff", `IA passou para humano · motivo: ${reason}`);
    this.emit("conversation", store.getConversation(updated.id)!);
    if (this.s.app.notify !== "nenhuma") {
      this.emit("notify", {
        kind: "needs_human",
        title: `${conv.customerName ?? conv.displayName} precisa de você`,
        body: `${conv.lastPreview ? `“${conv.lastPreview.slice(0, 80)}” · ` : ""}${reason}`,
        conversationId,
      });
    }
  }

  takeOver(conversationId: string, operator: string): Conversation {
    const store = this.deps.store;
    const pauseUntil = this.now() + this.s.attendance.pauseOnHumanMinutes * 60_000;
    this.cancelSchedule(conversationId);
    store.markProcessed(store.listUnprocessed(conversationId).map((m) => m.id));
    const conv = store.updateConversation(conversationId, { state: "humano", aiPausedUntil: pauseUntil, handoffReason: null });
    this.addSystemEvent(conversationId, "takeover", `${operator || "Equipe"} assumiu a conversa · IA pausada até ${this.fmtTime(pauseUntil)}`);
    this.emit("conversation", conv);
    return conv;
  }

  returnToAi(conversationId: string): Conversation {
    const conv = this.deps.store.updateConversation(conversationId, { state: "ia", aiPausedUntil: null, handoffReason: null });
    this.addSystemEvent(conversationId, "returned_to_ai", "Conversa devolvida para a IA");
    this.emit("conversation", conv);
    return conv;
  }

  // ======================================================================== reservas
  /** Descobre a quem a reserva pertence no cadastro (sem cadastrar nada ainda). */
  private async resolveReservationCustomer(
    customer: { id: string; name: string } | null,
    name: string | null,
    phone: string,
  ): Promise<{
    customerId: string | null;
    customerName: string | null;
    customerStatus: ReservationCustomerStatus;
    customerCandidates: Array<{ id: string; name: string }>;
  }> {
    if (customer) return { customerId: customer.id, customerName: customer.name, customerStatus: "identified", customerCandidates: [] };
    if (!name) return { customerId: null, customerName: null, customerStatus: "none", customerCandidates: [] };
    const r = await this.resolveByName(name, phone);
    if (r.customerStatus !== "new") return { ...r, customerCandidates: [] };
    // não achou o nome exato: procura cadastros parecidos ("Aliny" → "Aliny Rocker Beltrame") para o lojista confirmar
    try {
      const similar = await this.deps.nive.findSimilarCustomers(name);
      const byPhone = similar.filter((c) => samePhone(c.phone, phone));
      if (byPhone.length === 1) return { customerId: byPhone[0]!.id, customerName: byPhone[0]!.name, customerStatus: "found_by_name", customerCandidates: [] };
      if (similar.length) return { ...r, customerStatus: "confirm", customerCandidates: similar.map((c) => ({ id: c.id, name: c.name })) };
    } catch {
      /* segue como cliente novo */
    }
    return { ...r, customerCandidates: [] };
  }

  private async resolveByName(
    name: string,
    phone: string,
  ): Promise<{ customerId: string | null; customerName: string | null; customerStatus: ReservationCustomerStatus }> {
    try {
      const found = await this.deps.nive.findCustomersByName(name);
      if (found.length === 1) return { customerId: found[0]!.id, customerName: found[0]!.name, customerStatus: "found_by_name" };
      if (found.length > 1) {
        // vários com o mesmo nome: só vincula se o telefone da conversa bater com um deles
        const byPhone = found.filter((c) => samePhone(c.phone, phone));
        if (byPhone.length === 1) return { customerId: byPhone[0]!.id, customerName: byPhone[0]!.name, customerStatus: "found_by_name" };
        return { customerId: null, customerName: name, customerStatus: "ambiguous" };
      }
      return { customerId: null, customerName: name, customerStatus: "new" };
    } catch {
      // sem conexão com a Nive agora: decide de novo ao lançar o rascunho
      return { customerId: null, customerName: name, customerStatus: "new" };
    }
  }

  private async createReservation(
    conversationId: string,
    input: {
      product: NiveProduct;
      variantId: string;
      variantLabel: string;
      quantity: number;
      unitPrice: number;
      customer: { id: string; name: string } | null;
      customerName: string | null;
    },
  ): Promise<Reservation> {
    const store = this.deps.store;
    const s = this.s;
    const conv = store.getConversation(conversationId)!;
    const expiresAt = this.now() + s.reservation.validityHours * 3_600_000;
    const who = await this.resolveReservationCustomer(input.customer, input.customerName, conv.phone);
    // com cadastro parecido, mesmo na reserva automática o lojista confirma quem é antes de lançar
    const auto = s.reservation.autoEnabled && who.customerStatus !== "confirm";
    let r = store.insertReservation({
      conversationId,
      customerId: who.customerId,
      customerName: who.customerName ?? conv.customerName ?? conv.displayName,
      customerStatus: who.customerStatus,
      customerCandidates: who.customerCandidates,
      phone: conv.phone,
      productId: input.product.id,
      variantId: input.variantId,
      productDescription: input.product.description,
      variantLabel: input.variantLabel,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      saleId: null,
      orderNumber: null,
      status: auto ? "created" : "pending_approval",
      expiresAt,
      error: null,
    });
    const item = `${r.quantity}× ${prettyName(r.productDescription)}`;
    if (auto) {
      r = await this.pushReservationToErp(r);
      if (r.status === "created") {
        this.addSystemEvent(
          conversationId,
          "reservation_created",
          `Reserva criada como rascunho${r.orderNumber ? ` · pedido #${r.orderNumber}` : ""} · ${r.customerName}${r.customerStatus === "created_new" ? " (cliente cadastrado agora)" : ""}`,
        );
        this.emit("notify", { kind: "reservation_created", title: "Nova reserva pelo WhatsApp", body: `${item} · ${r.customerName}`, conversationId });
      }
    } else {
      this.addSystemEvent(conversationId, "reservation_pending", `Pedido de reserva aguardando sua aprovação: ${item} · em nome de ${r.customerName}${customerNote(r)}`);
      this.emit("notify", { kind: "reservation_pending", title: "Reserva aguardando aprovação", body: `${item} · ${r.customerName}`, conversationId });
    }
    this.emit("reservation", r);
    return r;
  }

  /** Garante o cliente no ERP (cadastra se for novo) antes de lançar o rascunho. */
  private async ensureReservationCustomer(r: Reservation): Promise<Reservation> {
    const store = this.deps.store;
    if (r.customerStatus !== "new" || store.getReservationCustomerId(r.id)) return r;
    // procura de novo (pode ter sido cadastrado entre o pedido e a aprovação, ou numa tentativa anterior)
    const found = await this.deps.nive.findCustomersByName(r.customerName);
    if (found.length === 1) return store.updateReservation(r.id, { customerId: found[0]!.id, customerStatus: "found_by_name" });
    if (found.length > 1) return store.updateReservation(r.id, { customerStatus: "ambiguous" });
    const created = await this.deps.nive.createCustomer({ name: r.customerName, phone: callerNational(r.phone) });
    store.audit(r.phone, created.id, "cadastro_cliente", "cliente cadastrado pela reserva do WhatsApp");
    return store.updateReservation(r.id, { customerId: created.id, customerStatus: "created_new" });
  }

  private async pushReservationToErp(reservation: Reservation): Promise<Reservation> {
    const store = this.deps.store;
    let r = reservation;
    try {
      r = await this.ensureReservationCustomer(r);
    } catch (e) {
      return store.updateReservation(r.id, { status: "failed", error: `Não foi possível cadastrar o cliente: ${(e as Error).message}`.slice(0, 200) });
    }
    const validade = new Date(r.expiresAt).toLocaleString("pt-BR");
    try {
      const sale = await this.deps.nive.createDraftSale({
        customerId: store.getReservationCustomerId(r.id),
        variantId: r.variantId,
        quantity: r.quantity,
        notes: `Reserva pelo WhatsApp (Nive Atende) · ${r.customerName} · ${r.phone} · válida até ${validade}`,
      });
      return store.updateReservation(r.id, { status: "created", saleId: sale.id, orderNumber: sale.orderNumber, error: null });
    } catch (e) {
      return store.updateReservation(r.id, { status: "failed", error: (e as Error).message.slice(0, 200) });
    }
  }

  async approveReservation(id: string, choice?: { customerId?: string | null; createNew?: boolean }): Promise<Reservation> {
    const store = this.deps.store;
    let r = store.getReservation(id);
    if (!r) throw new Error("Reserva não encontrada");
    if (r.status !== "pending_approval" && r.status !== "failed") return r;
    if (r.customerStatus === "confirm") {
      const picked = choice?.customerId ? r.customerCandidates.find((c) => c.id === choice.customerId) : null;
      if (picked) r = store.updateReservation(r.id, { customerId: picked.id, customerName: picked.name, customerStatus: "found_by_name", customerCandidates: [] });
      else if (choice?.createNew) r = store.updateReservation(r.id, { customerStatus: "new", customerCandidates: [] });
      else throw new Error("Confirme qual é o cliente (ou escolha cadastrar um novo) antes de aprovar.");
    }
    if (r.expiresAt <= this.now()) {
      r = store.updateReservation(r.id, { status: "expired" });
      this.emit("reservation", r);
      throw new Error("Essa reserva já venceu. Peça para o cliente confirmar de novo.");
    }
    r = await this.pushReservationToErp(r);
    this.emit("reservation", r);
    if (r.status === "created") {
      this.addSystemEvent(
        r.conversationId,
        "reservation_created",
        `Reserva aprovada e criada como rascunho${r.orderNumber ? ` · pedido #${r.orderNumber}` : ""} · ${r.customerName}${r.customerStatus === "created_new" ? " (cliente cadastrado agora)" : ""}`,
      );
      const validade = new Date(r.expiresAt).toLocaleString("pt-BR", { weekday: "long", hour: "2-digit", minute: "2-digit" });
      const variant = r.variantLabel && r.variantLabel !== "Único" ? ` (${r.variantLabel})` : "";
      const prazo = this.s.reservation.showDeadline !== false ? ` até ${validade}` : "";
      await this.sendAiText(
        r.conversationId,
        `Separado! ✅ ${r.quantity > 1 ? `${r.quantity} unidades de ` : ""}*${prettyName(r.productDescription)}*${variant} fica reservado em nome de ${r.customerName}${prazo}.`,
        { countsAsAiReply: false },
      ).catch(() => undefined);
    }
    return r;
  }

  rejectReservation(id: string): Reservation {
    const store = this.deps.store;
    const r = store.updateReservation(id, { status: "rejected" });
    this.emit("reservation", r);
    this.handoff(r.conversationId, "reserva recusada — avise o cliente");
    return r;
  }

  /** Lojista cancelou a reserva pelo app. */
  async cancelReservation(id: string): Promise<Reservation> {
    const store = this.deps.store;
    const r = store.getReservation(id);
    if (!r) throw new Error("Reserva não encontrada");
    if (r.status !== "created" && r.status !== "pending_approval" && r.status !== "failed") return r;
    if (r.status === "created" && r.saleId) {
      const out = await this.deps.nive.cancelDraftSale(r.saleId, "Reserva cancelada pela loja no Nive Atende");
      if (out === "not_draft") {
        const done = store.updateReservation(r.id, { status: "completed" });
        this.emit("reservation", done);
        throw new Error("Essa venda já foi finalizada no sistema Nive; para desfazer, cancele a venda por lá.");
      }
    }
    const updated = store.updateReservation(r.id, { status: "cancelled" });
    this.emit("reservation", updated);
    this.addSystemEvent(
      r.conversationId,
      "reservation_expired",
      `Reserva cancelada pela loja: ${r.quantity}× ${prettyName(r.productDescription)}${r.saleId ? " (rascunho cancelado no sistema)" : ""}`,
    );
    return updated;
  }

  /**
   * Confere no ERP os rascunhos das reservas ativas: finalizado vira "Finalizada";
   * excluído ou cancelado por lá vira "Removida".
   */
  async syncReservationsWithErp(): Promise<void> {
    const store = this.deps.store;
    for (const r of store.listReservations(300)) {
      if (r.status !== "created" || !r.saleId) continue;
      try {
        const { state, orderNumber } = await this.deps.nive.getSaleState(r.saleId);
        if (orderNumber && orderNumber !== r.orderNumber) this.emit("reservation", store.updateReservation(r.id, { orderNumber }));
        if (state === "completed") {
          this.emit("reservation", store.updateReservation(r.id, { status: "completed" }));
          this.addSystemEvent(r.conversationId, "reservation_created", `Venda da reserva finalizada no sistema${orderNumber ? ` · pedido #${orderNumber}` : ""}`);
        } else if (state === "cancelled" || state === "not_found") {
          this.emit("reservation", store.updateReservation(r.id, { status: "removed" }));
          this.addSystemEvent(r.conversationId, "reservation_expired", `Rascunho da reserva ${state === "not_found" ? "excluído" : "cancelado"} no sistema`);
        }
      } catch {
        // ERP fora do ar: confere de novo depois
      }
    }
  }

  /**
   * Reservas vencidas: pedido não aprovado expira; rascunho que não virou venda é cancelado no ERP
   * (as peças voltam para a loja). Venda já finalizada não é tocada.
   */
  async sweepExpiredReservations(): Promise<void> {
    const store = this.deps.store;
    for (const r of store.listExpiredActiveReservations(this.now())) {
      if (r.status === "pending_approval" || !r.saleId) {
        this.emit("reservation", store.updateReservation(r.id, { status: "expired" }));
        continue;
      }
      if (!this.s.reservation.cancelExpiredDrafts) continue;
      try {
        const out = await this.deps.nive.cancelDraftSale(r.saleId, `Reserva pelo WhatsApp venceu sem finalizar a venda (Nive Atende)`);
        const order = r.orderNumber ? ` #${r.orderNumber}` : "";
        if (out === "not_draft") {
          this.emit("reservation", store.updateReservation(r.id, { status: "completed" }));
        } else {
          this.emit("reservation", store.updateReservation(r.id, { status: "expired" }));
          if (out === "cancelled")
            this.addSystemEvent(r.conversationId, "reservation_expired", `Reserva venceu: rascunho${order} cancelado no sistema e ${r.quantity}× ${prettyName(r.productDescription)} voltou ao estoque`);
        }
      } catch {
        // ERP fora do ar: tenta de novo na próxima verificação
      }
    }
  }

  // ======================================================================== modo restrito
  private async sendSummaryToRegisteredPhone(c: { id: string; name: string; phone: string }): Promise<boolean> {
    const st = await this.deps.nive.getStatement(c.id);
    if (st.customerId !== c.id) return false;
    const store = this.s.personality.storeName || "a loja";
    const first = c.name.split(/\s+/)[0];
    const body =
      st.openBalance > 0.009
        ? `Oi, ${first}! Aqui é ${store}. Alguém pediu informações da sua conta por outro número. Você tem ${formatBRL(st.openBalance)} em aberto${st.overdueBalance > 0.009 ? ` (${formatBRL(st.overdueBalance)} vencido)` : ""}. Se não foi você, pode ignorar esta mensagem.`
        : `Oi, ${first}! Aqui é ${store}. Alguém pediu informações da sua conta por outro número. Não há valores em aberto. Se não foi você, pode ignorar esta mensagem.`;
    const jid = registeredToJid(c.phone);
    if (!jid) return false;
    await this.withInFlight(() => this.deps.wa.sendText(jid, body));
    return true;
  }
}
