// Contrato de IPC: a interface só fala com o processo principal por esta API (window.niveAtende).
import type {
  AiProviderId,
  AppInfo,
  AppSettings,
  AuditEntry,
  ChatMessage,
  Conversation,
  ConversationFilter,
  DailySummary,
  DeepPartial,
  NavigateTarget,
  ProductNickname,
  QrState,
  Reservation,
  SecretKey,
  StatusSnapshot,
  TestResult,
  UpdateState,
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
  /** Testa a chave de uma plataforma de IA (OpenAI, Anthropic ou Gemini) e devolve os modelos da conta. */
  testAi(provider: AiProviderId, model?: string): Promise<TestResult>;
  testEvolution(): Promise<TestResult>;

  // status
  getStatus(): Promise<StatusSnapshot>;
  refreshStatus(): Promise<StatusSnapshot>;
  setAutoEnabled(enabled: boolean): Promise<StatusSnapshot>;
  restartEvolution(): Promise<TestResult>;

  // WhatsApp
  whatsappConnect(): Promise<QrState>;
  whatsappLogout(): Promise<QrState>;
  /** "Conectar com número de telefone": devolve o código de 8 caracteres para digitar no celular. */
  whatsappPairingCode(phone: string): Promise<{ ok: boolean; code: string | null; message: string }>;

  // conversas
  listConversations(filter: ConversationFilter, q?: string): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  getMedia(messageId: string): Promise<string | null>; // data URL
  /** Foto de perfil do contato (data URL), quando ele deixa pública. */
  getAvatar(conversationId: string): Promise<string | null>;
  /** Renomeia o contato no app e, se pedido, salva na agenda do WhatsApp. Nome vazio volta ao nome do perfil. */
  saveContact(conversationId: string, name: string, saveToPhone: boolean): Promise<{ conversation: Conversation; savedOnPhone: boolean; message: string }>;
  markRead(conversationId: string): Promise<void>;
  sendText(conversationId: string, text: string): Promise<ChatMessage>;
  sendMedia(conversationId: string, media: OutgoingMedia): Promise<ChatMessage>;
  sendAudio(conversationId: string, base64: string, mime: string): Promise<ChatMessage>;
  resendSticker(conversationId: string, messageId: string): Promise<ChatMessage>;
  /** "Apagar para todos": só mensagens enviadas pela loja (IA ou equipe). */
  deleteMessage(messageId: string): Promise<ChatMessage>;
  /** Apaga a conversa do app (mensagens e mídias). Não apaga no celular. */
  deleteConversation(conversationId: string): Promise<void>;
  takeOver(conversationId: string): Promise<Conversation>;
  returnToAi(conversationId: string): Promise<Conversation>;
  suggestReply(conversationId: string): Promise<string>;

  /** Preferências que a IA anotou sobre o cliente. */
  getCustomerNotes(conversationId: string): Promise<string[]>;
  removeCustomerNote(conversationId: string, note: string): Promise<string[]>;

  /** Apelidos de produtos ("abelhinha" → Atheeri): cadastrados pelo lojista ou aprendidos pela IA. */
  listNicknames(): Promise<ProductNickname[]>;
  addNickname(apelido: string, termo: string): Promise<ProductNickname[]>;
  removeNickname(apelido: string): Promise<ProductNickname[]>;

  // simulador (conversa de teste com a IA, sem WhatsApp)
  simMessages(): Promise<ChatMessage[]>;
  simSend(text: string): Promise<void>;
  simReset(): Promise<void>;

  // reservas, consumo, auditoria
  listReservations(): Promise<Reservation[]>;
  /** Aprova; quando há cadastros parecidos, informe o cliente escolhido ou createNew. */
  approveReservation(id: string, choice?: { customerId?: string | null; createNew?: boolean }): Promise<Reservation>;
  rejectReservation(id: string): Promise<Reservation>;
  /** Cancela a reserva; se já virou rascunho, cancela o rascunho no ERP (as peças voltam ao estoque). */
  cancelReservation(id: string): Promise<Reservation>;
  getUsage(): Promise<UsageSummary>;
  getDailySummary(): Promise<DailySummary>;
  listAudit(limit?: number): Promise<AuditEntry[]>;

  // utilidades
  openExternal(url: string): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  /** Abre a pasta de registros (logs) do app. */
  openLogs(): Promise<void>;

  // atualização do programa
  getUpdateState(): Promise<UpdateState>;
  checkForUpdate(): Promise<UpdateState>;
  /** Fecha o programa, instala a versão já baixada e abre de novo. */
  installUpdate(): Promise<boolean>;

  // eventos (retornam função para cancelar a inscrição)
  onStatus(cb: (s: StatusSnapshot) => void): () => void;
  onConversation(cb: (c: Conversation) => void): () => void;
  onMessage(cb: (m: ChatMessage) => void): () => void;
  onQr(cb: (q: QrState) => void): () => void;
  onReservation(cb: (r: Reservation) => void): () => void;
  onNavigate(cb: (t: NavigateTarget) => void): () => void;
  /** O que a IA está fazendo numa conversa agora (label null = terminou). */
  onActivity(cb: (a: { conversationId: string; label: string | null }) => void): () => void;
  onSim(cb: (e: { message?: ChatMessage; activity?: string | null }) => void): () => void;
  /** O cliente está digitando/gravando áudio (state null = parou). */
  onTyping(cb: (t: { conversationId: string; state: "composing" | "recording" | null }) => void): () => void;
  onConversationDeleted(cb: (conversationId: string) => void): () => void;
  onUpdate(cb: (u: UpdateState) => void): () => void;
}

/** Nomes dos canais de eventos (main → renderer). */
export const EVENTS = {
  status: "evt:status",
  conversation: "evt:conversation",
  message: "evt:message",
  qr: "evt:qr",
  reservation: "evt:reservation",
  navigate: "evt:navigate",
  activity: "evt:activity",
  sim: "evt:sim",
  typing: "evt:typing",
  conversationDeleted: "evt:conversationDeleted",
  update: "evt:update",
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
  "testAi",
  "testEvolution",
  "getStatus",
  "refreshStatus",
  "setAutoEnabled",
  "restartEvolution",
  "whatsappConnect",
  "whatsappLogout",
  "whatsappPairingCode",
  "listConversations",
  "getConversation",
  "getMessages",
  "getMedia",
  "getAvatar",
  "saveContact",
  "markRead",
  "sendText",
  "sendMedia",
  "sendAudio",
  "resendSticker",
  "deleteMessage",
  "deleteConversation",
  "takeOver",
  "returnToAi",
  "suggestReply",
  "getCustomerNotes",
  "removeCustomerNote",
  "listNicknames",
  "addNickname",
  "removeNickname",
  "simMessages",
  "simSend",
  "simReset",
  "listReservations",
  "approveReservation",
  "rejectReservation",
  "cancelReservation",
  "getUsage",
  "getDailySummary",
  "listAudit",
  "openExternal",
  "getAppInfo",
  "openLogs",
  "getUpdateState",
  "checkForUpdate",
  "installUpdate",
] as const satisfies ReadonlyArray<keyof NiveAtendeApi>;

export type RpcMethod = (typeof RPC_METHODS)[number];
