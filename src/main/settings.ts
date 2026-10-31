// Configurações do lojista. Valores comuns ficam no banco; chaves (Nive, OpenAI, Evolution) ficam
// criptografadas pelo sistema operacional (safeStorage do Electron = DPAPI no Windows, Keychain no Mac).
import type { AppSettings, DeepPartial, SecretKey } from "../shared/types";
import type { Store } from "./store/db";

export interface SecretBox {
  isAvailable(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  nive: { baseUrl: "https://api.nivesistemas.com.br", storeSlug: "", hasApiKey: false, apiKeyEnd: null },
  openai: { model: "gpt-5-mini", transcribeModel: "gpt-transcribe", hasApiKey: false, apiKeyEnd: null },
  evolution: { mode: "embedded", baseUrl: "http://localhost:8080", instanceName: "nive-atende", webhookPort: 3931, hasApiKey: false, apiKeyEnd: null },
  attendance: {
    autoEnabled: false,
    businessHours: { enabled: false, days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "18:00" },
    outOfHoursMessage:
      "Oi! No momento estamos fora do horário de atendimento. Assim que abrirmos, respondemos sua mensagem.",
    replyDelayMinSec: 5,
    replyDelayMaxSec: 10,
    pauseOnHumanMinutes: 120,
    ignoredNumbers: [],
    catchUpWindowMinutes: 120,
    onlyStoreTopics: true,
  },
  reservation: { autoEnabled: false, validityHours: 24, maxQtyPerOrder: 3, requireCustomer: false, cancelExpiredDrafts: true },
  accounts: { enabled: true, secondFactor: "birthdate", showCharges: true },
  personality: { storeName: "", tone: "proximo", emojis: true, signature: "", presentAsAssistant: false, context: "" },
  ai: { monthlyAlertUsd: 10, maxAiRepliesPerConversationPerDay: 30, historyMessages: 40 },
  audio: { transcribe: true, maxSeconds: 120 },
  app: { launchAtLogin: true, notify: "humano", sound: true, ownerAlertNumber: "", operatorName: "" },
  termsAcceptedAt: null,
};

const SECRET_FLAGS: Record<SecretKey, (s: AppSettings, end: string | null) => void> = {
  niveApiKey: (s, end) => {
    s.nive.hasApiKey = true;
    s.nive.apiKeyEnd = end;
  },
  openaiApiKey: (s, end) => {
    s.openai.hasApiKey = true;
    s.openai.apiKeyEnd = end;
  },
  evolutionApiKey: (s, end) => {
    s.evolution.hasApiKey = true;
    s.evolution.apiKeyEnd = end;
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Mescla profunda; arrays e valores simples substituem. Ignora chaves desconhecidas. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base) || v === undefined) continue;
    const current = (base as Record<string, unknown>)[k];
    if (isPlainObject(current) && isPlainObject(v)) out[k] = deepMerge(current, v);
    else if (current === null || typeof current === typeof v || v === null) out[k] = v;
  }
  return out as T;
}

export class SettingsService {
  private listeners = new Set<(s: AppSettings) => void>();

  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
  ) {}

  get(): AppSettings {
    const saved = this.store.getKv<DeepPartial<AppSettings>>("settings") ?? {};
    const s = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
    s.nive.hasApiKey = false;
    s.openai.hasApiKey = false;
    s.evolution.hasApiKey = false;
    s.nive.apiKeyEnd = null;
    s.openai.apiKeyEnd = null;
    s.evolution.apiKeyEnd = null;
    for (const key of Object.keys(SECRET_FLAGS) as SecretKey[]) {
      if (!this.store.getSecretBlob(key)) continue;
      const plain = this.getSecret(key);
      // chave guardada mas ilegível (ex.: cofre do sistema mudou) conta como não configurada
      if (!plain) continue;
      SECRET_FLAGS[key](s, plain.length >= 8 ? plain.slice(-4) : null);
    }
    return s;
  }

  save(patch: DeepPartial<AppSettings>): AppSettings {
    const current = this.get();
    const next = deepMerge(current, patch);
    next.attendance.replyDelayMinSec = Math.max(0, Math.min(120, Number(next.attendance.replyDelayMinSec) || 0));
    next.attendance.replyDelayMaxSec = Math.max(
      next.attendance.replyDelayMinSec,
      Math.min(180, Number(next.attendance.replyDelayMaxSec) || 0),
    );
    next.attendance.ignoredNumbers = next.attendance.ignoredNumbers.map((n) => String(n).trim()).filter(Boolean);
    next.reservation.maxQtyPerOrder = Math.max(1, Math.floor(Number(next.reservation.maxQtyPerOrder) || 1));
    next.reservation.validityHours = Math.max(1, Number(next.reservation.validityHours) || 24);
    next.nive.baseUrl = next.nive.baseUrl.trim().replace(/\/+$/, "");
    next.evolution.baseUrl = next.evolution.baseUrl.trim().replace(/\/+$/, "");
    next.nive.storeSlug = next.nive.storeSlug.trim();
    // flags de chave são derivadas, nunca salvas
    const { nive, openai, evolution, ...rest } = next;
    const toSave = {
      ...rest,
      nive: { baseUrl: nive.baseUrl, storeSlug: nive.storeSlug },
      openai: { model: openai.model, transcribeModel: openai.transcribeModel },
      evolution: {
        mode: evolution.mode === "evolution" ? "evolution" : "embedded",
        baseUrl: evolution.baseUrl,
        instanceName: evolution.instanceName,
        webhookPort: evolution.webhookPort,
      },
    };
    this.store.setKv("settings", toSave);
    const result = this.get();
    for (const l of this.listeners) l(result);
    return result;
  }

  onChange(cb: (s: AppSettings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getSecret(key: SecretKey): string | null {
    const blob = this.store.getSecretBlob(key);
    if (!blob) return null;
    try {
      return this.box.decrypt(blob);
    } catch {
      return null;
    }
  }

  setSecret(key: SecretKey, value: string): AppSettings {
    const trimmed = value.trim();
    if (!trimmed) return this.clearSecret(key);
    if (!this.box.isAvailable()) {
      throw new Error("A criptografia do sistema não está disponível neste computador; a chave não foi salva.");
    }
    this.store.setSecretBlob(key, this.box.encrypt(trimmed));
    const s = this.get();
    for (const l of this.listeners) l(s);
    return s;
  }

  clearSecret(key: SecretKey): AppSettings {
    this.store.deleteSecret(key);
    const s = this.get();
    for (const l of this.listeners) l(s);
    return s;
  }

  acceptTerms(): AppSettings {
    return this.save({ termsAcceptedAt: Date.now() });
  }
}
