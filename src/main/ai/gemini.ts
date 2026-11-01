// Google Gemini pelo endereço compatível com a API da OpenAI (mesmo formato de mensagens e ferramentas).
// A transcrição de áudio é feita mandando o áudio para o próprio modelo e pedindo o texto.
import type OpenAI from "openai";
import { OpenAiProvider } from "./openai";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

const TRANSCRIBE_PROMPT =
  "Transcreva este áudio em português do Brasil, exatamente como foi falado. Responda só com a transcrição, sem comentários. Se não houver fala, responda vazio.";

export class GeminiProvider extends OpenAiProvider {
  constructor(apiKey: () => string | null) {
    super(apiKey, {
      company: "Google (Gemini)",
      baseURL: GEMINI_BASE_URL,
      modelFilter: (id) => /^gemini/.test(id) && !/(tts|image|embedding|live|audio|vision)/.test(id),
      limitParam: "max_tokens",
      // modelos com raciocínio gastam parte do limite pensando
      maxTokens: 8000,
    });
  }

  override async transcribe(model: string, audio: Uint8Array, fileName: string): Promise<string> {
    const format = /\.wav$/i.test(fileName) ? "wav" : "mp3";
    try {
      const res = await this.client().chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: TRANSCRIBE_PROMPT },
              { type: "input_audio", input_audio: { data: Buffer.from(audio).toString("base64"), format } },
            ],
          },
        ] as OpenAI.Chat.ChatCompletionMessageParam[],
        max_tokens: 4000,
      });
      return res.choices[0]?.message.content?.trim() ?? "";
    } catch (e) {
      throw this.fail(e);
    }
  }
}
