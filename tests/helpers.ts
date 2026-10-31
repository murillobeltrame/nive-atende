// Falsos (fakes) para testar o motor sem rede: Nive, OpenAI, WhatsApp e relógio.
import { Store } from "../src/main/store/db";
import { DEFAULT_SETTINGS } from "../src/main/settings";
import type { AppSettings, DeepPartial } from "../src/shared/types";
import { deepMerge } from "../src/main/settings";
import type { NiveApi, NiveCustomer, NiveProduct, NiveStatement } from "../src/main/nive/client";
import type { AiChatResult, AiMessage, AiProvider, AiToolDef } from "../src/main/ai/openai";
import type { SendResult, WhatsAppGateway } from "../src/main/evolution/client";
import type { InboundMessage } from "../src/main/evolution/parse";
import { Engine } from "../src/main/engine/engine";

export const CUSTOMERS: NiveCustomer[] = [
  { id: "c-ana", name: "Ana Souza", nickname: null, taxId: "52998224725", phone: "48999992210", birthDate: "1990-03-10" },
  { id: "c-joao", name: "João Lima", nickname: null, taxId: "11144477735", phone: "47988887777", birthDate: "1985-07-21" },
  { id: "c-maria", name: "Maria Lima", nickname: null, taxId: "39053344705", phone: "47988887777", birthDate: "1987-01-02" },
  { id: "c-semdata", name: "Pedro Alves", nickname: null, taxId: "71428793860", phone: "11911112222", birthDate: null },
];

export const STATEMENTS: Record<string, NiveStatement> = {
  "c-ana": {
    customerId: "c-ana",
    customerName: "Ana Souza",
    openBalance: 340,
    overdueBalance: 0,
    orders: [{ orderNumber: 120, description: null, balance: 340, originalAmount: 340, dueDate: "2026-11-10", items: [{ description: "Vestido floral", variantLabel: "M", quantity: 1, unitPrice: 340, lineTotal: 340 }] }],
    installments: [
      { sequence: 1, amount: 170, balance: 170, dueDate: "2026-11-10", status: "OPEN", orderNumber: 120 },
      { sequence: 2, amount: 170, balance: 170, dueDate: "2026-12-10", status: "OPEN", orderNumber: 120 },
    ],
  },
  "c-joao": { customerId: "c-joao", customerName: "João Lima", openBalance: 999.9, overdueBalance: 500, orders: [], installments: [] },
  "c-maria": { customerId: "c-maria", customerName: "Maria Lima", openBalance: 50, overdueBalance: 0, orders: [], installments: [] },
  "c-semdata": { customerId: "c-semdata", customerName: "Pedro Alves", openBalance: 80, overdueBalance: 0, orders: [], installments: [] },
};

export const PRODUCTS: NiveProduct[] = [
  {
    id: "p-bolsa",
    description: "Bolsa caramelo",
    priceCash: 159.9,
    priceCredit: 159.9,
    active: true,
    tracksStock: true,
    imageUrl: "https://cdn.exemplo/bolsa.jpg",
    variants: [{ id: "v-bolsa", label: "Único", stockQty: 1 }],
  },
  {
    id: "p-tenis",
    description: "Tênis Runner preto",
    priceCash: 289.9,
    priceCredit: 299.9,
    active: true,
    tracksStock: true,
    imageUrl: null,
    variants: [
      { id: "v-40", label: "40", stockQty: 2 },
      { id: "v-41", label: "41", stockQty: 0 },
    ],
  },
];

