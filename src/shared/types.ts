// Tipos compartilhados entre o processo principal (Node/Electron) e a interface (React).

/** Quem produziu a mensagem. É gravado em cada mensagem e mostrado como etiqueta no app. */
export type MessageOrigin =
  | "consumidor" // recebida do cliente final
  | "ia" // enviada pelo motor de IA
  | "humano_app" // enviada pelo campo de resposta do app
  | "humano_celular" // enviada pela loja, mas não pelo app (celular / WhatsApp Web)
  | "sistema"; // linha de evento ("IA passou para humano", "Murillo assumiu"...)

export type MessageKind =
  | "text"
  | "audio"
  | "image"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "reaction"
  | "event"
  | "unknown";

export type MessageStatus = "received" | "pending" | "sent" | "failed" | "deleted";

export interface ChatMessage {
  id: string;
  conversationId: string;
  waMessageId: string | null;
  origin: MessageOrigin;
  kind: MessageKind;
  text: string | null;
  /** Transcrição de áudio recebido. */
  transcript: string | null;
  mediaMime: string | null;
  hasMedia: boolean;
  fileName: string | null;
  /** Duração do áudio em segundos, quando conhecida. */
  durationSec: number | null;
  createdAt: number;
  status: MessageStatus;
  /** Nome de quem respondeu (humano_app). */
  author: string | null;
  /** Para origin = "sistema": tipo do evento. */
  eventType: SystemEventType | null;
}

export type SystemEventType =
  | "handoff" // IA passou para humano
  | "takeover" // humano assumiu
  | "returned_to_ai" // devolvido para a IA
  | "identified" // cliente identificado
  | "identification_blocked"
  | "reservation_created"
  | "reservation_pending"
  | "reservation_expired"
  | "paused_by_phone" // humano respondeu pelo celular
  | "error";

/** Estado da conversa, usado para filtros e etiquetas da lista. */
export type ConversationState = "ia" | "humano" | "precisa_humano" | "ignorado";

export interface AiAction {
  at: number;
  label: string;
  kind: "info" | "handoff" | "error";
}

export interface Conversation {
  /** JID do WhatsApp (ex.: 5548999990000@s.whatsapp.net). */
  id: string;
  phone: string;
  displayName: string;
  customerId: string | null;
  customerName: string | null;
  verifiedBy: "phone" | "cpf" | null;
  state: ConversationState;
  lastMessageAt: number;
  lastPreview: string;
  lastOrigin: MessageOrigin | null;
  unread: number;
  /** Enquanto no futuro, a IA não responde nesta conversa. */
  aiPausedUntil: number | null;
  handoffReason: string | null;
  lastAiActions: AiAction[];
  aiRepliesCount: number;
  humanRepliesCount: number;
  costUsd: number;
}

export type ConversationFilter = "todas" | "precisa" | "ia" | "humano";

export type ReservationStatus = "pending_approval" | "created" | "failed" | "rejected" | "expired" | "completed";

/** Como a reserva se liga ao cadastro de clientes do ERP. */
export type ReservationCustomerStatus =
  | "identified" // identificado pelo telefone/CPF na conversa
  | "found_by_name" // encontrado no cadastro pelo nome informado
  | "new" // não existe: será cadastrado ao lançar o rascunho
  | "created_new" // foi cadastrado pelo Nive Atende
  | "ambiguous" // vários clientes com o mesmo nome: rascunho sai sem cliente
  | "none"; // cliente não informou o nome

export interface Reservation {
  id: string;
  conversationId: string;
  customerName: string;
  phone: string;
  productId: string;
  variantId: string;
  productDescription: string;
  variantLabel: string;
  quantity: number;
  unitPrice: number;
  saleId: string | null;
  orderNumber: number | null;
  status: ReservationStatus;
  customerStatus: ReservationCustomerStatus;
  expiresAt: number;
  createdAt: number;
  error: string | null;
}

export interface AuditEntry {
  id: number;
  at: number;
  phone: string;
  customerId: string | null;
  action: string;
  result: string;
}

// ---------------------------------------------------------------- configurações

export type Tone = "formal" | "proximo" | "descontraido";
export type SecondFactor = "birthdate" | "restricted";
export type NotifyMode = "humano" | "todas" | "nenhuma";

