// Motor de atendimento: recebe eventos do WhatsApp, decide quando a IA responde e grava quem respondeu.
import { EventEmitter } from "node:events";
import { toWhatsApp } from "../ai/format";
import type { AppSettings, ChatMessage, Conversation, Reservation, SystemEventType } from "../../shared/types";
import type { Store } from "../store/db";
import type { NiveApi, NiveProduct } from "../nive/client";
import type { WhatsAppGateway } from "../evolution/client";
import type { InboundMessage } from "../evolution/parse";
import { AiError, estimateChatCost, estimateTranscriptionCost, type AiMessage, type AiProvider } from "../ai/openai";
import { buildSystemPrompt } from "../ai/prompt";
import { newRunState, runTool, toolsFor, type ToolRunState } from "../ai/tools";
import type { Transcoder } from "../audio/transcode";
import { IdentityService } from "./identity";
import { extractMoneyValues, formatBRL, guardText } from "./guard";
import { localDay } from "../store/db";
import { digitsOnly, registeredToJid, samePhone } from "./phone";

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
  usage: [];
}

const MAX_TOOL_ROUNDS = 7;
/** Limite de texto do histórico enviado à IA (mantém o custo previsível). */
const HISTORY_CHAR_BUDGET = 16000;
const OUT_OF_HOURS_NOTICE_INTERVAL_MS = 12 * 60 * 60 * 1000;

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
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly timers = new Map<string, { timer: unknown; firstAt: number }>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();
  /** IDs de mensagens que o app está enviando agora (para não confundir com resposta do celular). */
  private readonly inFlight = new Set<string>();
  private inFlightCount = 0;

  constructor(private readonly deps: EngineDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
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
    const timer = this.setTimer(() => {
      this.timers.delete(conversationId);
      void this.process(conversationId);
    }, wait);
    this.timers.set(conversationId, { timer, firstAt });
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
      if (!last || this.now() - last > OUT_OF_HOURS_NOTICE_INTERVAL_MS) {
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

    // a partir daqui a IA vai trabalhar: o cliente vê "digitando…" enquanto ela busca e responde
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
    store.markProcessed(ids);
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

    for (const photo of state.photos.slice(0, 2)) {
      await this.sendAiMedia(conv.id, photo.url, photo.caption);
    }
    if (reply) await this.sendAiText(conv.id, reply, { countsAsAiReply: true });
    if (state.handoffReason) return this.handoff(conv.id, state.handoffReason, false);
    if (!reply && !state.photos.length) return this.handoff(conv.id, "a IA não soube responder");
  }

  /** Mostra "digitando…" para o cliente e renova a cada 8 s (o WhatsApp apaga sozinho depois de uns 25 s). */
  private typing = new Map<string, unknown>();

  private startTyping(jid: string): void {
    if (this.typing.has(jid)) return;
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
      const text = await this.deps.ai.transcribe(this.s.openai.transcribeModel, mp3, "audio.mp3");
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
      if (m.origin === "consumidor") out.push({ role: "user", content });
      else out.push({ role: "assistant", content: m.origin === "ia" ? content : `(resposta da equipe da loja) ${content}` });
    }
    // corta as mais antigas se o texto passar do limite (sempre mantém as mais recentes)
    let total = out.reduce((n, m) => n + String(m.content ?? "").length, 0);
    while (out.length > 4 && total > HISTORY_CHAR_BUDGET) total -= String(out.shift()!.content ?? "").length;
    while (out.length && out[0]!.role === "assistant") out.shift();
    return out;
  }

  private async runAi(conversationId: string, readOnly: boolean): Promise<{ reply: string | null; state: ToolRunState }> {
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
    });
    const messages: AiMessage[] = [{ role: "system", content: system }, ...this.buildHistory(conversationId)];
    const tools = toolsFor(s, readOnly);
    const state = newRunState();
    let inTok = 0;
    let outTok = 0;
    let reply: string | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await this.deps.ai.chat(s.openai.model, messages, tools);
      inTok += res.inputTokens;
      outTok += res.outputTokens;
      if (!res.toolCalls.length) {
        reply = res.content ? toWhatsApp(res.content) || null : null;
        break;
      }
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
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

    const cost = estimateChatCost(s.openai.model, inTok, outTok);
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
    const msg = store.insertMessage({ conversationId, origin: "ia", kind: "text", text, status: "pending" });
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

  private async sendAiMedia(conversationId: string, url: string, caption: string): Promise<void> {
    const store = this.deps.store;
    // baixa a foto uma vez: o mesmo arquivo vai para o cliente e fica visível na conversa do app
    const img = await (this.deps.fetchImage ?? defaultFetchImage)(url).catch(() => null);
    const mime = img?.mime ?? "image/jpeg";
    const msg = store.insertMessage({ conversationId, origin: "ia", kind: "image", text: caption, mediaMime: mime, hasMedia: Boolean(img), status: "pending" });
    if (img) store.saveMedia(msg.id, mime, img.data);
    this.emit("message", msg);
    try {
      const media = img ? img.data.toString("base64") : url;
      const r = await this.withInFlight(() => this.deps.wa.sendMedia(conversationId, { mediatype: "image", mimetype: mime, media, caption: "" }));
      this.emit("message", store.updateMessage(msg.id, { waMessageId: r.waMessageId, status: "sent" }));
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
  private async createReservation(
    conversationId: string,
    input: { product: NiveProduct; variantId: string; variantLabel: string; quantity: number; unitPrice: number; customer: { id: string; name: string } | null },
  ): Promise<Reservation> {
    const store = this.deps.store;
    const s = this.s;
    const conv = store.getConversation(conversationId)!;
    const expiresAt = this.now() + s.reservation.validityHours * 3_600_000;
    let r = store.insertReservation({
      conversationId,
      customerId: input.customer?.id ?? null,
      customerName: input.customer?.name ?? conv.customerName ?? conv.displayName,
      phone: conv.phone,
      productId: input.product.id,
      variantId: input.variantId,
      productDescription: input.product.description,
      variantLabel: input.variantLabel,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      saleId: null,
      orderNumber: null,
      status: s.reservation.autoEnabled ? "created" : "pending_approval",
      expiresAt,
      error: null,
    });
    if (s.reservation.autoEnabled) {
      r = await this.pushReservationToErp(r);
      if (r.status === "created") {
        this.addSystemEvent(conversationId, "reservation_created", `Reserva criada como rascunho${r.orderNumber ? ` · pedido #${r.orderNumber}` : ""}`);
        this.emit("notify", { kind: "reservation_created", title: "Nova reserva pelo WhatsApp", body: `${r.quantity}× ${r.productDescription} · ${r.customerName}`, conversationId });
      }
    } else {
      this.addSystemEvent(conversationId, "reservation_pending", `Pedido de reserva aguardando sua aprovação: ${r.quantity}× ${r.productDescription}`);
      this.emit("notify", { kind: "reservation_pending", title: "Reserva aguardando aprovação", body: `${r.quantity}× ${r.productDescription} · ${r.customerName}`, conversationId });
    }
    this.emit("reservation", r);
    return r;
  }

  private async pushReservationToErp(r: Reservation): Promise<Reservation> {
    const store = this.deps.store;
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

  async approveReservation(id: string): Promise<Reservation> {
    const store = this.deps.store;
    let r = store.getReservation(id);
    if (!r) throw new Error("Reserva não encontrada");
    if (r.status !== "pending_approval" && r.status !== "failed") return r;
    r = await this.pushReservationToErp(r);
    this.emit("reservation", r);
    if (r.status === "created") {
      this.addSystemEvent(r.conversationId, "reservation_created", `Reserva aprovada e criada como rascunho${r.orderNumber ? ` · pedido #${r.orderNumber}` : ""}`);
      const validade = new Date(r.expiresAt).toLocaleString("pt-BR", { weekday: "long", hour: "2-digit", minute: "2-digit" });
      await this.sendAiText(
        r.conversationId,
        `Separado! ${r.quantity > 1 ? `${r.quantity} unidades de ` : ""}${r.productDescription}${r.variantLabel && r.variantLabel !== "Único" ? ` (${r.variantLabel})` : ""} fica reservado até ${validade}.`,
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
