// Contrato de IPC: a interface só fala com o processo principal por esta API (window.niveAtende).
import type {
  AppInfo,
  AppSettings,
  AuditEntry,
  ChatMessage,
  Conversation,
  ConversationFilter,
  DeepPartial,
  NavigateTarget,
  QrState,
  Reservation,
  SecretKey,
  StatusSnapshot,
  TestResult,
  UsageSummary,
} from "./types";

export interface OutgoingMedia {
  fileName: string;
  mime: string;
  base64: string;
  caption?: string;
}

export interface NiveAtendeApi {
  // configurações
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
  setSecret(key: SecretKey, value: string): Promise<AppSettings>;
  clearSecret(key: SecretKey): Promise<AppSettings>;
  acceptTerms(): Promise<AppSettings>;
  testNive(): Promise<TestResult>;
  testOpenAI(): Promise<TestResult>;
  testEvolution(): Promise<TestResult>;

  // status
  getStatus(): Promise<StatusSnapshot>;
  refreshStatus(): Promise<StatusSnapshot>;
  setAutoEnabled(enabled: boolean): Promise<StatusSnapshot>;
  restartEvolution(): Promise<TestResult>;

  // WhatsApp
  whatsappConnect(): Promise<QrState>;
  whatsappLogout(): Promise<QrState>;

  // conversas
  listConversations(filter: ConversationFilter, q?: string): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  getMedia(messageId: string): Promise<string | null>; // data URL
  markRead(conversationId: string): Promise<void>;
  sendText(conversationId: string, text: string): Promise<ChatMessage>;
  sendMedia(conversationId: string, media: OutgoingMedia): Promise<ChatMessage>;
  sendAudio(conversationId: string, base64: string, mime: string): Promise<ChatMessage>;
  resendSticker(conversationId: string, messageId: string): Promise<ChatMessage>;
  takeOver(conversationId: string): Promise<Conversation>;
  returnToAi(conversationId: string): Promise<Conversation>;
  suggestReply(conversationId: string): Promise<string>;

  // reservas, consumo, auditoria
  listReservations(): Promise<Reservation[]>;
  approveReservation(id: string): Promise<Reservation>;
  rejectReservation(id: string): Promise<Reservation>;
  getUsage(): Promise<UsageSummary>;
  listAudit(limit?: number): Promise<AuditEntry[]>;

  // utilidades
  openExternal(url: string): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  /** Abre a pasta de registros (logs) do app. */
  openLogs(): Promise<void>;

  // eventos (retornam função para cancelar a inscrição)
  onStatus(cb: (s: StatusSnapshot) => void): () => void;
  onConversation(cb: (c: Conversation) => void): () => void;
  onMessage(cb: (m: ChatMessage) => void): () => void;
  onQr(cb: (q: QrState) => void): () => void;
  onReservation(cb: (r: Reservation) => void): () => void;
  onNavigate(cb: (t: NavigateTarget) => void): () => void;
}

/** Nomes dos canais de eventos (main → renderer). */
export const EVENTS = {
  status: "evt:status",
  conversation: "evt:conversation",
  message: "evt:message",
  qr: "evt:qr",
  reservation: "evt:reservation",
  navigate: "evt:navigate",
} as const;

/** Métodos invocáveis (renderer → main). O canal é "rpc:<método>". */
export const RPC_METHODS = [
  "getSettings",
  "saveSettings",
  "setSecret",
  "clearSecret",
  "acceptTerms",
  "testNive",
  "testOpenAI",
  "testEvolution",
  "getStatus",
  "refreshStatus",
  "setAutoEnabled",
  "restartEvolution",
  "whatsappConnect",
  "whatsappLogout",
  "listConversations",
  "getConversation",
  "getMessages",
  "getMedia",
  "markRead",
  "sendText",
  "sendMedia",
  "sendAudio",
  "resendSticker",
  "takeOver",
  "returnToAi",
  "suggestReply",
  "listReservations",
  "approveReservation",
  "rejectReservation",
  "getUsage",
  "listAudit",
  "openExternal",
  "getAppInfo",
  "openLogs",
] as const satisfies ReadonlyArray<keyof NiveAtendeApi>;

export type RpcMethod = (typeof RPC_METHODS)[number];
