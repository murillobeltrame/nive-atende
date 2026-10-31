// WhatsApp embutido: o motor Baileys (o mesmo usado pela Evolution) rodando dentro do app.
// Sem Docker, sem PostgreSQL. A sessão fica numa pasta local do app.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { WAMessage, WASocket } from "baileys";
import type { ConnectionState, SendResult } from "../evolution/client";
import { parseMessage, type EvolutionEvent } from "../evolution/parse";
import type { Transcoder } from "../audio/transcode";
import type { TestResult } from "../../shared/types";
import type { EngineHealth, WhatsAppService } from "./service";

type BaileysModule = typeof import("baileys");

const MEDIA_KINDS = new Set(["audio", "image", "video", "document", "sticker"]);
const MAX_AUTO_DOWNLOAD = 16 * 1024 * 1024;
const RAW_CACHE = 500;

function isRecent(msg: WAMessage, maxAgeMs = 2 * 60_000): boolean {
  const ts = msg.messageTimestamp as unknown;
  const sec = ts && typeof ts === "object" ? Number((ts as { toNumber?: () => number }).toNumber?.() ?? 0) : Number(ts ?? 0);
  return sec > 0 && Date.now() - sec * 1000 < maxAgeMs;
}

let modPromise: Promise<BaileysModule> | null = null;
/** Carrega o Baileys (pacote ESM) a partir do processo principal. */
export function loadBaileys(): Promise<BaileysModule> {
  if (!modPromise) {
    const req = createRequire(__filename);
    const url = pathToFileURL(req.resolve("baileys")).href;
    modPromise = import(url) as Promise<BaileysModule>;
  }
  return modPromise;
}

