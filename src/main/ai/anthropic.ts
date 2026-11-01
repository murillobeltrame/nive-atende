// Anthropic (Claude) pela API nativa de mensagens. Converte o formato comum (estilo OpenAI) para o do Claude:
// instruções de sistema à parte, ferramentas como blocos tool_use / tool_result e fotos como blocos de imagem.
import { AiError, classifyAiError, type AiChatResult, type AiMessage, type AiProvider, type AiToolCall, type AiToolDef } from "./openai";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const COMPANY = "Anthropic";
const MAX_TOKENS = 8000;

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: string; [k: string]: unknown };

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: Block[];
}

export interface ClaudeRequest {
  system: string;
  messages: ClaudeMessage[];
}

function imageBlock(url: string): Block {
  const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  return { type: "image", source: { type: "url", url } };
}

function parseArgs(args: string): unknown {
  try {
    const v = JSON.parse(args || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Converte a conversa para o formato do Claude. Exportado para os testes. */
export function toClaudeRequest(messages: AiMessage[]): ClaudeRequest {
  const system: string[] = [];
  const out: ClaudeMessage[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    const content = blocks.filter((b) => b.type !== "text" || String((b as { text: string }).text).trim() !== "");
    if (!content.length) return;
    const last = out[out.length - 1];
    // o Claude exige papéis alternados: mensagens seguidas do mesmo papel viram uma só
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim()) system.push(m.content.trim());
    } else if (m.role === "user") {
      if (typeof m.content === "string") push("user", [{ type: "text", text: m.content }]);
      else push("user", m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : imageBlock(p.image_url.url))));
    } else if (m.role === "assistant") {
      if (Array.isArray(m.raw) && m.raw.length) {
        push("assistant", m.raw as Block[]);
      } else {
        const blocks: Block[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
        push("assistant", blocks);
      }
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
    }
  }

  // a conversa precisa começar e terminar com o cliente
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(início da conversa)" }] });
  if (out[out.length - 1]?.role === "assistant") out.push({ role: "user", content: [{ type: "text", text: "(continue a conversa)" }] });
  return { system: system.join("\n\n"), messages: out };
}

/** Lê a resposta do Claude no formato comum. Exportado para os testes. */
export function fromClaudeResponse(body: {
  content?: Block[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}): AiChatResult {
  const content = body.content ?? [];
  const text = content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const toolCalls: AiToolCall[] = content
    .filter((b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const u = body.usage ?? {};
  return {
    content: text || null,
    toolCalls,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    // blocos de raciocínio precisam voltar intactos junto com o tool_use na rodada seguinte
    raw: toolCalls.length ? content : undefined,
  };
}

export class AnthropicProvider implements AiProvider {
  constructor(
    private readonly apiKey: () => string | null,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async request<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
    const key = this.apiKey();
    if (!key) throw new AiError(`Chave da ${COMPANY} não configurada.`, "invalid_key");
    let res: Response;
    try {
      res = await this.fetchImpl(`${ANTHROPIC_BASE_URL}${path}`, {
        method: init.method,
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      throw classifyAiError(e, COMPANY);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* resposta não-JSON */
    }
    if (!res.ok) {
      const err = (json as { error?: { type?: string; message?: string } } | null)?.error;
      throw classifyAiError({ status: res.status, error: { type: err?.type }, message: err?.message ?? (text.slice(0, 200) || `HTTP ${res.status}`) }, COMPANY);
    }
    return json as T;
  }

  async chat(model: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiChatResult> {
    const req = toClaudeRequest(messages);
    const body = await this.request<Parameters<typeof fromClaudeResponse>[0]>("/messages", {
      method: "POST",
      body: {
        model,
        max_tokens: MAX_TOKENS,
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages,
        ...(tools.length
          ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })), tool_choice: { type: "auto" } }
          : {}),
      },
    });
    return fromClaudeResponse(body);
  }

  async transcribe(): Promise<string> {
    throw new AiError("O Claude não transcreve áudio. Cadastre uma chave da OpenAI ou do Gemini para entender os áudios.", "other");
  }

  async listModels(): Promise<string[]> {
    const body = await this.request<{ data?: Array<{ id: string }> }>("/models?limit=100", { method: "GET" });
    return (body.data ?? []).map((m) => m.id).filter((id) => /^claude/.test(id)).sort();
  }
}
