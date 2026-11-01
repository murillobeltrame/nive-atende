// Simulador: conversa com a IA como se fosse um cliente, sem WhatsApp e sem mexer no ERP.
// Usa um motor separado, com banco em memória; o catálogo é lido de verdade (só leitura).
import { EventEmitter } from "node:events";
import type { AppSettings, ChatMessage } from "../shared/types";
import type { AiProvider } from "./ai/openai";
import { Engine } from "./engine/engine";
import type { SendResult, WhatsAppGateway } from "./evolution/client";
import type { NiveApi } from "./nive/client";
import { Store } from "./store/db";

export const SIM_JID = "5500000000000@s.whatsapp.net";
const SIM_PHONE = "5500000000000";

/** ERP somente leitura: consultas reais; reservas, cadastros e cancelamentos são simulados. */
function readOnlyNive(real: NiveApi): NiveApi {
  let seq = 0;
  return {
    testConnection: () => real.testConnection(),
    // o simulador não fala como cliente identificado: contas ficam bloqueadas
    findCustomersByPhone: async () => [],
    findCustomerByCpf: async () => null,
    getStatement: async () => {
      throw new Error("Consulta de contas não disponível no simulador");
    },
    searchProducts: (t, l) => real.searchProducts(t, l),
    getProduct: (id) => real.getProduct(id),
    createDraftSale: async () => ({ id: `simulado-${++seq}`, orderNumber: null }),
    findCustomersByName: async () => [],
    findSimilarCustomers: async () => [],
    createCustomer: async (i) => ({ id: `simulado-${++seq}`, name: i.name, nickname: null, taxId: null, phone: i.phone, birthDate: null }),
    getSaleState: async () => ({ state: "draft", orderNumber: null }),
    cancelDraftSale: async () => "cancelled",
  };
}

class SimGateway implements WhatsAppGateway {
  private seq = 0;
  private next(): SendResult {
    return { waMessageId: `SIM-OUT-${++this.seq}` };
  }
  async sendText() {
    return this.next();
  }
  async sendMedia() {
    return this.next();
  }
  async sendAudio() {
    return this.next();
  }
  async sendSticker() {
    return this.next();
  }
  async sendPresence() {}
  async getMediaBase64() {
    return null;
  }
  async deleteForEveryone() {}
}

export class Simulator extends EventEmitter<{ message: [ChatMessage]; activity: [{ conversationId: string; label: string | null }] }> {
  private store!: Store;
  private engine!: Engine;
  private seq = 0;

  constructor(
    private readonly deps: { settings: () => AppSettings; nive: NiveApi; ai: AiProvider; fetchImage?: (url: string) => Promise<{ data: Buffer; mime: string } | null> },
  ) {
    super();
    this.reset();
  }

  /** Configurações reais da loja, com o atendimento sempre ligado e sem espera. */
  private simSettings(): AppSettings {
    const s = structuredClone(this.deps.settings());
    s.attendance.autoEnabled = true;
    s.attendance.businessHours.enabled = false;
    s.attendance.replyDelayMinSec = 0;
    s.attendance.replyDelayMaxSec = 0;
    s.attendance.onlyStoreTopics = false;
    s.attendance.ignoredNumbers = [];
    s.ai.maxAiRepliesPerConversationPerDay = 1000;
    s.reservation.autoEnabled = true;
    return s;
  }

  reset(): void {
    this.store?.close();
    this.store = new Store(":memory:");
    this.engine = new Engine({
      store: this.store,
      settings: () => this.simSettings(),
      nive: readOnlyNive(this.deps.nive),
      ai: this.deps.ai,
      wa: new SimGateway(),
      transcode: async (b) => b,
      blockedReason: () => null,
      fetchImage: this.deps.fetchImage,
      maxBatchWaitMs: 1500,
    });
    this.engine.on("message", (m) => this.emit("message", m));
    this.engine.on("activity", (a) => this.emit("activity", a));
  }

  messages(): ChatMessage[] {
    return this.store.listMessages(SIM_JID);
  }

  async send(text: string): Promise<void> {
    const t = text.trim().slice(0, 2000);
    if (!t) return;
    await this.engine.handleInbound({
      type: "message",
      waMessageId: `SIM-IN-${Date.now()}-${++this.seq}`,
      remoteJid: SIM_JID,
      phone: SIM_PHONE,
      fromMe: false,
      pushName: "Cliente (simulador)",
      kind: "text",
      text: t,
      mimetype: null,
      fileName: null,
      durationSec: null,
      base64: null,
      timestamp: Date.now(),
      ignorable: false,
    });
  }

  getMedia(messageId: string): { mime: string; data: Uint8Array } | null {
    return this.store.getMedia(messageId);
  }
}
