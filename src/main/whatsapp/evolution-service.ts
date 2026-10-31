// WhatsApp via servidor Evolution API externo (opção avançada): REST + webhook local.
import type { ConnectionState, EvolutionClient, SendResult } from "../evolution/client";
import type { EvolutionEvent } from "../evolution/parse";
import { WebhookServer } from "../evolution/webhook-server";
import type { TestResult } from "../../shared/types";
import type { EngineHealth, WhatsAppService } from "./service";

export interface EvolutionServiceDeps {
  client: EvolutionClient;
  token: string;
  port: () => number;
  webhookUrl: () => string;
  hasApiKey: () => boolean;
}

export class EvolutionService implements WhatsAppService {
  readonly mode = "evolution" as const;
  private listeners: Array<(e: EvolutionEvent[]) => void> = [];
  private webhook: WebhookServer;

  constructor(private readonly deps: EvolutionServiceDeps) {
    this.webhook = new WebhookServer(deps.token, (events) => {
      for (const l of this.listeners) l(events);
    });
  }

  onEvents(cb: (events: EvolutionEvent[]) => void): void {
    this.listeners.push(cb);
  }

  async start(): Promise<void> {
    try {
      await this.webhook.start(this.deps.port());
    } catch (e) {
      console.error("[webhook] não foi possível abrir a porta", this.deps.port(), e);
    }
    await this.registerWebhook();
  }

  async registerWebhook(): Promise<void> {
    if (!this.deps.hasApiKey()) return;
    try {
      if (await this.deps.client.instanceExists()) await this.deps.client.setWebhook(this.deps.webhookUrl());
    } catch (e) {
      console.error("[evolution] falha ao registrar webhook", e);
    }
  }

  async stop(): Promise<void> {
    await this.webhook.stop();
  }

  async health(): Promise<EngineHealth> {
    if (!this.deps.hasApiKey()) return { ok: false, message: "Chave da Evolution não configurada" };
    try {
      await this.deps.client.ping();
      return { ok: true, message: "Servidor Evolution no ar" };
    } catch {
      return { ok: false, message: "O servidor Evolution não responde" };
    }
  }

  async connectionState(): Promise<ConnectionState> {
    try {
      return await this.deps.client.connectionState();
    } catch {
      return "close";
    }
  }

  async connect(): Promise<{ state: ConnectionState; qrBase64: string | null; pairingCode: string | null }> {
    const c = this.deps.client;
    if (!(await c.instanceExists())) await c.createInstance();
    await c.setWebhook(this.deps.webhookUrl());
    const state = await c.connectionState();
    if (state === "open") return { state, qrBase64: null, pairingCode: null };
    const qr = await c.connect();
    return { state: "connecting", ...qr };
  }

  async pairingCode(phone: string): Promise<string> {
    const c = this.deps.client;
    if (!(await c.instanceExists())) await c.createInstance();
    await c.setWebhook(this.deps.webhookUrl());
    const r = await c.connect(phone.replace(/\D/g, ""));
    if (!r.pairingCode) throw new Error("A Evolution não devolveu um código de pareamento.");
    return r.pairingCode;
  }

  async logout(): Promise<void> {
    await this.deps.client.logout().catch(() => undefined);
  }

  async restart(): Promise<void> {
    await this.deps.client.restart();
  }

  async test(): Promise<TestResult> {
    try {
      const version = await this.deps.client.ping();
      const exists = await this.deps.client.instanceExists();
      return { ok: true, message: `Servidor Evolution no ar${version ? ` (versão ${version})` : ""}. ${exists ? "Instância encontrada." : "A instância será criada ao conectar."}` };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        ok: false,
        message: /fetch failed|ECONNREFUSED/i.test(msg)
          ? "Nenhum servidor Evolution respondendo nesse endereço. Confira se ele está ligado (Docker) ou use o WhatsApp embutido."
          : `Não foi possível falar com a Evolution: ${msg}`,
      };
    }
  }

  sendText(jid: string, text: string, delayMs?: number): Promise<SendResult> {
    return this.deps.client.sendText(jid, text, delayMs);
  }
  sendMedia(jid: string, media: Parameters<EvolutionClient["sendMedia"]>[1]): Promise<SendResult> {
    return this.deps.client.sendMedia(jid, media);
  }
  sendAudio(jid: string, base64: string): Promise<SendResult> {
    return this.deps.client.sendAudio(jid, base64);
  }
  sendSticker(jid: string, base64: string): Promise<SendResult> {
    return this.deps.client.sendSticker(jid, base64);
  }
  sendPresence(jid: string, presence: "composing" | "recording" | "paused", delayMs: number): Promise<void> {
    return this.deps.client.sendPresence(jid, presence, delayMs);
  }
  getMediaBase64(waMessageId: string, remoteJid: string, fromMe: boolean) {
    return this.deps.client.getMediaBase64(waMessageId, remoteJid, fromMe);
  }
}
