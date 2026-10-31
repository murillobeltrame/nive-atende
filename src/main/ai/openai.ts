// Camada de IA: chat com ferramentas (function calling) e transcrição de áudio, usando a chave do lojista.
import OpenAI, { toFile } from "openai";

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
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: AiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

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
}

export interface AiProvider {
  chat(model: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiChatResult>;
  transcribe(model: string, audio: Uint8Array, fileName: string): Promise<string>;
  listModels(): Promise<string[]>;
}

// Preços aproximados em US$ por 1 milhão de tokens (entrada, saída). Usados só para estimar o consumo.
const PRICES: Array<[RegExp, number, number]> = [
  [/^gpt-5-nano/, 0.05, 0.4],
  [/^gpt-5-mini/, 0.25, 2.0],
  [/^gpt-5/, 1.25, 10.0],
  [/^gpt-4\.1-nano/, 0.1, 0.4],
  [/^gpt-4\.1-mini/, 0.4, 1.6],
  [/^gpt-4\.1/, 2.0, 8.0],
  [/^gpt-4o-mini/, 0.15, 0.6],
  [/^gpt-4o/, 2.5, 10.0],
];
const TRANSCRIBE_USD_PER_MINUTE = 0.006;

export function estimateChatCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES.find(([re]) => re.test(model)) ?? [/./, 0.5, 2.0];
  return (inputTokens * p[1] + outputTokens * p[2]) / 1_000_000;
}

export function estimateTranscriptionCost(seconds: number): number {
  return (Math.max(seconds, 1) / 60) * TRANSCRIBE_USD_PER_MINUTE;
}

function classify(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const err = e as { status?: number; code?: string; error?: { code?: string; type?: string }; message?: string };
  const code = err.code ?? err.error?.code ?? err.error?.type ?? "";
  const msg = err.message ?? String(e);
  if (code === "insufficient_quota" || /insufficient_quota|exceeded your current quota|billing/i.test(msg))
    return new AiError("A conta da OpenAI está sem créditos.", "no_credit");
  if (err.status === 401 || code === "invalid_api_key") return new AiError("Chave da OpenAI inválida.", "invalid_key");
  if (err.status === 429) return new AiError("Limite de uso da OpenAI atingido; tentando de novo em instantes.", "rate_limit");
  if (err.status && err.status >= 500) return new AiError("OpenAI indisponível no momento.", "unavailable");
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) return new AiError("Sem conexão com a OpenAI.", "unavailable");
  return new AiError(msg, "other");
}

export class OpenAiProvider implements AiProvider {
  constructor(private readonly apiKey: () => string | null) {}

  private client(): OpenAI {
    const key = this.apiKey();
    if (!key) throw new AiError("Chave da OpenAI não configurada.", "invalid_key");
    return new OpenAI({ apiKey: key, timeout: 60_000, maxRetries: 1 });
  }

  async chat(model: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiChatResult> {
    try {
      const res = await this.client().chat.completions.create({
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function" as const, function: t })), tool_choice: "auto" as const } : {}),
        max_completion_tokens: 2000,
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
      throw classify(e);
    }
  }

  async transcribe(model: string, audio: Uint8Array, fileName: string): Promise<string> {
    try {
      const file = await toFile(audio, fileName);
      const res = await this.client().audio.transcriptions.create({ file, model, language: "pt" });
      return (res as { text?: string }).text?.trim() ?? "";
    } catch (e) {
      throw classify(e);
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const out: string[] = [];
      for await (const m of this.client().models.list()) out.push(m.id);
      return out
        .filter((id) => /^(gpt|o\d)/.test(id) && !/(audio|realtime|tts|image|search|transcribe|embedding)/.test(id))
        .sort();
    } catch (e) {
      throw classify(e);
    }
  }
}
