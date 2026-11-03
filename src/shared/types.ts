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
  | "personal" // IA não respondeu: conversa pessoal
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
  /** Nome para mostrar: o salvo pelo lojista, senão o nome do perfil do contato, senão o telefone. */
  displayName: string;
  /** Nome que o próprio contato definiu no WhatsApp. */
  pushName: string | null;
  /** Nome dado pelo lojista no app (renomear contato). */
  savedName: string | null;
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

export type ReservationStatus = "pending_approval" | "created" | "failed" | "rejected" | "expired" | "completed" | "removed" | "cancelled";

/** Como a reserva se liga ao cadastro de clientes do ERP. */
export type ReservationCustomerStatus =
  | "identified" // identificado pelo telefone/CPF na conversa
  | "found_by_name" // encontrado no cadastro pelo nome informado
  | "new" // não existe: será cadastrado ao lançar o rascunho
  | "confirm" // há cadastros com nome parecido: o lojista confirma qual é (ou cadastra novo)
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
  /** Cadastros com nome parecido para o lojista confirmar antes de cadastrar um novo. */
  customerCandidates: Array<{ id: string; name: string }>;
  expiresAt: number;
  createdAt: number;
  error: string | null;
}

/** Resumo do dia para o dono da loja. */
export interface DailySummary {
  day: string;
  conversations: number;
  newContacts: number;
  unanswered: number;
  reservationsCreated: number;
  reservationsPending: number;
  reservationsCompleted: number;
  aiReplies: number;
  humanReplies: number;
  costUsd: number;
  waitlist: number;
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

/** Apelido que os clientes usam para um produto ("o da abelhinha" → "Atheeri"). */
export interface ProductNickname {
  /** Como o cliente chama, ex.: "abelhinha", "o azulzinho". */
  apelido: string;
  /** Nome real do produto (o que a IA busca no catálogo). */
  termo: string;
  /** "loja" = cadastrado pelo lojista; "ia" = aprendido numa conversa. */
  origem: "loja" | "ia";
  produtoId: string | null;
  criadoEm: number;
}

export interface AppSettings {
  /** apiKeyEnd: últimos 4 caracteres da chave salva (para conferência), ou null. */
  nive: { baseUrl: string; storeSlug: string; hasApiKey: boolean; apiKeyEnd: string | null };
  openai: { model: string; transcribeModel: string; hasApiKey: boolean; apiKeyEnd: string | null };
  anthropic: { model: string; hasApiKey: boolean; apiKeyEnd: string | null };
  /** transcribeModel: modelo que transcreve áudio quando o Gemini é quem transcreve. */
  gemini: { model: string; transcribeModel: string; hasApiKey: boolean; apiKeyEnd: string | null };
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
    /** Antes de responder, confere se a conversa é assunto da loja (conversa pessoal fica para o humano). */
    onlyStoreTopics: boolean;
    /** Marca as mensagens do cliente como lidas quando a IA vai responder. */
    markAsRead: boolean;
    /** Um lembrete leve quando o cliente recebeu opções e parou de responder. */
    followUpEnabled: boolean;
    followUpHours: number;
    /** Oferece "avise-me quando chegar" para produto esgotado e avisa quando o estoque volta. */
    backInStock: boolean;
  };
  reservation: {
    autoEnabled: boolean;
    validityHours: number;
    maxQtyPerOrder: number;
    /** Cancela o rascunho no ERP quando a reserva vence sem a venda ser finalizada. */
    cancelExpiredDrafts: boolean;
    /** Informa ao cliente até quando o produto fica reservado. */
    showDeadline: boolean;
    /** Lembra o cliente algumas horas antes de a reserva vencer. */
    reminder: boolean;
    reminderHours: number;
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
    /** Plataforma que responde os clientes. */
    provider: AiProviderId;
    monthlyAlertUsd: number;
    maxAiRepliesPerConversationPerDay: number;
    /** Quantas mensagens anteriores da conversa a IA lê para responder. */
    historyMessages: number;
    /** Usa respostas recentes da equipe como exemplo do jeito da loja. */
    learnFromStore: boolean;
  };
  audio: { transcribe: boolean; maxSeconds: number };
  app: {
    launchAtLogin: boolean;
    notify: NotifyMode;
    sound: boolean;
    ownerAlertNumber: string;
    operatorName: string;
    /** Resumo do dia no app (e no WhatsApp do dono, se houver número). */
    dailySummary: boolean;
    dailySummaryHour: number;
  };
  termsAcceptedAt: number | null;
}

export type SecretKey = "niveApiKey" | "openaiApiKey" | "anthropicApiKey" | "geminiApiKey" | "evolutionApiKey";

/** Plataformas de IA suportadas. */
export type AiProviderId = "openai" | "anthropic" | "gemini";

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
  /** Plataforma testada (testes de IA). */
  provider?: AiProviderId;
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
