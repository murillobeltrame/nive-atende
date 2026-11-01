import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider, fromClaudeResponse, toClaudeRequest } from "../src/main/ai/anthropic";
import type { AiMessage, AiProvider } from "../src/main/ai/openai";
import { classifyAiError } from "../src/main/ai/openai";
import { AiRouter } from "../src/main/ai/router";
import { DEFAULT_SETTINGS, deepMerge } from "../src/main/settings";
import {
  activeModel,
  aiConfigured,
  estimateChatCost,
  findModel,
  PROVIDER_IDS,
  PROVIDERS,
  transcribeModelFor,
  transcriptionProvider,
} from "../src/shared/ai-catalog";
import type { AppSettings, DeepPartial } from "../src/shared/types";

function settingsWith(patch: DeepPartial<AppSettings>): AppSettings {
  return deepMerge(structuredClone(DEFAULT_SETTINGS), patch);
}

describe("catálogo de modelos", () => {
  it("cada plataforma tem o modelo padrão no catálogo e ids únicos", () => {
    const all = new Set<string>();
    for (const p of PROVIDER_IDS) {
      const info = PROVIDERS[p];
      expect(info.models.some((m) => m.id === info.defaultModel)).toBe(true);
      expect(info.models.filter((m) => m.recommended)).toHaveLength(1);
      for (const m of info.models) {
        expect(all.has(m.id)).toBe(false);
        all.add(m.id);
      }
    }
  });

  it("estima o custo pelo catálogo, inclusive versões datadas", () => {
    expect(estimateChatCost("gpt-6-luna", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(estimateChatCost("claude-sonnet-5-5", 1_000_000, 0)).toBeCloseTo(2);
    expect(estimateChatCost("gpt-5-mini-2025-08-07", 1_000_000, 0)).toBeCloseTo(0.25);
    expect(findModel("models/gemini-3.8-flash")?.provider).toBe("gemini");
    // gpt-5.4-mini não pode ser confundido com gpt-5
    expect(findModel("gpt-5.4-mini")?.id).toBe("gpt-5.4-mini");
  });

  it("escolhe o modelo da plataforma ativa", () => {
    expect(activeModel(settingsWith({}))).toBe("gpt-6-luna");
    expect(activeModel(settingsWith({ ai: { provider: "anthropic" } }))).toBe("claude-haiku-5-5");
    expect(activeModel(settingsWith({ ai: { provider: "gemini" }, gemini: { model: "gemini-4-argon" } }))).toBe("gemini-4-argon");
  });

  it("IA configurada depende da chave da plataforma escolhida", () => {
    const s = settingsWith({ ai: { provider: "anthropic" } });
    s.openai.hasApiKey = true;
    expect(aiConfigured(s)).toBe(false);
    s.anthropic.hasApiKey = true;
    expect(aiConfigured(s)).toBe(true);
  });

  it("áudio com Claude usa a OpenAI ou o Gemini, se houver chave", () => {
    const s = settingsWith({ ai: { provider: "anthropic" } });
    expect(transcriptionProvider(s)).toBeNull();
    s.gemini.hasApiKey = true;
    expect(transcriptionProvider(s)).toBe("gemini");
    expect(transcribeModelFor(s)).toBe("gemini-3.5-flash-lite");
    s.openai.hasApiKey = true;
    expect(transcriptionProvider(s)).toBe("openai");
    expect(transcribeModelFor(s)).toBe("gpt-transcribe");
  });
});

describe("conversão para o Claude", () => {
  it("separa o sistema, junta papéis seguidos e converte ferramentas e fotos", () => {
    const msgs: AiMessage[] = [
      { role: "system", content: "Você é a loja." },
      { role: "assistant", content: "Oi! Como posso ajudar?" },
      { role: "user", content: "tem tênis 40?" },
      { role: "user", content: [{ type: "text", text: "esse aqui" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "buscar_produtos", arguments: '{"q":"tênis"}' } }] },
      { role: "tool", tool_call_id: "t1", content: '{"itens":[]}' },
      { role: "system", content: "Seja breve." },
    ];
    const req = toClaudeRequest(msgs);
    expect(req.system).toBe("Você é a loja.\n\nSeja breve.");
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(req.messages[0]!.content[0]).toEqual({ type: "text", text: "(início da conversa)" });
    expect(req.messages[2]!.content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
    expect(req.messages[3]!.content[0]).toEqual({ type: "tool_use", id: "t1", name: "buscar_produtos", input: { q: "tênis" } });
    expect(req.messages[4]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: '{"itens":[]}' });
  });

  it("devolve o raciocínio intacto na rodada seguinte", () => {
    const res = fromClaudeResponse({
      content: [
        { type: "thinking", thinking: "...", signature: "abc" },
        { type: "text", text: "Vou consultar." },
        { type: "tool_use", id: "t9", name: "buscar_produtos", input: { q: "bolsa" } },
      ],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
    });
    expect(res.content).toBe("Vou consultar.");
    expect(res.toolCalls[0]).toEqual({ id: "t9", type: "function", function: { name: "buscar_produtos", arguments: '{"q":"bolsa"}' } });
    expect(res.inputTokens).toBe(150);
    const req = toClaudeRequest([
      { role: "user", content: "tem bolsa?" },
      { role: "assistant", content: res.content, tool_calls: res.toolCalls, raw: res.raw },
      { role: "tool", tool_call_id: "t9", content: "[]" },
    ]);
    expect(req.messages[1]!.content[0]).toEqual({ type: "thinking", thinking: "...", signature: "abc" });
  });

  it("chama a API com cabeçalhos e ferramentas no formato do Claude", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.tools[0]).toEqual({ name: "f", description: "d", input_schema: { type: "object" } });
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-x");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    });
    const p = new AnthropicProvider(() => "sk-ant-x", fetchMock as unknown as typeof fetch);
    const r = await p.chat("claude-haiku-5-5", [{ role: "user", content: "oi" }], [{ name: "f", description: "d", parameters: { type: "object" } }]);
    expect(r.content).toBe("ok");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("traduz erros do Claude", async () => {
    const p = new AnthropicProvider(
      () => "k",
      (async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }), { status: 400 })) as unknown as typeof fetch,
    );
    await expect(p.chat("claude-haiku-5-5", [{ role: "user", content: "oi" }], [])).rejects.toMatchObject({ kind: "no_credit", message: "A conta da Anthropic está sem créditos." });
    expect(classifyAiError({ status: 401, message: "invalid x-api-key" }, "Anthropic").kind).toBe("invalid_key");
    expect(classifyAiError({ status: 429, error: { status: "RESOURCE_EXHAUSTED" }, message: "quota" }, "Google (Gemini)").kind).toBe("rate_limit");
  });
});