export interface AppSettings {
  /** apiKeyEnd: últimos 4 caracteres da chave salva (para conferência), ou null. */
  nive: { baseUrl: string; storeSlug: string; hasApiKey: boolean; apiKeyEnd: string | null };
  openai: { model: string; transcribeModel: string; hasApiKey: boolean; apiKeyEnd: string | null };
  /** mode "embedded" = WhatsApp dentro do app (padrão); "evolution" = servidor Evolution externo. */
  evolution: { mode: "embedded" | "evolution"; baseUrl: string; instanceName: string; webhookPort: number; hasApiKey: boolean; apiKeyEnd: string | null };
  attendance: {
    autoEnabled: boolean;
    businessHours: { enabled: boolean; days: number[]; start: string; end: string };
    outOfHoursMessage: string;
    replyDelayMinSec: number;
    replyDelayMaxSec: number;
    pauseOnHumanMinutes: number;
    ignoredNumbers: string[];
    catchUpWindowMinutes: number;
  };
  reservation: {
    autoEnabled: boolean;
    validityHours: number;
    maxQtyPerOrder: number;
    /** Cancela o rascunho no ERP quando a reserva vence sem a venda ser finalizada. */
    cancelExpiredDrafts: boolean;
    requireCustomer: boolean;
  };
  accounts: { enabled: boolean; secondFactor: SecondFactor; showCharges: boolean };
  personality: {
    storeName: string;
    tone: Tone;
    emojis: boolean;
    signature: string;
    presentAsAssistant: boolean;
    /** Texto livre do lojista: jeito de atender, sobre a loja, o que destacar. */
    context: string;
  };
  ai: {
    monthlyAlertUsd: number;
    maxAiRepliesPerConversationPerDay: number;
    /** Quantas mensagens anteriores da conversa a IA lê para responder. */
    historyMessages: number;
  };
  audio: { transcribe: boolean; maxSeconds: number };
  app: {
    launchAtLogin: boolean;
    notify: NotifyMode;
    sound: boolean;
    ownerAlertNumber: string;
    operatorName: string;
  };
  termsAcceptedAt: number | null;
}

export type SecretKey = "niveApiKey" | "openaiApiKey" | "evolutionApiKey";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

// ---------------------------------------------------------------- status

export type CheckState = "ok" | "warn" | "error" | "unknown";

export interface CheckResult {
  state: CheckState;
  message: string;
  at: number;
}

export type StatusActionKind =
  | "reconnect"
  | "restart_evolution"
  | "open_settings_nive"
  | "open_settings_openai"
  | "open_settings_evolution"
  | "open_ai_guide"
  | "accept_terms"
  | "retry";

export interface StatusSnapshot {
  level: "ok" | "warn" | "error";
  headline: string;
  detail: string;
  action: { label: string; kind: StatusActionKind } | null;
  checks: {
    internet: CheckResult;
    evolution: CheckResult;
    whatsapp: CheckResult;
    nive: CheckResult;
    openai: CheckResult;
  };
  autoEnabled: boolean;
  waitingCount: number;
  needsHumanCount: number;
  lastCheckAt: number;
  downSince: number | null;
}

export interface QrState {
  state: "open" | "connecting" | "close" | "unknown";
  qrBase64: string | null;
  pairingCode: string | null;
  message: string | null;
}

export interface TestResult {
  ok: boolean;
  message: string;
  models?: string[];
}

export interface UsageBucket {
  aiReplies: number;
  humanReplies: number;
  inputTokens: number;
  outputTokens: number;
  transcriptionSeconds: number;
  costUsd: number;
}

export interface UsageSummary {
  today: UsageBucket;
  month: UsageBucket;
  byDay: Array<{ day: string; aiReplies: number; humanReplies: number; costUsd: number }>;
  monthlyAlertUsd: number;
}

export interface AppInfo {
  version: string;
  platform: string;
}

export type NavigateTarget =
  | { page: "conversas"; filter?: ConversationFilter; conversationId?: string }
  | { page: "pendencias" }
  | { page: "ajustes"; section?: string }
  | { page: "status" };
