// Converte os eventos de webhook da Evolution em eventos simples para o motor.
import type { MessageKind } from "../../shared/types";
import { isGroupJid, isLidJid, jidToPhone } from "../engine/phone";

type Json = Record<string, unknown>;

export interface InboundMessage {
  type: "message";
  waMessageId: string;
  /** JID usado para responder (o mesmo que chegou). */
  remoteJid: string;
  /** Telefone em dígitos (resolvido mesmo quando o WhatsApp manda @lid). */
  phone: string;
  fromMe: boolean;
  pushName: string;
  kind: MessageKind;
  text: string | null;
  mimetype: string | null;
  fileName: string | null;
  durationSec: number | null;
  /** Mídia já embutida no webhook (quando "base64" está ligado na Evolution). */
  base64: string | null;
  timestamp: number;
  /** Mensagem de status, protocolo, reação vazia etc. — deve ser ignorada. */
  ignorable: boolean;
}

export interface ConnectionEvent {
  type: "connection";
  state: "open" | "connecting" | "close" | "unknown";
}

export interface QrEvent {
  type: "qr";
  qrBase64: string | null;
  pairingCode: string | null;
}

export interface AckEvent {
  type: "ack";
  waMessageId: string;
  status: string;
}

export type EvolutionEvent = InboundMessage | ConnectionEvent | QrEvent | AckEvent;

function asObj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function normalizeEvent(name: unknown): string {
  return String(name ?? "").toLowerCase().replace(/_/g, ".");
}

/** Desembrulha mensagens efêmeras, de visualização única e editadas. */
function unwrap(message: Json): Json {
  let m = message;
  for (let i = 0; i < 4; i++) {
    const inner =
      asObj(m.ephemeralMessage).message ??
      asObj(m.viewOnceMessage).message ??
      asObj(m.viewOnceMessageV2).message ??
      asObj(m.documentWithCaptionMessage).message;
    if (!inner) break;
    m = asObj(inner);
  }
  return m;
}

function parseMessage(data: Json): InboundMessage | null {
  const key = asObj(data.key);
  const remoteJid = String(key.remoteJid ?? "");
  const waMessageId = String(key.id ?? "");
  if (!remoteJid || !waMessageId) return null;

  // Em contas com "LID", o telefone real vem em remoteJidAlt / senderPn.
  let phoneJid: string | null = remoteJid;
  if (isLidJid(remoteJid)) {
    const alt = key.remoteJidAlt ?? key.senderPn ?? data.senderPn;
    phoneJid = alt && !isLidJid(String(alt)) ? String(alt) : null;
  }

  const message = unwrap(asObj(data.message));
  const messageType = String(data.messageType ?? "");
  let kind: MessageKind = "unknown";
  let text: string | null = null;
  let mimetype: string | null = null;
  let fileName: string | null = null;
  let durationSec: number | null = null;
  let ignorable = false;

  if (typeof message.conversation === "string") {
    kind = "text";
    text = message.conversation;
  } else if (message.extendedTextMessage) {
    kind = "text";
    text = String(asObj(message.extendedTextMessage).text ?? "");
  } else if (message.audioMessage) {
    const a = asObj(message.audioMessage);
    kind = "audio";
    mimetype = String(a.mimetype ?? "audio/ogg; codecs=opus");
    durationSec = a.seconds == null ? null : Number(a.seconds);
  } else if (message.imageMessage) {
    const im = asObj(message.imageMessage);
    kind = "image";
    mimetype = String(im.mimetype ?? "image/jpeg");
    text = im.caption ? String(im.caption) : null;
  } else if (message.videoMessage) {
    const v = asObj(message.videoMessage);
    kind = "video";
    mimetype = String(v.mimetype ?? "video/mp4");
    text = v.caption ? String(v.caption) : null;
  } else if (message.documentMessage) {
    const d = asObj(message.documentMessage);
    kind = "document";
    mimetype = String(d.mimetype ?? "application/octet-stream");
    fileName = d.fileName ? String(d.fileName) : d.title ? String(d.title) : null;
    text = d.caption ? String(d.caption) : null;
  } else if (message.stickerMessage) {
    kind = "sticker";
    mimetype = String(asObj(message.stickerMessage).mimetype ?? "image/webp");
  } else if (message.locationMessage || message.liveLocationMessage) {
    const l = asObj(message.locationMessage ?? message.liveLocationMessage);
    kind = "location";
    text = [l.name, l.address].filter(Boolean).join(" · ") || `${l.degreesLatitude}, ${l.degreesLongitude}`;
  } else if (message.contactMessage || message.contactsArrayMessage) {
    kind = "contact";
    const c = asObj(message.contactMessage);
    text = c.displayName ? String(c.displayName) : "Contato";
  } else if (message.reactionMessage) {
    kind = "reaction";
    text = String(asObj(message.reactionMessage).text ?? "");
    ignorable = !text;
  } else if (message.protocolMessage || message.senderKeyDistributionMessage || messageType === "protocolMessage") {
    ignorable = true;
  } else if (messageType === "conversation" && typeof data.body === "string") {
    kind = "text";
    text = data.body;
  }

  const base64 = typeof message.base64 === "string" ? message.base64 : typeof data.base64 === "string" ? data.base64 : null;
  const rawTs = Number(data.messageTimestamp ?? 0);
  const timestamp = rawTs > 1e12 ? rawTs : rawTs > 0 ? rawTs * 1000 : Date.now();

  return {
    type: "message",
    waMessageId,
    remoteJid,
    phone: phoneJid ? jidToPhone(phoneJid) : "",
    fromMe: key.fromMe === true,
    pushName: String(data.pushName ?? ""),
    kind,
    text,
    mimetype,
    fileName,
    durationSec,
    base64,
    timestamp,
    ignorable: ignorable || isGroupJid(remoteJid) || remoteJid === "status@broadcast",
  };
}

export function parseWebhook(body: unknown): EvolutionEvent[] {
  const root = asObj(body);
  const event = normalizeEvent(root.event);
  const data = root.data;
  const out: EvolutionEvent[] = [];

  if (event === "messages.upsert" || event === "send.message") {
    const list = Array.isArray(data) ? data : Array.isArray(asObj(data).messages) ? (asObj(data).messages as unknown[]) : [data];
    for (const item of list) {
      const m = parseMessage(asObj(item));
      if (m) out.push(m);
    }
  } else if (event === "connection.update") {
    const st = String(asObj(data).state ?? "unknown");
    out.push({ type: "connection", state: st === "open" || st === "connecting" || st === "close" ? st : "unknown" });
  } else if (event === "qrcode.updated") {
    const qr = asObj(asObj(data).qrcode);
    out.push({
      type: "qr",
      qrBase64: (qr.base64 ?? asObj(data).base64 ?? null) as string | null,
      pairingCode: (qr.pairingCode ?? null) as string | null,
    });
  } else if (event === "messages.update") {
    const list = Array.isArray(data) ? data : [data];
    for (const item of list) {
      const o = asObj(item);
      const id = String(o.keyId ?? asObj(o.key).id ?? "");
      if (id) out.push({ type: "ack", waMessageId: id, status: String(o.status ?? "") });
    }
  }
  return out;
}