describe("roteador de plataformas", () => {
  function fake(name: string): AiProvider & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async chat(model) {
        calls.push(`chat:${model}`);
        return { content: name, toolCalls: [], inputTokens: 0, outputTokens: 0 };
      },
      async transcribe(model) {
        calls.push(`transcribe:${model}`);
        return name;
      },
      async listModels() {
        return [name];
      },
    };
  }

  it("responde pela plataforma escolhida e transcreve pela que tiver chave", async () => {
    let s = settingsWith({ ai: { provider: "anthropic" } });
    const providers = { openai: fake("openai"), anthropic: fake("anthropic"), gemini: fake("gemini") };
    const none = () => null;
    const r = new AiRouter(() => s, { openai: none, anthropic: none, gemini: none }, providers);
    expect((await r.chat("claude-haiku-5-5", [{ role: "user", content: "oi" }], [])).content).toBe("anthropic");
    await expect(r.transcribe("x", new Uint8Array(), "a.mp3")).rejects.toMatchObject({ kind: "other" });
    s.gemini.hasApiKey = true;
    expect(await r.transcribe("gemini-3.5-flash-lite", new Uint8Array(), "a.mp3")).toBe("gemini");
    s = settingsWith({ ai: { provider: "openai" } });
    expect((await r.chat("gpt-6-luna", [{ role: "user", content: "oi" }], [])).content).toBe("openai");
    expect(await r.test("gemini", true, "gemini-4-argon")).toEqual(["gemini"]);
    expect(providers.gemini.calls).toContain("chat:gemini-4-argon");
  });
});
