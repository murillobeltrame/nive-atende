// Escolhe a plataforma de IA conforme os ajustes do lojista: OpenAI, Anthropic (Claude) ou Google (Gemini).
// O motor só conhece a interface AiProvider; trocar de plataforma não exige reiniciar o app.
import type { AiProviderId, AppSettings } from "../../shared/types";
import { activeProvider, modelFor, PROVIDERS, transcriptionProvider } from "../../shared/ai-catalog";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { AiError, OpenAiProvider, type AiChatResult, type AiMessage, type AiProvider, type AiToolDef } from "./openai";

export class AiRouter implements AiProvider {
  readonly providers: Record<AiProviderId, AiProvider>;

  constructor(
    private readonly settings: () => AppSettings,
    keys: Record<AiProviderId, () => string | null>,
    providers?: Partial<Record<AiProviderId, AiProvider>>,
  ) {
    this.providers = {
      openai: providers?.openai ?? new OpenAiProvider(keys.openai),
      anthropic: providers?.anthropic ?? new AnthropicProvider(keys.anthropic),
      gemini: providers?.gemini ?? new GeminiProvider(keys.gemini),
    };
  }

  /** Respostas sempre pela plataforma escolhida nos ajustes. */
  chat(model: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiChatResult> {
    return this.providers[activeProvider(this.settings())].chat(model, messages, tools);
  }

  /** Áudio: a própria plataforma, ou a OpenAI/Gemini quando a escolhida (Claude) não transcreve. */
  transcribe(model: string, audio: Uint8Array, fileName: string): Promise<string> {
    const p = transcriptionProvider(this.settings());
    if (!p) {
      return Promise.reject(
        new AiError(`${PROVIDERS[activeProvider(this.settings())].company} não transcreve áudio. Cadastre uma chave da OpenAI ou do Gemini para entender os áudios.`, "other"),
      );
    }
    return this.providers[p].transcribe(model, audio, fileName);
  }

  listModels(): Promise<string[]> {
    return this.providers[activeProvider(this.settings())].listModels();
  }

  /** Testa uma plataforma: lista os modelos da conta e faz uma chamada mínima (detecta falta de crédito). */
  async test(p: AiProviderId, deep = true, model?: string): Promise<string[]> {
    const models = await this.providers[p].listModels();
    if (deep) await this.providers[p].chat(model?.trim() || modelFor(this.settings(), p), [{ role: "user", content: "Responda apenas: ok" }], []);
    return models;
  }
}
