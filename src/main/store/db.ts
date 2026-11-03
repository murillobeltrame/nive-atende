// Banco local em SQLite (módulo nativo node:sqlite — sem dependência compilada).
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  AiAction,
  AuditEntry,
  ChatMessage,
  Conversation,
  ConversationFilter,
  ConversationState,
  MessageKind,
  MessageOrigin,
  MessageStatus,
  Reservation,
  ReservationStatus,
  ReservationCustomerStatus,
  SystemEventType,
  UsageBucket,
} from "../../shared/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  customer_id TEXT,
  customer_name TEXT,
  verified_by TEXT,
  state TEXT NOT NULL DEFAULT 'ia',
  last_message_at INTEGER NOT NULL DEFAULT 0,
  last_preview TEXT NOT NULL DEFAULT '',
  last_origin TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  ai_paused_until INTEGER,
  handoff_reason TEXT,
  last_ai_actions TEXT NOT NULL DEFAULT '[]',
  ai_replies INTEGER NOT NULL DEFAULT 0,
  human_replies INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  out_of_hours_notice_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  wa_message_id TEXT,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  transcript TEXT,
  media_mime TEXT,
  has_media INTEGER NOT NULL DEFAULT 0,
  file_name TEXT,
  duration_sec REAL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  author TEXT,
  event_type TEXT,
  processed INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_wa ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS media (
  message_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_sessions (
  conversation_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  customer_id TEXT,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  product_description TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  sale_id TEXT,
  order_number INTEGER,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  ai_replies INTEGER NOT NULL DEFAULT 0,
  human_replies INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  transcription_seconds REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  phone TEXT NOT NULL,
  customer_id TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface NewMessage {
  conversationId: string;
  waMessageId?: string | null;
  origin: MessageOrigin;
  kind: MessageKind;
  text?: string | null;
  transcript?: string | null;
  mediaMime?: string | null;
  hasMedia?: boolean;
  fileName?: string | null;
  durationSec?: number | null;
  createdAt?: number;
  status: MessageStatus;
  author?: string | null;
  eventType?: SystemEventType | null;
  /** false = mensagem do cliente ainda não tratada pelo motor. */
  processed?: boolean;
}

function parseCandidates(v: string | null): Array<{ id: string; name: string }> {
  if (!v) return [];
  try {
    const arr = JSON.parse(v) as Array<{ id?: unknown; name?: unknown }>;
    return Array.isArray(arr) ? arr.filter((c) => c && c.id && c.name).map((c) => ({ id: String(c.id), name: String(c.name) })) : [];
  } catch {
    return [];
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const cols = (this.db.prepare("PRAGMA table_info(reservations)").all() as Row[]).map((c) => str(c.name));
    const convCols = (this.db.prepare("PRAGMA table_info(conversations)").all() as Row[]).map((c) => str(c.name));
    if (!convCols.includes("push_name")) this.db.exec("ALTER TABLE conversations ADD COLUMN push_name TEXT");
    if (!convCols.includes("saved_name")) this.db.exec("ALTER TABLE conversations ADD COLUMN saved_name TEXT");
    if (!cols.includes("customer_candidates")) this.db.exec("ALTER TABLE reservations ADD COLUMN customer_candidates TEXT");
    if (!cols.includes("customer_status")) this.db.exec("ALTER TABLE reservations ADD COLUMN customer_status TEXT NOT NULL DEFAULT 'none'");
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ kv / segredos
  getKv<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? (JSON.parse(str(row.value)) as T) : null;
  }

  setKv(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  getSecretBlob(key: string): Uint8Array | null {
    const row = this.db.prepare("SELECT value FROM secrets WHERE key = ?").get(key) as Row | undefined;
    return row ? (row.value as Uint8Array) : null;
  }

  setSecretBlob(key: string, value: Uint8Array): void {
    this.db
      .prepare("INSERT INTO secrets(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteSecret(key: string): void {
    this.db.prepare("DELETE FROM secrets WHERE key = ?").run(key);
  }

  // ------------------------------------------------------------ conversas
  private toConversation(r: Row): Conversation {
    return {
      id: str(r.id),
      phone: str(r.phone),
      displayName: strOrNull(r.saved_name) || strOrNull(r.push_name) || str(r.display_name),
      pushName: strOrNull(r.push_name),
      savedName: strOrNull(r.saved_name),
      customerId: strOrNull(r.customer_id),
      customerName: strOrNull(r.customer_name),
      verifiedBy: (strOrNull(r.verified_by) as Conversation["verifiedBy"]) ?? null,
      state: str(r.state) as ConversationState,
      lastMessageAt: num(r.last_message_at),
      lastPreview: str(r.last_preview),
      lastOrigin: strOrNull(r.last_origin) as MessageOrigin | null,
      unread: num(r.unread),
      aiPausedUntil: numOrNull(r.ai_paused_until),
      handoffReason: strOrNull(r.handoff_reason),
      lastAiActions: JSON.parse(str(r.last_ai_actions) || "[]") as AiAction[],
      aiRepliesCount: num(r.ai_replies),
      humanRepliesCount: num(r.human_replies),
      costUsd: num(r.cost_usd),
    };
  }

  /** Apaga a conversa do app: mensagens, mídias e anotações internas. As reservas ficam (são registro da loja). */
  deleteConversation(id: string): void {
    const run = this.db.prepare.bind(this.db);
    this.db.exec("BEGIN");
    try {
      run("DELETE FROM media WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)").run(id);
      run("DELETE FROM messages WHERE conversation_id = ?").run(id);
      run("DELETE FROM identity_sessions WHERE conversation_id = ?").run(id);
      for (const k of ["personal", "personalNotice", "offered", "followup", "avatar"]) run("DELETE FROM kv WHERE key = ?").run(`${k}:${id}`);
      run("DELETE FROM conversations WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getConversation(id: string): Conversation | null {
    const r = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toConversation(r) : null;
  }

  ensureConversation(id: string, phone: string, displayName: string): Conversation {
    if (displayName) this.setPushName(id, displayName);
    const existing = this.getConversation(id);
    if (existing && phone && existing.phone !== phone && /^55\d{10,11}$/.test(phone)) {
      this.db.prepare("UPDATE conversations SET phone = ? WHERE id = ?").run(phone, id);
      existing.phone = phone;
    }
    if (existing) {
      if (displayName && displayName !== existing.displayName && !existing.customerName) {
        this.db.prepare("UPDATE conversations SET display_name = ? WHERE id = ?").run(displayName, id);
        return { ...existing, displayName };
      }
      return existing;
    }
    this.db
      .prepare("INSERT INTO conversations(id, phone, display_name) VALUES(?, ?, ?)")
      .run(id, phone, displayName || phone);
    if (displayName) this.setPushName(id, displayName);
    return this.getConversation(id)!;
  }

  /** Nome que o contato definiu no próprio WhatsApp (só grava se a conversa existir). */
  setPushName(id: string, name: string): Conversation | null {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean || /^\+?[\d\s()-]+$/.test(clean)) return this.getConversation(id);
    this.db.prepare("UPDATE conversations SET push_name = ? WHERE id = ? AND (push_name IS NULL OR push_name <> ?)").run(clean, id, clean);
    return this.getConversation(id);
  }

  /** Nome dado pelo lojista (null volta a usar o nome do perfil). */
  setSavedName(id: string, name: string | null): Conversation {
    const clean = name?.replace(/\s+/g, " ").trim().slice(0, 80) || null;
    this.db.prepare("UPDATE conversations SET saved_name = ? WHERE id = ?").run(clean, id);
    return this.getConversation(id)!;
  }

  updateConversation(id: string, patch: Partial<Conversation> & { outOfHoursNoticeAt?: number | null }): Conversation {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      displayName: ["display_name", (v) => v],
      customerId: ["customer_id", (v) => v],
      customerName: ["customer_name", (v) => v],
      verifiedBy: ["verified_by", (v) => v],
      state: ["state", (v) => v],
      lastMessageAt: ["last_message_at", (v) => v],
      lastPreview: ["last_preview", (v) => v],
      lastOrigin: ["last_origin", (v) => v],
      unread: ["unread", (v) => v],
      aiPausedUntil: ["ai_paused_until", (v) => v],
      handoffReason: ["handoff_reason", (v) => v],
      lastAiActions: ["last_ai_actions", (v) => JSON.stringify(v)],
      aiRepliesCount: ["ai_replies", (v) => v],
      humanRepliesCount: ["human_replies", (v) => v],
      costUsd: ["cost_usd", (v) => v],
      outOfHoursNoticeAt: ["out_of_hours_notice_at", (v) => v],
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = ?`);
      values.push(m[1](v ?? null) as string | number | null);
    }
    if (sets.length) {
      this.db.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    return this.getConversation(id)!;
  }

  getOutOfHoursNoticeAt(id: string): number | null {
    const r = this.db.prepare("SELECT out_of_hours_notice_at AS v FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return r ? numOrNull(r.v) : null;
  }

  addAiAction(id: string, action: AiAction): Conversation {
    const conv = this.getConversation(id);
    if (!conv) throw new Error("conversa não encontrada");
    const actions = [...conv.lastAiActions, action].slice(-8);
    return this.updateConversation(id, { lastAiActions: actions });
  }

  listConversations(filter: ConversationFilter, q?: string): Conversation[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter === "precisa") where.push("state = 'precisa_humano'");
    if (filter === "ia") where.push("state = 'ia'");
    if (filter === "humano") where.push("state = 'humano'");
    if (q?.trim()) {
      where.push("(display_name LIKE ? OR customer_name LIKE ? OR phone LIKE ?)");
      const like = `%${q.trim()}%`;
      params.push(like, like, `%${q.replace(/\D/g, "") || q.trim()}%`);
    }
    const sql = `SELECT * FROM conversations ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY last_message_at DESC LIMIT 300`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.toConversation(r));
  }

  countByState(state: ConversationState): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE state = ?").get(state) as Row;
    return num(r.n);
  }

  // ------------------------------------------------------------ mensagens
  private toMessage(r: Row): ChatMessage {
    return {
      id: str(r.id),
      conversationId: str(r.conversation_id),
      waMessageId: strOrNull(r.wa_message_id),
      origin: str(r.origin) as MessageOrigin,
      kind: str(r.kind) as MessageKind,
      text: strOrNull(r.text),
      transcript: strOrNull(r.transcript),
      mediaMime: strOrNull(r.media_mime),
      hasMedia: num(r.has_media) === 1,
      fileName: strOrNull(r.file_name),
      durationSec: numOrNull(r.duration_sec),
      createdAt: num(r.created_at),
      status: str(r.status) as MessageStatus,
      author: strOrNull(r.author),
      eventType: strOrNull(r.event_type) as SystemEventType | null,
    };
  }

  insertMessage(m: NewMessage): ChatMessage {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO messages(id, conversation_id, wa_message_id, origin, kind, text, transcript, media_mime,
          has_media, file_name, duration_sec, created_at, status, author, event_type, processed)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        m.conversationId,
        m.waMessageId ?? null,
        m.origin,
        m.kind,
        m.text ?? null,
        m.transcript ?? null,
        m.mediaMime ?? null,
        m.hasMedia ? 1 : 0,
        m.fileName ?? null,
        m.durationSec ?? null,
        m.createdAt ?? Date.now(),
        m.status,
        m.author ?? null,
        m.eventType ?? null,
        m.processed === false ? 0 : 1,
      );
    return this.getMessage(id)!;
  }

  getMessage(id: string): ChatMessage | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toMessage(r) : null;
  }

  getMessageByWaId(waId: string): ChatMessage | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE wa_message_id = ?").get(waId) as Row | undefined;
    return r ? this.toMessage(r) : null;
  }

  updateMessage(id: string, patch: { waMessageId?: string | null; status?: MessageStatus; transcript?: string | null; text?: string | null }): ChatMessage {
    if (patch.waMessageId !== undefined) this.db.prepare("UPDATE messages SET wa_message_id = ? WHERE id = ?").run(patch.waMessageId, id);
    if (patch.status !== undefined) this.db.prepare("UPDATE messages SET status = ? WHERE id = ?").run(patch.status, id);
    if (patch.transcript !== undefined) this.db.prepare("UPDATE messages SET transcript = ? WHERE id = ?").run(patch.transcript, id);
    if (patch.text !== undefined) this.db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(patch.text, id);
    return this.getMessage(id)!;
  }

  listMessages(conversationId: string, limit = 300): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC")
      .all(conversationId, limit) as Row[];
    return rows.map((r) => this.toMessage(r));
  }

  /** Textos recentes enviados pela equipe (app ou celular), mais novos primeiro. */
  listRecentHumanReplies(limit = 40): string[] {
    const rows = this.db
      .prepare(
        "SELECT text FROM messages WHERE origin IN ('humano_app','humano_celular') AND kind = 'text' AND text IS NOT NULL AND status <> 'deleted' ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as Row[];
    return rows.map((r) => str(r.text));
  }

  /** Mensagens do cliente ainda não tratadas pelo motor. */
  listUnprocessed(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND processed = 0 ORDER BY created_at ASC")
      .all(conversationId) as Row[];
    return rows.map((r) => this.toMessage(r));
  }

  conversationsWithUnprocessed(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT conversation_id AS id FROM messages WHERE processed = 0").all() as Row[];
    return rows.map((r) => str(r.id));
  }

  markProcessed(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE messages SET processed = 1 WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  countUnprocessed(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE processed = 0").get() as Row;
    return num(r.n);
  }

  saveMedia(messageId: string, mime: string, data: Uint8Array): void {
    this.db
      .prepare("INSERT INTO media(message_id, mime, data) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET mime = excluded.mime, data = excluded.data")
      .run(messageId, mime, data);
  }

  getMedia(messageId: string): { mime: string; data: Uint8Array } | null {
    const r = this.db.prepare("SELECT mime, data FROM media WHERE message_id = ?").get(messageId) as Row | undefined;
    return r ? { mime: str(r.mime), data: r.data as Uint8Array } : null;
  }

  // ------------------------------------------------------------ identificação
  getIdentitySession<T>(conversationId: string): T | null {
    const r = this.db.prepare("SELECT data FROM identity_sessions WHERE conversation_id = ?").get(conversationId) as Row | undefined;
    return r ? (JSON.parse(str(r.data)) as T) : null;
  }

  setIdentitySession(conversationId: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO identity_sessions(conversation_id, data) VALUES(?, ?) ON CONFLICT(conversation_id) DO UPDATE SET data = excluded.data")
      .run(conversationId, JSON.stringify(data));
  }

  // ------------------------------------------------------------ reservas
  private toReservation(r: Row): Reservation {
    return {
      id: str(r.id),
      conversationId: str(r.conversation_id),
      customerName: str(r.customer_name),
      phone: str(r.phone),
      productId: str(r.product_id),
      variantId: str(r.variant_id),
      productDescription: str(r.product_description),
      variantLabel: str(r.variant_label),
      quantity: num(r.quantity),
      unitPrice: num(r.unit_price),
      saleId: strOrNull(r.sale_id),
      orderNumber: numOrNull(r.order_number),
      status: str(r.status) as ReservationStatus,
      customerStatus: (strOrNull(r.customer_status) ?? "none") as ReservationCustomerStatus,
      customerCandidates: parseCandidates(strOrNull(r.customer_candidates)),
      expiresAt: num(r.expires_at),
      createdAt: num(r.created_at),
      error: strOrNull(r.error),
    };
  }

  insertReservation(r: Omit<Reservation, "id" | "createdAt"> & { customerId: string | null; createdAt?: number }): Reservation {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO reservations(id, conversation_id, customer_id, customer_name, phone, product_id, variant_id,
          product_description, variant_label, quantity, unit_price, sale_id, order_number, status, expires_at, created_at, error, customer_status, customer_candidates)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, r.conversationId, r.customerId, r.customerName, r.phone, r.productId, r.variantId,
        r.productDescription, r.variantLabel, r.quantity, r.unitPrice, r.saleId, r.orderNumber,
        r.status, r.expiresAt, r.createdAt ?? Date.now(), r.error, r.customerStatus, JSON.stringify(r.customerCandidates ?? []),
      );
    return this.getReservation(id)!;
  }

  getReservation(id: string): Reservation | null {
    const r = this.db.prepare("SELECT * FROM reservations WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toReservation(r) : null;
  }

  getReservationCustomerId(id: string): string | null {
    const r = this.db.prepare("SELECT customer_id FROM reservations WHERE id = ?").get(id) as Row | undefined;
    return r ? strOrNull(r.customer_id) : null;
  }

  updateReservation(
    id: string,
    patch: {
      status?: ReservationStatus;
      saleId?: string | null;
      orderNumber?: number | null;
      error?: string | null;
      customerId?: string | null;
      customerStatus?: ReservationCustomerStatus;
      customerName?: string;
      customerCandidates?: Array<{ id: string; name: string }>;
    },
  ): Reservation {
    if (patch.customerName !== undefined) this.db.prepare("UPDATE reservations SET customer_name = ? WHERE id = ?").run(patch.customerName, id);
    if (patch.customerCandidates !== undefined)
      this.db.prepare("UPDATE reservations SET customer_candidates = ? WHERE id = ?").run(JSON.stringify(patch.customerCandidates), id);
    if (patch.customerId !== undefined) this.db.prepare("UPDATE reservations SET customer_id = ? WHERE id = ?").run(patch.customerId, id);
    if (patch.customerStatus !== undefined) this.db.prepare("UPDATE reservations SET customer_status = ? WHERE id = ?").run(patch.customerStatus, id);
    if (patch.status !== undefined) this.db.prepare("UPDATE reservations SET status = ? WHERE id = ?").run(patch.status, id);
    if (patch.saleId !== undefined) this.db.prepare("UPDATE reservations SET sale_id = ? WHERE id = ?").run(patch.saleId, id);
    if (patch.orderNumber !== undefined) this.db.prepare("UPDATE reservations SET order_number = ? WHERE id = ?").run(patch.orderNumber, id);
    if (patch.error !== undefined) this.db.prepare("UPDATE reservations SET error = ? WHERE id = ?").run(patch.error, id);
    return this.getReservation(id)!;
  }

  listReservations(limit = 200): Reservation[] {
    return (this.db.prepare("SELECT * FROM reservations ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map((r) =>
      this.toReservation(r),
    );
  }

  /** Reservas vencidas que ainda estão ativas (rascunho criado ou aguardando aprovação). */
  listExpiredActiveReservations(now: number): Reservation[] {
    return (
      this.db.prepare("SELECT * FROM reservations WHERE status IN ('created','pending_approval') AND expires_at <= ? ORDER BY expires_at").all(now) as Row[]
    ).map((r) => this.toReservation(r));
  }

  countPendingReservations(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'pending_approval'").get() as Row;
    return num(r.n);
  }

  /** Quantidade já reservada (rascunhos ainda válidos ou aguardando aprovação) de uma variante. */
  reservedQuantity(variantId: string, now = Date.now()): number {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(quantity), 0) AS q FROM reservations WHERE variant_id = ? AND status IN ('created','pending_approval') AND expires_at > ?",
      )
      .get(variantId, now) as Row;
    return num(r.q);
  }

  // ------------------------------------------------------------ consumo
  addUsage(ts: number, delta: Partial<UsageBucket>): void {
    const day = localDay(ts);
    this.db.prepare("INSERT INTO usage(day) VALUES(?) ON CONFLICT(day) DO NOTHING").run(day);
    this.db
      .prepare(
        `UPDATE usage SET ai_replies = ai_replies + ?, human_replies = human_replies + ?, input_tokens = input_tokens + ?,
          output_tokens = output_tokens + ?, transcription_seconds = transcription_seconds + ?, cost_usd = cost_usd + ?
         WHERE day = ?`,
      )
      .run(
        delta.aiReplies ?? 0,
        delta.humanReplies ?? 0,
        delta.inputTokens ?? 0,
        delta.outputTokens ?? 0,
        delta.transcriptionSeconds ?? 0,
        delta.costUsd ?? 0,
        day,
      );
  }

  usageBetween(fromDay: string, toDay: string): Array<{ day: string } & UsageBucket> {
    const rows = this.db.prepare("SELECT * FROM usage WHERE day >= ? AND day <= ? ORDER BY day ASC").all(fromDay, toDay) as Row[];
    return rows.map((r) => ({
      day: str(r.day),
      aiReplies: num(r.ai_replies),
      humanReplies: num(r.human_replies),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      transcriptionSeconds: num(r.transcription_seconds),
      costUsd: num(r.cost_usd),
    }));
  }

  /** Números de um dia (início/fim em ms) para o resumo diário. */
  daySummary(from: number, to: number): {
    conversations: number;
    newContacts: number;
    unanswered: number;
    reservationsCreated: number;
    reservationsPending: number;
    reservationsCompleted: number;
  } {
    const one = (sql: string, ...p: Array<number | string>) => num((this.db.prepare(sql).get(...p) as Row).n);
    return {
      conversations: one("SELECT COUNT(DISTINCT conversation_id) AS n FROM messages WHERE origin = 'consumidor' AND created_at >= ? AND created_at < ?", from, to),
      newContacts: one(
        "SELECT COUNT(*) AS n FROM (SELECT conversation_id, MIN(created_at) AS f FROM messages WHERE origin = 'consumidor' GROUP BY conversation_id) WHERE f >= ? AND f < ?",
        from,
        to,
      ),
      unanswered: one("SELECT COUNT(*) AS n FROM conversations WHERE (state = 'precisa_humano' OR last_origin = 'consumidor') AND state <> 'ignorado' AND last_message_at >= ? AND last_message_at < ?", from, to),
      reservationsCreated: one("SELECT COUNT(*) AS n FROM reservations WHERE created_at >= ? AND created_at < ?", from, to),
      reservationsPending: one("SELECT COUNT(*) AS n FROM reservations WHERE status = 'pending_approval'"),
      reservationsCompleted: one("SELECT COUNT(*) AS n FROM reservations WHERE status = 'completed' AND created_at >= ?", from - 7 * 86_400_000),
    };
  }

  // ------------------------------------------------------------ auditoria
  audit(phone: string, customerId: string | null, action: string, result: string): void {
    this.db
      .prepare("INSERT INTO audit(at, phone, customer_id, action, result) VALUES(?,?,?,?,?)")
      .run(Date.now(), phone, customerId, action, result);
  }

  listAudit(limit = 200): AuditEntry[] {
    return (this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: num(r.id),
      at: num(r.at),
      phone: str(r.phone),
      customerId: strOrNull(r.customer_id),
      action: str(r.action),
      result: str(r.result),
    }));
  }
}