export class FakeNive implements NiveApi {
  calls: string[] = [];
  drafts: Array<{ customerId: string | null; variantId: string; quantity: number; notes: string }> = [];
  failDraft = false;
  async testConnection(): Promise<void> {}
  async findCustomersByPhone(phone: string): Promise<NiveCustomer[]> {
    this.calls.push(`phone:${phone}`);
    const { samePhone } = await import("../src/main/engine/phone");
    return CUSTOMERS.filter((c) => samePhone(c.phone, phone));
  }
  async findCustomerByCpf(cpf: string): Promise<NiveCustomer | null> {
    this.calls.push(`cpf:${cpf}`);
    return CUSTOMERS.find((c) => c.taxId === cpf) ?? null;
  }
  async getStatement(customerId: string): Promise<NiveStatement> {
    this.calls.push(`statement:${customerId}`);
    const st = STATEMENTS[customerId];
    if (!st) throw new Error("not found");
    return st;
  }
  async searchProducts(term: string): Promise<NiveProduct[]> {
    this.calls.push(`search:${term}`);
    const t = term.toLowerCase();
    return PRODUCTS.filter((p) => t.split(/\s+/).some((w) => w.length > 2 && p.description.toLowerCase().includes(w)));
  }
  async getProduct(id: string): Promise<NiveProduct | null> {
    return PRODUCTS.find((p) => p.id === id) ?? null;
  }
  namedCustomers: NiveCustomer[] = [];
  createdCustomers: Array<{ name: string; phone: string | null }> = [];
  saleStatus: Record<string, string> = {};
  cancelled: string[] = [];
  async findCustomersByName(name: string): Promise<NiveCustomer[]> {
    const { normalizeName } = await import("../src/main/nive/client");
    return [...CUSTOMERS, ...this.namedCustomers].filter((c) => normalizeName(c.name) === normalizeName(name));
  }
  async createCustomer(input: { name: string; phone: string | null }): Promise<NiveCustomer> {
    this.createdCustomers.push(input);
    const c = { id: `new-${this.createdCustomers.length}`, name: input.name, nickname: null, taxId: null, phone: input.phone, birthDate: null };
    this.namedCustomers.push(c);
    return c;
  }
  async getSaleState(saleId: string) {
    const st = this.saleStatus[saleId] ?? "DRAFT";
    const state = st === "DRAFT" ? "draft" : st === "GONE" ? "not_found" : st.includes("CANCEL") ? "cancelled" : "completed";
    return { state: state as "draft" | "completed" | "cancelled" | "not_found", orderNumber: 777 };
  }
  async cancelDraftSale(saleId: string): Promise<"cancelled" | "not_draft" | "not_found"> {
    const st = this.saleStatus[saleId] ?? "DRAFT";
    if (st !== "DRAFT") return "not_draft";
    this.cancelled.push(saleId);
    this.saleStatus[saleId] = "DRAFT_CANCELLED";
    return "cancelled";
  }
  async createDraftSale(input: { customerId: string | null; variantId: string; quantity: number; notes: string }) {
    if (this.failDraft) throw new Error("erro ERP");
    this.drafts.push(input);
    return { id: `sale-${this.drafts.length}`, orderNumber: 500 + this.drafts.length };
  }
}

type Step = AiChatResult | ((messages: AiMessage[], tools: AiToolDef[]) => AiChatResult);

/** IA roteirizada: cada chamada de chat consome um passo. Guarda tudo o que recebeu. */
export class FakeAi implements AiProvider {
  steps: Step[] = [];
  received: AiMessage[][] = [];
  toolsSeen: string[][] = [];
  transcript = "oi, vocês ainda têm aquela bolsa caramelo?";
  error: Error | null = null;
  script(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }
  async chat(_model: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiChatResult> {
    if (this.error) throw this.error;
    this.received.push(structuredClone(messages));
    this.toolsSeen.push(tools.map((t) => t.name));
    const step = this.steps.shift();
    if (!step) return { content: "Certo!", toolCalls: [], inputTokens: 10, outputTokens: 5 };
    return typeof step === "function" ? step(messages, tools) : step;
  }
  async transcribe(): Promise<string> {
    return this.transcript;
  }
  async listModels(): Promise<string[]> {
    return ["gpt-5-mini"];
  }
}

export function toolCall(name: string, args: Record<string, unknown> = {}, id = `call-${name}-${Math.random().toString(36).slice(2, 7)}`): AiChatResult {
  return { content: null, toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }], inputTokens: 100, outputTokens: 20 };
}

export function reply(content: string): AiChatResult {
  return { content, toolCalls: [], inputTokens: 100, outputTokens: 30 };
}

