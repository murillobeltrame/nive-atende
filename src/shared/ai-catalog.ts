// Catálogo das plataformas de IA e dos modelos que o lojista pode escolher.
// Preços em US$ por 1 milhão de tokens (entrada / saída), conferidos em outubro de 2026.
// São usados só para estimar o consumo; o valor oficial é sempre o da fatura de cada plataforma.
import type { AiProviderId, AppSettings } from "./types";

export type ModelTier = "economico" | "equilibrado" | "avancado" | "topo" | "anterior";

export interface CatalogModel {
  id: string;
  label: string;
  /** Linha curta para o lojista entender para que serve. */
  note: string;
  inUsd: number;
  outUsd: number;
  tier: ModelTier;
  recommended?: boolean;
}

export interface ProviderInfo {
  id: AiProviderId;
  name: string;
  company: string;
  keyPrefix: string;
  keyPlaceholder: string;
  defaultModel: string;
  /** Se a plataforma também transcreve os áudios dos clientes. */
  transcribes: boolean;
  models: CatalogModel[];
}

export const TIER_LABEL: Record<ModelTier, string> = {
  economico: "Econômicos (rápidos e baratos)",
  equilibrado: "Equilibrados",
  avancado: "Avançados",
  topo: "Topo de linha (caros)",
  anterior: "Gerações anteriores",
};

export const TIER_ORDER: ModelTier[] = ["economico", "equilibrado", "avancado", "topo", "anterior"];

