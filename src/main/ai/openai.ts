// Camada de IA: chat com ferramentas (function calling) e transcrição de áudio, usando a chave do lojista.
// Este arquivo tem os tipos comuns a todas as plataformas e a implementação da OpenAI, que também serve ao
// Gemini (o Google oferece um endereço compatível com a API da OpenAI).
import OpenAI, { toFile } from "openai";
import { estimateChatCost as catalogCost } from "../../shared/ai-catalog";

export type AiErrorKind = "no_credit" | "invalid_key" | "rate_limit" | "unavailable" | "other";

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: AiErrorKind,
  ) {
    super(message);
  }
}

export interface AiToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type AiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | AiContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: AiToolCall[];
      /** Resposta original da plataforma (ex.: blocos de raciocínio do Claude), devolvida a ela na rodada seguinte. */
      raw?: unknown;
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** Parte de mensagem do cliente: texto ou imagem (a IA "vê" a foto). */
export type AiContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

/** Texto de uma mensagem (ignora imagens). */
export function messageText(m: AiMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p.type === "text" ? p.text : "[foto]")).join(" ");
  return "";
}

export interface AiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AiChatResult {
  content: string | null;
  toolCalls: AiToolCall[];
  inputTokens: number;
  outputTokens: number;
  /** Resposta original da plataforma; guarde no AiMessage do assistente quando houver ferramentas. */
  raw?: unknown;
}

export interface AiProvider {
  chat(model: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiChatResult>;
  transcribe(model: string, audio: Uint8Array, fileName: string): Promise<string>;
  listModels(): Promise<string[]>;
}

const TRANSCRIBE_USD_PER_MINUTE = 0.006;

export function estimateChatCost(model: string, inputTokens: number, outputTokens: number): number {
  return catalogCost(model, inputTokens, outputTokens);
}

export function estimateTranscriptionCost(seconds: number): number {
  return (Math.max(seconds, 1) / 60) * TRANSCRIBE_USD_PER_MINUTE;
}

/** Converte erros das plataformas em mensagens que o lojista entende. */
export function classifyAiError(e: unknown, company = "OpenAI"): AiError {
  if (e instanceof AiError) return e;
  const err = e as { status?: number; code?: string; error?: { code?: string; type?: string; status?: string }; message?: string };
  const code = err.code ?? err.error?.code ?? err.error?.type ?? err.error?.status ?? "";
  const msg = err.message ?? String(e);
  if (
    code === "insufficient_quota" ||
    /insufficient_quota|exceeded your current quota|billing|credit balance is too low|purchase credits/i.test(msg)
  )
    return new AiError(`A conta da ${company} está sem créditos.`, "no_credit");
  if (err.status === 401 || code === "invalid_api_key" || code === "authentication_error" || /api key not valid|API_KEY_INVALID|invalid x-api-key/i.test(msg))
    return new AiError(`Chave da ${company} inválida.`, "invalid_key");
  if (err.status === 404 || /model.*(not found|does not exist)|not_found_error/i.test(msg))
    return new AiError(`Modelo não disponível na sua conta da ${company}. Escolha outro e teste de novo.`, "other");
  if (err.status === 429 || code === "RESOURCE_EXHAUSTED" || code === "rate_limit_error")
    return new AiError(`Limite de uso da ${company} atingido; tentando de novo em instantes.`, "rate_limit");
  if ((err.status && err.status >= 500) || code === "overloaded_error") return new AiError(`${company} indisponível no momento.`, "unavailable");
  // timeout e queda de conexão são passageiros: o atendimento tenta de novo em vez de passar para humano
  const name = (e as { name?: string } | null)?.name ?? "";
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|fetch failed|network|socket hang up|connection error|timed out|timeout|terminated/i.test(msg) ||
    /TimeoutError|AbortError|APIConnection/i.test(name)
  )
    return new AiError(`Sem conexão com a ${company}.`, "unavailable");
  return new AiError(msg, "other");
}

export interface OpenAiCompatibleOptions {
  /** Nome da empresa nas mensagens de erro. */
  company: string;
  baseURL?: string;
  /** Mantém só modelos de conversa na lista. */
  modelFilter: (id: string) => boolean;
  /** Parâmetro de limite de resposta: a OpenAI usa max_completion_tokens; o Gemini, max_tokens. */
  limitParam: "max_completion_tokens" | "max_tokens";
  maxTokens: number;
}

const OPENAI_OPTIONS: OpenAiCompatibleOptions = {
  company: "OpenAI",
  modelFilter: (id) => /^(gpt|o\d)/.test(id) && !/(audio|realtime|tts|image|search|transcribe|embedding|live|whisper|cyber|rosalind)/.test(id),
  limitParam: "max_completion_tokens",
  maxTokens: 4000,
};

export class OpenAiProvider implements AiProvider {
  protected readonly opts: OpenAiCompatibleOptions;

  constructor(
    private readonly apiKey: () => string | null,
    opts: Partial<OpenAiCompatibleOptions> = {},
  ) {
    this.opts = { ...OPENAI_OPTIONS, ...opts };
  }

  protected fail(e: unknown): AiError {
    return classifyAiError(e, this.opts.company);
  }

  protected client(): OpenAI {
    const key = this.apiKey();
    if (!key) throw new AiError(`Chave da ${this.opts.company} não configurada.`, "invalid_key");
    return new OpenAI({ apiKey: key, timeout: 60_000, maxRetries: 1, ...(this.opts.baseURL ? { baseURL: this.opts.baseURL } : {}) });
  }

  async chat(model: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiChatResult> {
    try {
      const res = await this.client().chat.completions.create({
        model,
        // o campo raw é só nosso; a API não o conhece
        messages: messages.map((m) => (m.role === "assistant" ? { role: m.role, content: m.content, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) } : m)) as OpenAI.Chat.ChatCompletionMessageParam[],
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function" as const, function: t })), tool_choice: "auto" as const } : {}),
        [this.opts.limitParam]: this.opts.maxTokens,
      });
      const choice = res.choices[0];
      const toolCalls = (choice?.message.tool_calls ?? [])
        .filter((tc) => tc.type === "function")
        .map((tc) => {
          const fn = (tc as { function: { name: string; arguments: string } }).function;
          return { id: tc.id, type: "function" as const, function: { name: fn.name, arguments: fn.arguments } };
        });
      return {
        content: choice?.message.content ?? null,
        toolCalls,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    } catch (e) {
      throw this.fail(e);
    }
  }

  async transcribe(model: string, audio: Uint8Array, fileName: string): Promise<string> {
    try {
      const file = await toFile(audio, fileName);
      const res = await this.client().audio.transcriptions.create({ file, model, language: "pt" });
      return (res as { text?: string }).text?.trim() ?? "";
    } catch (e) {
      throw this.fail(e);
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const out: string[] = [];
      for await (const m of this.client().models.list()) out.push(m.id.replace(/^models\//, ""));
      return Array.from(new Set(out.filter(this.opts.modelFilter))).sort();
    } catch (e) {
      throw this.fail(e);
    }
  }
}
