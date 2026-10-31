// Cliente REST da Evolution API v2 (WhatsApp). Todas as chamadas usam o header "apikey".
export class EvolutionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type ConnectionState = "open" | "connecting" | "close" | "unknown";

export interface SendResult {
  waMessageId: string | null;
}

/** Interface usada pelo motor (permite um falso nos testes). */
export interface WhatsAppGateway {
  sendText(jid: string, text: string, delayMs?: number): Promise<SendResult>;
  sendMedia(jid: string, media: { mediatype: "image" | "video" | "document"; mimetype: string; media: string; fileName?: string; caption?: string }): Promise<SendResult>;
  sendAudio(jid: string, base64: string): Promise<SendResult>;
  sendSticker(jid: string, base64: string): Promise<SendResult>;
  sendPresence(jid: string, presence: "composing" | "recording" | "paused", delayMs: number): Promise<void>;
  getMediaBase64(waMessageId: string, remoteJid: string, fromMe: boolean): Promise<{ base64: string; mimetype: string } | null>;
  /** Apaga para todos uma mensagem enviada por este número. */
  deleteForEveryone(jid: string, waMessageId: string): Promise<void>;
  /** URL da foto de perfil, quando o contato deixa pública (senão null). */
  getProfilePictureUrl?(jid: string): Promise<string | null>;
}

type Json = Record<string, unknown>;

function extractId(data: unknown): string | null {
  const d = data as Json | null;
  const key = (d?.key ?? (d?.message as Json | undefined)?.key) as Json | undefined;
  return key?.id ? String(key.id) : null;
}

export class EvolutionClient implements WhatsAppGateway {
  constructor(
    private readonly cfg: () => { baseUrl: string; instanceName: string; apiKey: string | null },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get instance(): string {
    return encodeURIComponent(this.cfg().instanceName);
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 20000): Promise<T> {
    const { baseUrl, apiKey } = this.cfg();
    if (!apiKey) throw new EvolutionError("Chave da Evolution não configurada", 401);
    const res = await this.fetchImpl(baseUrl + path, {
      method,
      headers: { apikey: apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const resp = (data as Json | null)?.response as Json | undefined;
      const msg = resp?.message ? JSON.stringify(resp.message) : (data as Json | null)?.message ?? `HTTP ${res.status}`;
      throw new EvolutionError(String(msg), res.status);
    }
    return data as T;
  }

  /** GET / responde com versão quando o serviço está no ar. */
  async ping(): Promise<string> {
    const { baseUrl } = this.cfg();
    const res = await this.fetchImpl(baseUrl + "/", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new EvolutionError(`HTTP ${res.status}`, res.status);
    const data = (await res.json().catch(() => ({}))) as Json;
    return String(data.version ?? "");
  }

  async instanceExists(): Promise<boolean> {
    const list = await this.request<unknown>("GET", `/instance/fetchInstances?instanceName=${this.instance}`);
    const arr = Array.isArray(list) ? list : [];
    return arr.some((i) => {
      const it = i as Json;
      const name = it.name ?? (it.instance as Json | undefined)?.instanceName;
      return name === this.cfg().instanceName;
    });
  }

  async createInstance(): Promise<void> {
    await this.request("POST", "/instance/create", {
      instanceName: this.cfg().instanceName,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
      groupsIgnore: true,
      rejectCall: false,
      alwaysOnline: false,
      readMessages: false,
      syncFullHistory: false,
    });
  }

  async connectionState(): Promise<ConnectionState> {
    const data = await this.request<Json>("GET", `/instance/connectionState/${this.instance}`);
    const state = String((data.instance as Json | undefined)?.state ?? data.state ?? "unknown");
    return state === "open" || state === "connecting" || state === "close" ? state : "unknown";
  }

  /** Inicia a conexão e devolve o QR Code (base64) quando ainda não conectado. */
  async connect(number?: string): Promise<{ qrBase64: string | null; pairingCode: string | null }> {
    const q = number ? `?number=${encodeURIComponent(number)}` : "";
    const data = await this.request<Json>("GET", `/instance/connect/${this.instance}${q}`);
    const qr = (data.base64 ?? (data.qrcode as Json | undefined)?.base64 ?? null) as string | null;
    return { qrBase64: qr, pairingCode: (data.pairingCode as string | null) ?? null };
  }

  async logout(): Promise<void> {
    await this.request("DELETE", `/instance/logout/${this.instance}`);
  }

  async restart(): Promise<void> {
    try {
      await this.request("POST", `/instance/restart/${this.instance}`);
    } catch (e) {
      if (e instanceof EvolutionError && (e.status === 404 || e.status === 405)) {
        await this.request("PUT", `/instance/restart/${this.instance}`);
      } else throw e;
    }
  }

  async setWebhook(url: string): Promise<void> {
    await this.request("POST", `/webhook/set/${this.instance}`, {
      webhook: {
        enabled: true,
        url,
        byEvents: false,
        base64: true,
        events: ["MESSAGES_UPSERT", "SEND_MESSAGE", "CONNECTION_UPDATE", "QRCODE_UPDATED", "MESSAGES_UPDATE", "MESSAGES_DELETE"],
      },
    });
  }

  async sendText(jid: string, text: string, delayMs = 0): Promise<SendResult> {
    const data = await this.request("POST", `/message/sendText/${this.instance}`, {
      number: jid,
      text,
      delay: delayMs,
      linkPreview: false,
    });
    return { waMessageId: extractId(data) };
  }

  async sendMedia(
    jid: string,
    media: { mediatype: "image" | "video" | "document"; mimetype: string; media: string; fileName?: string; caption?: string },
  ): Promise<SendResult> {
    const data = await this.request("POST", `/message/sendMedia/${this.instance}`, { number: jid, ...media }, 60000);
    return { waMessageId: extractId(data) };
  }

  async sendAudio(jid: string, base64: string): Promise<SendResult> {
    const data = await this.request("POST", `/message/sendWhatsAppAudio/${this.instance}`, { number: jid, audio: base64 }, 60000);
    return { waMessageId: extractId(data) };
  }

  async sendSticker(jid: string, base64: string): Promise<SendResult> {
    const data = await this.request("POST", `/message/sendSticker/${this.instance}`, { number: jid, sticker: base64 }, 60000);
    return { waMessageId: extractId(data) };
  }

  async sendPresence(jid: string, presence: "composing" | "recording" | "paused", delayMs: number): Promise<void> {
    await this.request("POST", `/chat/sendPresence/${this.instance}`, { number: jid, presence, delay: delayMs }).catch(() => undefined);
  }

  async getProfilePictureUrl(jid: string): Promise<string | null> {
    try {
      const data = await this.request<Json>("POST", `/chat/fetchProfilePictureUrl/${this.instance}`, { number: jid }, 10000);
      const url = data?.profilePictureUrl;
      return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
    } catch {
      return null;
    }
  }

  async deleteForEveryone(jid: string, waMessageId: string): Promise<void> {
    await this.request("DELETE", `/chat/deleteMessageForEveryone/${this.instance}`, { id: waMessageId, remoteJid: jid, fromMe: true });
  }

  async getMediaBase64(waMessageId: string, remoteJid: string, fromMe: boolean): Promise<{ base64: string; mimetype: string } | null> {
    const data = await this.request<Json>(
      "POST",
      `/chat/getBase64FromMediaMessage/${this.instance}`,
      { message: { key: { id: waMessageId, remoteJid, fromMe } }, convertToMp4: false },
      60000,
    );
    if (!data?.base64) return null;
    return { base64: String(data.base64), mimetype: String(data.mimetype ?? "application/octet-stream") };
  }
}