export const PROVIDERS: Record<AiProviderId, ProviderInfo> = {
  openai: {
    id: "openai",
    name: "OpenAI (GPT)",
    company: "OpenAI",
    keyPrefix: "sk-",
    keyPlaceholder: "sk-...",
    defaultModel: "gpt-6-luna",
    transcribes: true,
    models: [
      { id: "gpt-6-luna", label: "GPT-6 Luna", note: "O mais barato da geração atual. Ótimo para atendimento.", inUsd: 0.1, outUsd: 0.5, tier: "economico", recommended: true },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", note: "Mais esperto, ainda com bom custo.", inUsd: 1, outUsd: 5, tier: "equilibrado" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", note: "Modelo principal da OpenAI. Raciocínio forte.", inUsd: 2, outUsd: 10, tier: "avancado" },
      { id: "gpt-6-sol", label: "GPT-6 Sol", note: "Versão anterior do Sol.", inUsd: 2, outUsd: 10, tier: "avancado" },
      { id: "gpt-6-astra", label: "GPT-6 Astra", note: "O mais poderoso. Caro demais para atendimento comum.", inUsd: 10, outUsd: 50, tier: "topo" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "Geração 5.6.", inUsd: 2, outUsd: 12, tier: "anterior" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "Geração 5.6.", inUsd: 4, outUsd: 20, tier: "anterior" },
      { id: "gpt-5.5", label: "GPT-5.5", note: "Geração 5.5.", inUsd: 5, outUsd: 30, tier: "anterior" },
      { id: "gpt-5.4", label: "GPT-5.4", note: "Geração 5.4.", inUsd: 2.5, outUsd: 15, tier: "anterior" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", note: "Geração 5.4, versão menor.", inUsd: 0.75, outUsd: 4.5, tier: "anterior" },
      { id: "gpt-5.4-nano", label: "GPT-5.4 nano", note: "Geração 5.4, versão mínima.", inUsd: 0.2, outUsd: 1.25, tier: "anterior" },
      { id: "gpt-5.2", label: "GPT-5.2", note: "Geração 5.2.", inUsd: 1.75, outUsd: 14, tier: "anterior" },
      { id: "gpt-5.1", label: "GPT-5.1", note: "Geração 5.1.", inUsd: 1.25, outUsd: 10, tier: "anterior" },
      { id: "gpt-5", label: "GPT-5", note: "Geração 5 (2025).", inUsd: 1.25, outUsd: 10, tier: "anterior" },
      { id: "gpt-5-mini", label: "GPT-5 mini", note: "Geração 5 (2025), versão menor.", inUsd: 0.25, outUsd: 2, tier: "anterior" },
      { id: "gpt-5-nano", label: "GPT-5 nano", note: "Geração 5 (2025), versão mínima.", inUsd: 0.05, outUsd: 0.4, tier: "anterior" },
      { id: "gpt-4.1", label: "GPT-4.1", note: "Antigo.", inUsd: 2, outUsd: 8, tier: "anterior" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", note: "Antigo.", inUsd: 0.4, outUsd: 1.6, tier: "anterior" },
      { id: "gpt-4.1-nano", label: "GPT-4.1 nano", note: "Antigo.", inUsd: 0.1, outUsd: 0.4, tier: "anterior" },
      { id: "gpt-4o", label: "GPT-4o", note: "Antigo.", inUsd: 2.5, outUsd: 10, tier: "anterior" },
      { id: "gpt-4o-mini", label: "GPT-4o mini", note: "Antigo.", inUsd: 0.15, outUsd: 0.6, tier: "anterior" },
    ],
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    company: "Anthropic",
    keyPrefix: "sk-ant-",
    keyPlaceholder: "sk-ant-...",
    defaultModel: "claude-haiku-5-5",
    transcribes: false,
    models: [
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "O mais rápido e barato da Anthropic. Ótimo para atendimento.", inUsd: 0.1, outUsd: 0.5, tier: "economico", recommended: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Equilíbrio entre inteligência e custo.", inUsd: 2, outUsd: 10, tier: "equilibrado" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Principal modelo da Anthropic. Muito esperto.", inUsd: 4, outUsd: 20, tier: "avancado" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", note: "O mais poderoso. Caro demais para atendimento comum.", inUsd: 10, outUsd: 50, tier: "topo" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "Geração 5.", inUsd: 2, outUsd: 10, tier: "anterior" },
      { id: "claude-opus-5", label: "Claude Opus 5", note: "Geração 5.", inUsd: 5, outUsd: 25, tier: "anterior" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", note: "Geração 4.", inUsd: 5, outUsd: 25, tier: "anterior" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "Geração 4.", inUsd: 3, outUsd: 15, tier: "anterior" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Geração 4.", inUsd: 1, outUsd: 5, tier: "anterior" },
    ],
  },
  gemini: {
    id: "gemini",
    name: "Google (Gemini)",
    company: "Google",
    keyPrefix: "AIza",
    keyPlaceholder: "AIza...",
    defaultModel: "gemini-3.8-flash",
    transcribes: true,
    models: [
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "O mais barato do Google. Tem cota grátis.", inUsd: 0.3, outUsd: 2.5, tier: "economico" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Rápido e esperto. Tem cota grátis (preço dobra em jan/2027).", inUsd: 0.75, outUsd: 3.75, tier: "equilibrado", recommended: true },
      { id: "gemini-4-argon", label: "Gemini 4 Argon", note: "O mais poderoso do Google (preço dobra em 1º/dez/2026).", inUsd: 2, outUsd: 10, tier: "avancado" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (prévia)", note: "Geração 3.1, linha Pro.", inUsd: 2, outUsd: 12, tier: "anterior" },
      { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "Geração 3.7.", inUsd: 0.75, outUsd: 3.75, tier: "anterior" },
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", note: "Geração 3.6.", inUsd: 1.5, outUsd: 7.5, tier: "anterior" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "Geração 3.5.", inUsd: 1.5, outUsd: 9, tier: "anterior" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", note: "Geração 3.1.", inUsd: 0.25, outUsd: 1.5, tier: "anterior" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Antigo.", inUsd: 0.3, outUsd: 2.5, tier: "anterior" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", note: "Antigo.", inUsd: 0.1, outUsd: 0.4, tier: "anterior" },
    ],
  },
};

export const PROVIDER_IDS: AiProviderId[] = ["openai", "anthropic", "gemini"];

export function isProviderId(v: unknown): v is AiProviderId {
  return v === "openai" || v === "anthropic" || v === "gemini";
}

/** Modelo de respostas da plataforma escolhida. */
export function activeProvider(s: AppSettings): AiProviderId {
  return isProviderId(s.ai.provider) ? s.ai.provider : "openai";
}

export function modelFor(s: AppSettings, p: AiProviderId): string {
  const m = (p === "openai" ? s.openai.model : p === "anthropic" ? s.anthropic.model : s.gemini.model).trim();
  return m || PROVIDERS[p].defaultModel;
}

export function activeModel(s: AppSettings): string {
  return modelFor(s, activeProvider(s));
}

export function hasKey(s: AppSettings, p: AiProviderId): boolean {
  return p === "openai" ? s.openai.hasApiKey : p === "anthropic" ? s.anthropic.hasApiKey : s.gemini.hasApiKey;
}

/** A IA está pronta: a plataforma escolhida tem chave. */
export function aiConfigured(s: AppSettings): boolean {
  return hasKey(s, activeProvider(s));
}

/**
 * Quem transcreve os áudios: a própria plataforma, se ela transcreve; senão a OpenAI ou o Gemini,
 * se o lojista tiver chave de um deles. null = nenhuma disponível.
 */
export function transcriptionProvider(s: AppSettings): AiProviderId | null {
  const p = activeProvider(s);
  if (PROVIDERS[p].transcribes) return p;
  if (s.openai.hasApiKey) return "openai";
  if (s.gemini.hasApiKey) return "gemini";
  return null;
}

/** Acha o modelo no catálogo pelo id exato ou por versão datada (ex.: gpt-6-luna-2026-09-22). */
export function findModel(id: string): (CatalogModel & { provider: AiProviderId }) | null {
  const clean = id.trim().replace(/^models\//, "");
  let best: (CatalogModel & { provider: AiProviderId }) | null = null;
  for (const p of PROVIDER_IDS) {
    for (const m of PROVIDERS[p].models) {
      if (clean === m.id) return { ...m, provider: p };
      // prefixo seguido de data/sufixo; o id mais longo ganha (gpt-5-mini antes de gpt-5)
      if (clean.startsWith(`${m.id}-`) && /^-(\d|latest|preview|exp)/.test(clean.slice(m.id.length)) && (!best || m.id.length > best.id.length))
        best = { ...m, provider: p };
    }
  }
  return best;
}

export function estimateChatCost(model: string, inputTokens: number, outputTokens: number): number {
  const m = findModel(model);
  const [pin, pout] = m ? [m.inUsd, m.outUsd] : [1, 5];
  return (inputTokens * pin + outputTokens * pout) / 1_000_000;
}

/** Nome amigável do modelo (ou o próprio id, se não estiver no catálogo). */
export function modelLabel(id: string): string {
  return findModel(id)?.label ?? id;
}

/** Modelo de transcrição da plataforma que vai transcrever os áudios. */
export function transcribeModelFor(s: AppSettings): string {
  const p = transcriptionProvider(s);
  if (p === "gemini") return s.gemini.transcribeModel.trim() || "gemini-3.5-flash-lite";
  return s.openai.transcribeModel.trim() || "gpt-transcribe";
}