const silentLogger = {
  level: "silent",
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

export interface BaileysDeps {
  authDir: string;
  /** Converte áudio gravado (webm) para OGG/Opus, formato de mensagem de voz do WhatsApp. */
  toOggOpus: Transcoder;
  load?: () => Promise<BaileysModule>;
  appVersion?: string;
}

export class BaileysService implements WhatsAppService {
  readonly mode = "embedded" as const;
  private sock: WASocket | null = null;
  private state: ConnectionState = "close";
  private wanted = false;
  private listeners: Array<(e: EvolutionEvent[]) => void> = [];
  private lastQr: string | null = null;
  private qrWaiters: Array<() => void> = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 2000;
  private qrCount = 0;
  private raw = new Map<string, WAMessage>();
  private loadError: string | null = null;

  constructor(private readonly deps: BaileysDeps) {}

  onEvents(cb: (events: EvolutionEvent[]) => void): void {
    this.listeners.push(cb);
  }

  private emit(events: EvolutionEvent[]): void {
    for (const l of this.listeners) l(events);
  }

  private hasSession(): boolean {
    return existsSync(`${this.deps.authDir}/creds.json`);
  }

  async start(): Promise<void> {
    // Já pareado antes: reconecta sozinho ao abrir o app.
    if (this.hasSession()) {
      this.wanted = true;
      await this.open();
    }
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
    this.sock = null;
    this.setState("close");
  }

  async health(): Promise<EngineHealth> {
    try {
      await (this.deps.load ?? loadBaileys)();
      this.loadError = null;
      return { ok: true, message: "WhatsApp embutido pronto" };
    } catch (e) {
      this.loadError = (e as Error).message;
      return { ok: false, message: `O motor do WhatsApp não carregou: ${this.loadError}` };
    }
  }

  async connectionState(): Promise<ConnectionState> {
    return this.state;
  }

  async test(): Promise<TestResult> {
    const h = await this.health();
    if (!h.ok) return { ok: false, message: h.message };
    return {
      ok: true,
      message:
        this.state === "open"
          ? "WhatsApp embutido conectado."
          : "WhatsApp embutido pronto. Clique em Conectar WhatsApp e leia o QR Code com o celular da loja.",
    };
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit([{ type: "connection", state: s }]);
  }

  private async qrToDataUrl(qr: string): Promise<string> {
    const QR = (await import("qrcode")).default;
    return QR.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  }

  async connect(): Promise<{ state: ConnectionState; qrBase64: string | null; pairingCode: string | null }> {
    if (this.state === "open") return { state: "open", qrBase64: null, pairingCode: null };
    this.wanted = true;
    this.qrCount = 0;
    if (!this.sock) await this.open();
    // espera o primeiro QR (ou a conexão abrir, se já havia sessão)
    if (!this.lastQr && !this.isOpen()) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 20_000);
        this.qrWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (this.isOpen()) return { state: "open", qrBase64: null, pairingCode: null };
    return { state: "connecting", qrBase64: this.lastQr ? await this.qrToDataUrl(this.lastQr) : null, pairingCode: null };
  }

  private isOpen(): boolean {
    return this.state === "open";
  }

  async logout(): Promise<void> {
    this.wanted = false;
    try {
      await this.sock?.logout();
    } catch {
      /* já desconectado */
    }
    this.sock?.end(undefined);
    this.sock = null;
    this.clearSession();
    this.setState("close");
  }

  async restart(): Promise<void> {
    this.sock?.end(undefined);
    this.sock = null;
    this.wanted = true;
    await this.open();
  }

  private clearSession(): void {
    rmSync(this.deps.authDir, { recursive: true, force: true });
    this.raw.clear();
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, wait);
  }

  private async open(): Promise<void> {
    const b = await (this.deps.load ?? loadBaileys)();
    mkdirSync(this.deps.authDir, { recursive: true });
    const { state, saveCreds } = await b.useMultiFileAuthState(this.deps.authDir);
    this.sock?.end(undefined);
    this.setState("connecting");
    const sock = b.makeWASocket({
      auth: { creds: state.creds, keys: b.makeCacheableSignalKeyStore(state.keys, silentLogger as never) },
      logger: silentLogger as never,
      browser: ["Nive Atende", "Chrome", this.deps.appVersion ?? "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => (key.id ? this.raw.get(key.id)?.message ?? undefined : undefined),
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      if (sock !== this.sock) return; // socket antigo
      if (u.qr) {
        this.qrCount++;
        this.lastQr = u.qr;
        for (const w of this.qrWaiters.splice(0)) w();
        void this.qrToDataUrl(u.qr).then((qrBase64) => this.emit([{ type: "qr", qrBase64, pairingCode: null }]));
        // ninguém leu depois de vários QRs: para de gerar até pedirem de novo
        if (this.qrCount > 6 && !state.creds.registered) {
          this.wanted = false;
          sock.end(undefined);
        }
      }
      if (u.connection === "open") {
        this.lastQr = null;
        this.backoffMs = 2000;
        for (const w of this.qrWaiters.splice(0)) w();
        this.setState("open");
      } else if (u.connection === "connecting") {
        this.setState("connecting");
      } else if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        this.sock = null;
        this.lastQr = null;
        if (code === b.DisconnectReason.loggedOut) {
          // desconectado pelo celular: precisa ler o QR de novo
          this.clearSession();
          this.wanted = false;
          this.setState("close");
          return;
        }
        this.setState("close");
        if (code === b.DisconnectReason.restartRequired) {
          void this.open();
          return;
        }
        if (state.creds.registered || this.hasSession()) this.scheduleReconnect();
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" = mensagens novas. "append" traz, entre outras, as respostas que a loja manda pelo
      // celular: dessas só aceitamos as recentes enviadas pela própria loja (históricos são ignorados).
      for (const msg of messages) {
        if (type === "notify") void this.handleIncoming(b, sock, msg);
        else if (type === "append" && msg.key.fromMe && isRecent(msg)) void this.handleIncoming(b, sock, msg);
      }
    });

    sock.ev.on("messages.update", (updates) => {
      for (const u of updates) {
        const status = (u.update as { status?: number } | undefined)?.status;
        if (u.key.id && status === 0) this.emit([{ type: "ack", waMessageId: u.key.id, status: "ERROR" }]);
      }
    });
  }

  private remember(msg: WAMessage): void {
    if (!msg.key.id) return;
    this.raw.set(msg.key.id, msg);
    if (this.raw.size > RAW_CACHE) {
      const first = this.raw.keys().next().value;
      if (first) this.raw.delete(first);
    }
  }

  private async handleIncoming(b: BaileysModule, sock: WASocket, msg: WAMessage): Promise<void> {
    if (!msg.message) return;
    this.remember(msg);
    const parsed = parseMessage(msg as unknown as Record<string, unknown>);
    if (!parsed || parsed.ignorable) return;
    if (MEDIA_KINDS.has(parsed.kind) && !parsed.base64) {
      const size = Number(
        (Object.values(msg.message).find((v) => v && typeof v === "object" && "fileLength" in (v as object)) as { fileLength?: unknown } | undefined)?.fileLength ?? 0,
      );
      if (!size || size <= MAX_AUTO_DOWNLOAD) {
        try {
          const buf = await b.downloadMediaMessage(msg, "buffer", {}, { logger: silentLogger as never, reuploadRequest: sock.updateMediaMessage });
          parsed.base64 = Buffer.from(buf).toString("base64");
        } catch {
          /* baixa depois, sob demanda */
        }
      }
    }
    this.emit([parsed]);
  }

  // ------------------------------------------------------------------ envio
  private requireSock(): WASocket {
    if (!this.sock || this.state !== "open") throw new Error("WhatsApp não está conectado");
    return this.sock;
  }

  private static result(m: WAMessage | undefined): SendResult {
    return { waMessageId: m?.key.id ?? null };
  }

  async sendText(jid: string, text: string): Promise<SendResult> {
    return BaileysService.result(await this.requireSock().sendMessage(jid, { text }));
  }

  async sendMedia(
    jid: string,
    media: { mediatype: "image" | "video" | "document"; mimetype: string; media: string; fileName?: string; caption?: string },
  ): Promise<SendResult> {
    const src = /^https?:\/\//.test(media.media) ? { url: media.media } : Buffer.from(media.media, "base64");
    const sock = this.requireSock();
    const caption = media.caption || undefined;
    const content =
      media.mediatype === "image"
        ? { image: src, caption }
        : media.mediatype === "video"
          ? { video: src, caption }
          : { document: src, mimetype: media.mimetype, fileName: media.fileName ?? "arquivo", caption };
    return BaileysService.result(await sock.sendMessage(jid, content as never));
  }

  async sendAudio(jid: string, base64: string): Promise<SendResult> {
    const ogg = await this.deps.toOggOpus(Buffer.from(base64, "base64"));
    return BaileysService.result(
      await this.requireSock().sendMessage(jid, { audio: Buffer.from(ogg), mimetype: "audio/ogg; codecs=opus", ptt: true }),
    );
  }

  async sendSticker(jid: string, base64: string): Promise<SendResult> {
    return BaileysService.result(await this.requireSock().sendMessage(jid, { sticker: Buffer.from(base64, "base64") }));
  }

  async sendPresence(jid: string, presence: "composing" | "recording" | "paused"): Promise<void> {
    try {
      await this.sock?.sendPresenceUpdate(presence, jid);
    } catch {
      /* opcional */
    }
  }

  async getMediaBase64(waMessageId: string): Promise<{ base64: string; mimetype: string } | null> {
    const msg = this.raw.get(waMessageId);
    if (!msg?.message || !this.sock) return null;
    const b = await (this.deps.load ?? loadBaileys)();
    const parsed = parseMessage(msg as unknown as Record<string, unknown>);
    const buf = await b.downloadMediaMessage(msg, "buffer", {}, { logger: silentLogger as never, reuploadRequest: this.sock.updateMediaMessage });
    return { base64: Buffer.from(buf).toString("base64"), mimetype: parsed?.mimetype ?? "application/octet-stream" };
  }
}
