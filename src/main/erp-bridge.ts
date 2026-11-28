/**
 * Conversas no Nive ERP: a tela "Conversas do WhatsApp" do ERP pede, e o Nive Atende atende com o
 * banco local (as conversas nunca saem do computador da loja para ficar guardadas no ERP).
 *
 * Laço: busca pedidos em /integrations/nive-atende/next, responde cada um e volta no ritmo que o ERP
 * mandar (1 s com alguém olhando a tela, 8 s parado). ERP sem a ponte (versão antiga): tenta de novo
 * em 10 min.
 */
import type { ChatMessage, Conversation, ConversationFilter } from "../shared/types";

export const MAX_MESSAGES = 150;
/** Mídia acima disso não cabe no limite de 2 MB do ERP (base64 cresce ~33%). */
export const MAX_MEDIA_CHARS = 1_400_000;
const RETRY_OLD_ERP_MS = 10 * 60_000;
const RETRY_ERROR_MS = 15_000;

export interface BridgeRequest {
  id: string;
  method: string;
  args: unknown[];
}

export interface ErpBridgeDeps {
  next(version: string): Promise<{ requests: BridgeRequest[]; pollMs: number } | null>;
  respond(id: string, body: { ok: true; data: unknown } | { ok: false; error: string }): Promise<void>;
  version: string;
  /** Ponte ligada? (chave da API do ERP configurada) */
  enabled(): boolean;
  listConversations(filter: ConversationFilter, q?: string): Conversation[];
  getConversation(id: string): Conversation | null;
  getMessages(id: string): ChatMessage[];
  getMedia(messageId: string): Promise<string | null>;
  markRead(id: string): unknown;
  sendText(id: string, text: string, author: string): Promise<ChatMessage>;
  takeOver(id: string, author: string): Conversation;
  returnToAi(id: string): Conversation;
  log(level: "info" | "warn", msg: string, err?: unknown): void;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const FILTERS: ConversationFilter[] = ["todas", "precisa", "ia", "humano"];

/** Atende um pedido do ERP. Só os métodos desta lista; qualquer outro é recusado. */
export async function handleBridgeRequest(deps: ErpBridgeDeps, req: BridgeRequest): Promise<unknown> {
  const [a, b, c] = req.args;
  switch (req.method) {
    case "listConversations": {
      const filter = FILTERS.includes(a as ConversationFilter) ? (a as ConversationFilter) : "todas";
      return deps.listConversations(filter, str(b) || undefined).slice(0, 200);
    }
    case "getConversation":
      return deps.getConversation(str(a));
    case "getMessages":
      return deps.getMessages(str(a)).slice(-MAX_MESSAGES);
    case "getMedia": {
      const data = await deps.getMedia(str(a));
      return data && data.length <= MAX_MEDIA_CHARS ? data : null;
    }
    case "markRead":
      await deps.markRead(str(a));
      return null;
    case "sendText": {
      const text = str(b).trim();
      if (!text) throw new Error("Mensagem vazia");
      return deps.sendText(str(a), text.slice(0, 4000), `${str(c).trim() || "Loja"} (ERP)`);
    }
    case "takeOver":
      return deps.takeOver(str(a), `${str(b).trim() || "Loja"} (ERP)`);
    case "returnToAi":
      return deps.returnToAi(str(a));
    default:
      throw new Error(`Pedido não suportado: ${req.method}`);
  }
}

export class ErpBridge {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: ErpBridgeDeps) {}

  start(delayMs = 5_000): void {
    this.stopped = false;
    this.schedule(delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** Uma consulta: atende o que chegou e devolve quanto esperar até a próxima. */
  async tick(): Promise<number> {
    let wait = RETRY_ERROR_MS;
    try {
      if (!this.deps.enabled()) {
        wait = RETRY_ERROR_MS;
      } else {
        const out = await this.deps.next(this.deps.version);
        if (!out) {
          wait = RETRY_OLD_ERP_MS;
        } else {
          await Promise.all(out.requests.map((r) => this.answer(r)));
          wait = Math.min(Math.max(out.pollMs || 8_000, 500), 60_000);
        }
      }
    } catch (e) {
      this.deps.log("warn", "falha ao buscar pedidos do Nive ERP", e);
    }
    this.schedule(wait);
    return wait;
  }

  private async answer(r: BridgeRequest): Promise<void> {
    let body: { ok: true; data: unknown } | { ok: false; error: string };
    try {
      body = { ok: true, data: await handleBridgeRequest(this.deps, r) };
    } catch (e) {
      body = { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }
    await this.deps.respond(r.id, body).catch((e) => this.deps.log("warn", "falha ao responder pedido do Nive ERP", e));
  }
}