export class FakeWa implements WhatsAppGateway {
  sent: Array<{ type: string; jid: string; body: string }> = [];
  private seq = 0;
  fail = false;
  media: Record<string, { base64: string; mimetype: string }> = {};
  private next(): SendResult {
    return { waMessageId: `OUT${++this.seq}` };
  }
  async sendText(jid: string, text: string): Promise<SendResult> {
    if (this.fail) throw new Error("falha envio");
    this.sent.push({ type: "text", jid, body: text });
    return this.next();
  }
  async sendMedia(jid: string, media: { media: string; caption?: string }): Promise<SendResult> {
    this.sent.push({ type: "media", jid, body: media.media });
    return this.next();
  }
  async sendAudio(jid: string): Promise<SendResult> {
    this.sent.push({ type: "audio", jid, body: "" });
    return this.next();
  }
  async sendSticker(jid: string): Promise<SendResult> {
    this.sent.push({ type: "sticker", jid, body: "" });
    return this.next();
  }
  presence: string[] = [];
  async sendPresence(_jid: string, p: string): Promise<void> {
    this.presence.push(p);
  }
  deleted: Array<{ jid: string; id: string }> = [];
  async deleteForEveryone(jid: string, id: string): Promise<void> {
    if (this.fail) throw new Error("falha apagar");
    this.deleted.push({ jid, id });
  }
  async getMediaBase64(id: string) {
    return this.media[id] ?? null;
  }
}

/** Relógio e timers manuais. */
export class Clock {
  t = new Date("2026-10-31T14:00:00-03:00").getTime();
  private queue: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.queue.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimer = (id: unknown) => {
    this.queue = this.queue.filter((q) => q.id !== id);
  };
  /** Avança o relógio executando os timers vencidos. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > target) break;
      this.queue.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flushPromises();
    }
    this.t = target;
    await flushPromises();
  }
}

export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

export function makeSettings(patch: DeepPartial<AppSettings> = {}): AppSettings {
  const base = deepMerge(structuredClone(DEFAULT_SETTINGS), {
    attendance: { autoEnabled: true, replyDelayMinSec: 1, replyDelayMaxSec: 1, onlyStoreTopics: false },
    personality: { storeName: "Loja Exemplo" },
    termsAcceptedAt: 1,
  });
  return deepMerge(base, patch);
}

export function setup(opts: { settings?: DeepPartial<AppSettings>; blocked?: () => string | null } = {}) {
  const store = new Store(":memory:");
  const nive = new FakeNive();
  const ai = new FakeAi();
  const wa = new FakeWa();
  const clock = new Clock();
  let settings = makeSettings(opts.settings);
  let blocked: string | null = null;
  const engine = new Engine({
    store,
    settings: () => settings,
    nive,
    ai,
    wa,
    transcode: async (b) => b,
    blockedReason: opts.blocked ?? (() => blocked),
    now: clock.now,
    random: () => 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    echoGraceMs: 3000,
    fetchImage: async (url) => (url.includes("exemplo") ? { data: Buffer.from("PNGDATA"), mime: "image/png" } : null),
  });
  return {
    store,
    nive,
    ai,
    wa,
    clock,
    engine,
    setSettings: (p: DeepPartial<AppSettings>) => (settings = deepMerge(settings, p)),
    setBlocked: (v: string | null) => (blocked = v),
  };
}

let waSeq = 0;
export function inbound(phone: string, text: string | null, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    type: "message",
    waMessageId: `IN${++waSeq}`,
    remoteJid: `${phone}@s.whatsapp.net`,
    phone,
    fromMe: false,
    pushName: "Cliente",
    kind: "text",
    text,
    mimetype: null,
    fileName: null,
    durationSec: null,
    base64: null,
    timestamp: Date.now(),
    ignorable: false,
    ...extra,
  };
}

/** Todo o texto que a IA recebeu, em uma string (para procurar vazamentos). */
export function allAiText(ai: FakeAi): string {
  return ai.received.flat().map((m) => ("content" in m ? m.content ?? "" : "")).join("\n");
}
