// API simulada em memória: permite abrir a interface no navegador (sem Electron) com dados de exemplo.
// Parâmetros de URL úteis: ?status=ok|warn|error  ?terms=0 (mostra o termo)  ?setup=1 (sem chaves)
import type { NiveAtendeApi, OutgoingMedia } from "../../../shared/ipc";
import type {
  AppSettings,
  AuditEntry,
  ChatMessage,
  Conversation,
  ConversationFilter,
  DeepPartial,
  NavigateTarget,
  QrState,
  Reservation,
  StatusSnapshot,
  UsageSummary,
} from "../../../shared/types";

type Listener<T> = (v: T) => void;

function emitter<T>() {
  const ls = new Set<Listener<T>>();
  return {
    on(cb: Listener<T>) {
      ls.add(cb);
      return () => {
        ls.delete(cb);
      };
    },
    emit(v: T) {
      ls.forEach((l) => l(v));
    },
  };
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
        ? deepMerge(cur, v)
        : v;
  }
  return out as T;
}

const delay = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function silentWavDataUrl(seconds = 1): string {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  w(36, "data");
  v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

const PRODUCT_IMG = svgDataUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" fill="#E9DFD3"/><path d="M150 130h180l-14 150H164z" fill="#B87A45"/><path d="M190 130c0-40 22-62 50-62s50 22 50 62" fill="none" stroke="#7A4E2A" stroke-width="12"/><text x="240" y="305" font-family="sans-serif" font-size="16" text-anchor="middle" fill="#5E4630">Bolsa caramelo</text></svg>`,
);
const STICKER_IMG = svgDataUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><circle cx="100" cy="100" r="86" fill="#FFD95A" stroke="#E0A800" stroke-width="6"/><circle cx="72" cy="84" r="10" fill="#4A3500"/><circle cx="128" cy="84" r="10" fill="#4A3500"/><path d="M62 122c22 30 54 30 76 0" fill="none" stroke="#4A3500" stroke-width="9" stroke-linecap="round"/></svg>`,
);

function fakeQr(): string {
  const n = 25;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const finder = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="7" height="7" fill="#111"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#111"/>`;
  const inFinder = (x: number, y: number) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  let cells = "";
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) if (!inFinder(x, y) && rnd() > 0.52) cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="#111"/>`;
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/>${cells}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`,
  );
}

export function createMockApi(): NiveAtendeApi {
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const now = Date.now();
  const min = 60_000;
  const setup = params.get("setup") === "1";

  let settings: AppSettings = {
    nive: { baseUrl: "https://api.nivesistemas.com.br", storeSlug: setup ? "" : "loja-exemplo", hasApiKey: !setup, apiKeyEnd: setup ? null : "9f2a" },
    openai: { model: "gpt-5-mini", transcribeModel: "gpt-transcribe", hasApiKey: !setup, apiKeyEnd: setup ? null : "9f2a" },
    evolution: { mode: "embedded", baseUrl: "http://localhost:8080", instanceName: "nive-atende", webhookPort: 3931, hasApiKey: !setup, apiKeyEnd: setup ? null : "9f2a" },
    attendance: {
      autoEnabled: true,
      businessHours: { enabled: true, days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "18:00" },
      outOfHoursMessage: "Oi! Estamos fora do horário agora. Respondemos assim que a loja abrir.",
      replyDelayMinSec: 5,
      replyDelayMaxSec: 10,
      pauseOnHumanMinutes: 120,
      ignoredNumbers: ["5548999990001"],
      catchUpWindowMinutes: 120,
    },
    reservation: { autoEnabled: true, validityHours: 24, maxQtyPerOrder: 3, requireCustomer: false, cancelExpiredDrafts: true },
    accounts: { enabled: true, secondFactor: "birthdate", showCharges: true },
    personality: {
      storeName: "Loja Exemplo",
      tone: "proximo",
      emojis: false,
      signature: "",
      presentAsAssistant: false,
      context: "",
    },
    ai: { monthlyAlertUsd: 10, maxAiRepliesPerConversationPerDay: 30, historyMessages: 40 },
    audio: { transcribe: true, maxSeconds: 120 },
    app: { launchAtLogin: true, notify: "humano", sound: true, ownerAlertNumber: "", operatorName: "Murillo" },
    termsAcceptedAt: params.get("terms") === "0" ? null : now - 86_400_000,
  };

  const conv = (c: Partial<Conversation> & Pick<Conversation, "id" | "displayName">): Conversation => ({
    phone: c.id.split("@")[0] ?? "",
    customerId: null,
    customerName: null,
    verifiedBy: null,
    state: "ia",
    lastMessageAt: now,
    lastPreview: "",
    lastOrigin: null,
    unread: 0,
    aiPausedUntil: null,
    handoffReason: null,
    lastAiActions: [],
    aiRepliesCount: 0,
    humanRepliesCount: 0,
    costUsd: 0,
    ...c,
  });

  const conversations: Conversation[] = [
    conv({
      id: "5548999992210@s.whatsapp.net",
      displayName: "Bruna Lima",
      customerId: "c-bruna",
      customerName: "Bruna Lima",
      verifiedBy: "phone",
      state: "humano",
      lastMessageAt: now - 2 * min,
      lastPreview: "Consigo fazer R$ 149,90 no Pix, pode ser?",
      lastOrigin: "humano_app",
      aiPausedUntil: now + 108 * min,
      lastAiActions: [
        { at: now - 13 * min, label: "Transcreveu áudio de 0:08", kind: "info" },
        { at: now - 13 * min, label: "Buscou “bolsa caramelo” → 1 un. · R$ 159,90", kind: "info" },
        { at: now - 12 * min, label: "Reservou → rascunho #1043 · válido até amanhã 18h", kind: "info" },
        { at: now - 12 * min, label: "Passou para humano: pedido de desconto", kind: "handoff" },
      ],
      aiRepliesCount: 2,
      humanRepliesCount: 1,
      costUsd: 0.0031,
    }),
    conv({
      id: "5548999993381@s.whatsapp.net",
      displayName: "Carlos Mendes",
      state: "precisa_humano",
      lastMessageAt: now - 5 * min,
      lastPreview: "Quero trocar a calça que comprei ontem",
      lastOrigin: "consumidor",
      unread: 2,
      handoffReason: "Troca · fora do escopo",
      lastAiActions: [{ at: now - 5 * min, label: "Passou para humano: troca de produto", kind: "handoff" }],
      aiRepliesCount: 1,
      costUsd: 0.0008,
    }),
    conv({
      id: "5548999994455@s.whatsapp.net",
      displayName: "Ana Souza",
      customerId: "c-ana",
      customerName: "Ana Souza",
      verifiedBy: "phone",
      lastMessageAt: now - 11 * min,
      lastPreview: "Você tem R$ 340,00 em aberto: uma parcela de R$ 170,00…",
      lastOrigin: "ia",
      lastAiActions: [
        { at: now - 11 * min, label: "Identificou cliente pelo telefone", kind: "info" },
        { at: now - 11 * min, label: "Consultou contas: 2 parcelas em aberto", kind: "info" },
      ],
      aiRepliesCount: 1,
      costUsd: 0.0012,
    }),
    conv({
      id: "5548999995566@s.whatsapp.net",
      displayName: "Rafael Pires",
      lastMessageAt: now - 46 * min,
      lastPreview: "Tenho sim, o Runner preto no 40 está saindo por R$ 289,90…",
      lastOrigin: "ia",
      lastAiActions: [
        { at: now - 47 * min, label: "Buscou “tênis Runner preto 40” → 2 un.", kind: "info" },
        { at: now - 46 * min, label: "Reservou → rascunho #1041", kind: "info" },
      ],
      aiRepliesCount: 2,
      costUsd: 0.0019,
    }),
    conv({
      id: "5548999996677@s.whatsapp.net",
      displayName: "Jéssica Farias",
      state: "humano",
      lastMessageAt: now - 83 * min,
      lastPreview: "Pode vir buscar a partir das 14h!",
      lastOrigin: "humano_celular",
      aiPausedUntil: now + 37 * min,
      humanRepliesCount: 1,
    }),
    conv({
      id: "5548999990001@s.whatsapp.net",
      displayName: "Distribuidora Têxtil",
      state: "ignorado",
      lastMessageAt: now - 26 * 60 * min,
      lastPreview: "Segue o boleto do pedido de outubro",
      lastOrigin: "consumidor",
    }),
  ];

  let seq = 1;
  const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, "conversationId" | "origin" | "createdAt">): ChatMessage => ({
    id: `m${seq++}`,
    waMessageId: null,
    kind: "text",
    text: null,
    transcript: null,
    mediaMime: null,
    hasMedia: false,
    fileName: null,
    durationSec: null,
    status: m.origin === "consumidor" ? "received" : "sent",
    author: null,
    eventType: null,
    ...m,
  });

  const B = conversations[0]!.id;
  const C = conversations[1]!.id;
  const A = conversations[2]!.id;
  const R = conversations[3]!.id;
  const J = conversations[4]!.id;
  const D = conversations[5]!.id;

  const messages: ChatMessage[] = [
    msg({ conversationId: B, origin: "consumidor", createdAt: now - 14 * min, kind: "audio", hasMedia: true, mediaMime: "audio/ogg", durationSec: 8, transcript: "oi, vocês ainda têm aquela bolsa caramelo que tava na vitrine?" }),
    msg({ conversationId: B, origin: "ia", createdAt: now - 13 * min, kind: "image", hasMedia: true, mediaMime: "image/svg+xml", text: "Oi! Tenho sim, a bolsa caramelo está R$ 159,90 e é a última. Quer que eu separe pra você?" }),
    msg({ conversationId: B, origin: "consumidor", createdAt: now - 12.5 * min, text: "quero! mas faz um descontinho?" }),
    msg({ conversationId: B, origin: "ia", createdAt: now - 12 * min, text: "Já separei a bolsa pra você! Sobre o desconto, vou chamar alguém da loja pra te responder, só um instante." }),
    msg({ conversationId: B, origin: "sistema", kind: "event", eventType: "handoff", createdAt: now - 12 * min, text: "IA passou para humano · motivo: pedido de desconto" }),
    msg({ conversationId: B, origin: "sistema", kind: "event", eventType: "takeover", createdAt: now - 3 * min, text: "Murillo assumiu a conversa · IA pausada por 2 h" }),
    msg({ conversationId: B, origin: "humano_app", author: "Murillo", createdAt: now - 2 * min, text: "Oi Bruna, aqui é o Murillo! Consigo fazer R$ 149,90 no Pix, pode ser?" }),
    msg({ conversationId: B, origin: "consumidor", createdAt: now - 1 * min, kind: "sticker", hasMedia: true, mediaMime: "image/webp" }),

    msg({ conversationId: C, origin: "consumidor", createdAt: now - 6 * min, text: "Boa tarde" }),
    msg({ conversationId: C, origin: "consumidor", createdAt: now - 5 * min, text: "Quero trocar a calça que comprei ontem" }),
    msg({ conversationId: C, origin: "ia", createdAt: now - 5 * min, text: "Oi, Carlos! Vou chamar alguém da loja pra te ajudar com a troca, só um instante." }),
    msg({ conversationId: C, origin: "sistema", kind: "event", eventType: "handoff", createdAt: now - 5 * min, text: "IA passou para humano · motivo: troca de produto" }),

    msg({ conversationId: A, origin: "consumidor", createdAt: now - 12 * min, text: "Quanto tô devendo aí?" }),
    msg({ conversationId: A, origin: "sistema", kind: "event", eventType: "identified", createdAt: now - 11.5 * min, text: "Cliente identificada pelo telefone do cadastro" }),
    msg({ conversationId: A, origin: "ia", createdAt: now - 11 * min, text: "Oi, Ana! Você tem R$ 340,00 em aberto: uma parcela de R$ 170,00 que vence dia 10/11 e outra de R$ 170,00 em 10/12. Quer que eu te diga os itens dessa compra?" }),

    msg({ conversationId: R, origin: "consumidor", createdAt: now - 48 * min, text: "Oi, tem o tênis Runner preto no 40?" }),
    msg({ conversationId: R, origin: "ia", createdAt: now - 47 * min, text: "Oi! Tenho sim, o Runner preto no 40 está saindo por R$ 289,90. Quer que eu já separe um pra você?" }),
    msg({ conversationId: R, origin: "consumidor", createdAt: now - 46.5 * min, text: "Quero sim" }),
    msg({ conversationId: R, origin: "sistema", kind: "event", eventType: "reservation_created", createdAt: now - 46 * min, text: "Reserva criada no ERP · rascunho #1041" }),
    msg({ conversationId: R, origin: "ia", createdAt: now - 46 * min, text: "Separado! Fica reservado até amanhã às 18h. É só passar aqui na loja." }),

    msg({ conversationId: J, origin: "consumidor", createdAt: now - 90 * min, text: "Meu pedido já chegou?" }),
    msg({ conversationId: J, origin: "humano_celular", createdAt: now - 83 * min, text: "Pode vir buscar a partir das 14h!" }),
    msg({ conversationId: J, origin: "sistema", kind: "event", eventType: "paused_by_phone", createdAt: now - 83 * min, text: "Resposta pelo celular · IA pausada nesta conversa" }),

    msg({ conversationId: D, origin: "consumidor", createdAt: now - 26 * 60 * min, kind: "document", hasMedia: true, mediaMime: "application/pdf", fileName: "boleto-outubro.pdf", text: "Segue o boleto do pedido de outubro" }),
  ];

  const reservations: Reservation[] = [
    {
      id: "r1",
      conversationId: B,
      customerName: "Bruna Lima",
      phone: "5548999992210",
      productId: "p1",
      variantId: "v1",
      productDescription: "Bolsa caramelo",
      variantLabel: "Único",
      quantity: 1,
      unitPrice: 159.9,
      saleId: "s-1043",
      orderNumber: 1043,
      status: "created",
      customerStatus: "identified",
      expiresAt: now + 20 * 60 * min,
      createdAt: now - 12 * min,
      error: null,
    },
    {
      id: "r2",
      conversationId: R,
      customerName: "Rafael Pires",
      phone: "5548999995566",
      productId: "p2",
      variantId: "v2",
      productDescription: "Tênis Runner",
      variantLabel: "40 PRETO",
      quantity: 1,
      unitPrice: 289.9,
      saleId: "s-1041",
      orderNumber: 1041,
      status: "created",
      customerStatus: "identified",
      expiresAt: now + 19 * 60 * min,
      createdAt: now - 46 * min,
      error: null,
    },
    {
      id: "r3",
      conversationId: "5548999997788@s.whatsapp.net",
      customerName: "Paula Reis",
      phone: "5548999997788",
      productId: "p3",
      variantId: "v3",
      productDescription: "Camiseta básica",
      variantLabel: "M BRANCA",
      quantity: 2,
      unitPrice: 59.9,
      saleId: null,
      orderNumber: null,
      status: "pending_approval",
      customerStatus: "new",
      expiresAt: now + 23 * 60 * min,
      createdAt: now - 8 * min,
      error: null,
    },
    {
      id: "r4",
      conversationId: "5548999998899@s.whatsapp.net",
      customerName: "Marcos Lima",
      phone: "5548999998899",
      productId: "p4",
      variantId: "v4",
      productDescription: "Jaqueta jeans",
      variantLabel: "G",
      quantity: 1,
      unitPrice: 219.9,
      saleId: null,
      orderNumber: null,
      status: "failed",
      customerStatus: "identified",
      expiresAt: now + 10 * 60 * min,
      createdAt: now - 3 * 60 * min,
      error: "API Nive respondeu 403: chave sem permissão de vendas",
    },
  ];

  const audit: AuditEntry[] = [
    { id: 3, at: now - 11 * min, phone: "5548999994455", customerId: "c-ana", action: "consulta_contas", result: "ok · identificada pelo telefone" },
    { id: 2, at: now - 70 * min, phone: "5547988887777", customerId: null, action: "identificacao_bloqueada", result: "bloqueado · 3 tentativas" },
    { id: 1, at: now - 3 * 60 * min, phone: "5548999992210", customerId: "c-bruna", action: "identificacao_telefone", result: "identificado" },
  ];

  const statusParam = params.get("status");
  const okCheck = (message: string) => ({ state: "ok" as const, message, at: now });
  const statusFor = (level: string | null): StatusSnapshot => {
    const base: StatusSnapshot = {
      level: "ok",
      headline: "Conectado e funcionando",
      detail: "WhatsApp ok · API Nive ok · IA ok",
      action: null,
      checks: {
        internet: okCheck("Conectado"),
        evolution: okCheck("Serviço local ativo"),
        whatsapp: okCheck("Número conectado"),
        nive: okCheck("Chave válida"),
        openai: okCheck("Chave válida, com crédito"),
      },
      autoEnabled: settings.attendance.autoEnabled,
      waitingCount: 0,
      needsHumanCount: conversations.filter((c) => c.state === "precisa_humano").length,
      lastCheckAt: Date.now() - 12_000,
      downSince: null,
    };
    if (level === "warn")
      return {
        ...base,
        level: "warn",
        headline: "Funcionando, mas seus créditos da IA estão acabando",
        detail: `Gasto do mês passou do alerta de US$ ${settings.ai.monthlyAlertUsd}`,
        action: { label: "Como adicionar créditos", kind: "open_ai_guide" },
        checks: { ...base.checks, openai: { state: "warn", message: "Crédito baixo", at: now } },
      };
    if (level === "error")
      return {
        ...base,
        level: "error",
        headline: "Atendimento parado: WhatsApp desconectado",
        detail: "Caiu às 14:32 · 3 mensagens aguardando · nada é enviado ao cliente até voltar",
        action: { label: "Reconectar (mostrar QR Code)", kind: "reconnect" },
        checks: { ...base.checks, whatsapp: { state: "error", message: "Desconectado", at: now } },
        waitingCount: 3,
        downSince: now - 40 * min,
      };
    if (setup)
      return {
        ...base,
        level: "error",
        headline: "Atendimento parado: configuração incompleta",
        detail: "Configure as chaves da Nive, da OpenAI e do WhatsApp para começar",
        action: { label: "Abrir configurações", kind: "open_settings_nive" },
        checks: { ...base.checks, whatsapp: { state: "unknown", message: "Não conectado", at: now } },
      };
    return base;
  };
  let status = statusFor(statusParam);

  const ev = {
    status: emitter<StatusSnapshot>(),
    conversation: emitter<Conversation>(),
    message: emitter<ChatMessage>(),
    qr: emitter<QrState>(),
    reservation: emitter<Reservation>(),
    navigate: emitter<NavigateTarget>(),
  };

  const touch = (c: Conversation, m: ChatMessage) => {
    c.lastMessageAt = m.createdAt;
    c.lastPreview = m.text ?? (m.kind === "audio" ? "Áudio" : m.kind === "image" ? "Imagem" : "Arquivo");
    c.lastOrigin = m.origin;
    ev.conversation.emit({ ...c });
  };

  const findConv = (id: string) => {
    const c = conversations.find((x) => x.id === id);
    if (!c) throw new Error("Conversa não encontrada");
    return c;
  };

  const sendHuman = async (conversationId: string, part: Partial<ChatMessage>): Promise<ChatMessage> => {
    const c = findConv(conversationId);
    const m = msg({ conversationId, origin: "humano_app", author: settings.app.operatorName, createdAt: Date.now(), status: "pending", ...part });
    messages.push(m);
    ev.message.emit({ ...m });
    c.state = "humano";
    c.aiPausedUntil = Date.now() + settings.attendance.pauseOnHumanMinutes * min;
    c.humanRepliesCount++;
    touch(c, m);
    await delay(400);
    m.status = "sent";
    ev.message.emit({ ...m });
    return { ...m };
  };

  const usage: UsageSummary = {
    today: { aiReplies: 18, humanReplies: 6, inputTokens: 21400, outputTokens: 3900, transcriptionSeconds: 94, costUsd: 0.021 },
    month: { aiReplies: 412, humanReplies: 133, inputTokens: 498000, outputTokens: 87000, transcriptionSeconds: 2210, costUsd: 0.47 },
    byDay: Array.from({ length: 14 }, (_, i) => {
      const d = new Date(now - (13 - i) * 86_400_000);
      const ai = [12, 20, 31, 18, 9, 0, 27, 33, 25, 22, 30, 14, 26, 18][i] ?? 0;
      return { day: d.toISOString().slice(0, 10), aiReplies: ai, humanReplies: Math.round(ai / 3), costUsd: ai * 0.0011 };
    }),
    monthlyAlertUsd: settings.ai.monthlyAlertUsd,
  };

  const api: NiveAtendeApi = {
    async getSettings() {
      return structuredClone(settings);
    },
    async saveSettings(patch: DeepPartial<AppSettings>) {
      await delay(200);
      settings = deepMerge(settings, patch);
      return structuredClone(settings);
    },
    async setSecret(key) {
      await delay(200);
      if (key === "niveApiKey") settings.nive.hasApiKey = true;
      if (key === "openaiApiKey") settings.openai.hasApiKey = true;
      if (key === "evolutionApiKey") settings.evolution.hasApiKey = true;
      return structuredClone(settings);
    },
    async clearSecret(key) {
      if (key === "niveApiKey") settings.nive.hasApiKey = false;
      if (key === "openaiApiKey") settings.openai.hasApiKey = false;
      if (key === "evolutionApiKey") settings.evolution.hasApiKey = false;
      return structuredClone(settings);
    },
    async acceptTerms() {
      settings.termsAcceptedAt = Date.now();
      return structuredClone(settings);
    },
    async testNive() {
      await delay(600);
      return settings.nive.hasApiKey
        ? { ok: true, message: "Conectado à loja “Loja Exemplo”. Leitura de produtos e clientes ok." }
        : { ok: false, message: "Informe a chave de API da Nive." };
    },
    async testOpenAI() {
      await delay(600);
      return settings.openai.hasApiKey
        ? { ok: true, message: "Chave válida.", models: ["gpt-5-mini", "gpt-5", "gpt-5-nano", "gpt-4.1-mini"] }
        : { ok: false, message: "Informe a chave da OpenAI (começa com sk-)." };
    },
    async testEvolution() {
      await delay(600);
      return { ok: true, message: "Serviço do WhatsApp respondendo em " + settings.evolution.baseUrl };
    },
    async getStatus() {
      return structuredClone(status);
    },
    async refreshStatus() {
      await delay(500);
      status = { ...status, lastCheckAt: Date.now() };
      ev.status.emit(status);
      return structuredClone(status);
    },
    async setAutoEnabled(enabled) {
      settings.attendance.autoEnabled = enabled;
      status = { ...status, autoEnabled: enabled };
      ev.status.emit(status);
      return structuredClone(status);
    },
    async restartEvolution() {
      await delay(800);
      return { ok: true, message: "Serviço reiniciado." };
    },
    async whatsappConnect() {
      const qr: QrState = {
        state: "connecting",
        qrBase64: fakeQr(),
        pairingCode: "K7Q2-9WXP",
        message: "Abra o WhatsApp no celular da loja › Aparelhos conectados › Conectar aparelho",
      };
      setTimeout(() => ev.qr.emit(qr), 50);
      setTimeout(() => {
        const open: QrState = { state: "open", qrBase64: null, pairingCode: null, message: "Conectado" };
        ev.qr.emit(open);
        status = statusFor(null);
        ev.status.emit(status);
      }, 6000);
      return qr;
    },
    async whatsappLogout() {
      return { state: "close", qrBase64: null, pairingCode: null, message: "Desconectado" };
    },
    async listConversations(filter: ConversationFilter, q?: string) {
      const term = (q ?? "").trim().toLowerCase();
      return conversations
        .filter((c) => {
          if (filter === "precisa") return c.state === "precisa_humano";
          if (filter === "ia") return c.state === "ia";
          if (filter === "humano") return c.state === "humano";
          return true;
        })
        .filter((c) => !term || c.displayName.toLowerCase().includes(term) || c.phone.includes(term))
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
        .map((c) => ({ ...c }));
    },
    async getConversation(id) {
      const c = conversations.find((x) => x.id === id);
      return c ? { ...c } : null;
    },
    async getMessages(conversationId) {
      return messages.filter((m) => m.conversationId === conversationId).map((m) => ({ ...m }));
    },
    async getMedia(messageId) {
      await delay(150);
      const m = messages.find((x) => x.id === messageId);
      if (!m) return null;
      if (m.kind === "audio") return silentWavDataUrl(1);
      if (m.kind === "sticker") return STICKER_IMG;
      if (m.kind === "image") return PRODUCT_IMG;
      return null;
    },
    async markRead(conversationId) {
      const c = conversations.find((x) => x.id === conversationId);
      if (c && c.unread) {
        c.unread = 0;
        ev.conversation.emit({ ...c });
      }
    },
    async sendText(conversationId, text) {
      return sendHuman(conversationId, { text });
    },
    async sendMedia(conversationId, media: OutgoingMedia) {
      const kind = media.mime.startsWith("image/") ? "image" : media.mime.startsWith("video/") ? "video" : "document";
      return sendHuman(conversationId, { kind, hasMedia: true, mediaMime: media.mime, fileName: media.fileName, text: media.caption ?? null });
    },
    async sendAudio(conversationId, _b64, mime) {
      return sendHuman(conversationId, { kind: "audio", hasMedia: true, mediaMime: mime });
    },
    async resendSticker(conversationId) {
      return sendHuman(conversationId, { kind: "sticker", hasMedia: true, mediaMime: "image/webp" });
    },
    async deleteMessage(messageId) {
      const m = messages.find((x) => x.id === messageId);
      if (!m) throw new Error("Mensagem não encontrada");
      m.status = "deleted";
      ev.message.emit({ ...m });
      return { ...m };
    },
    async takeOver(conversationId) {
      const c = findConv(conversationId);
      c.state = "humano";
      c.aiPausedUntil = Date.now() + settings.attendance.pauseOnHumanMinutes * min;
      const m = msg({ conversationId, origin: "sistema", kind: "event", eventType: "takeover", createdAt: Date.now(), text: `${settings.app.operatorName} assumiu a conversa · IA pausada por ${Math.round(settings.attendance.pauseOnHumanMinutes / 60)} h` });
      messages.push(m);
      ev.message.emit({ ...m });
      ev.conversation.emit({ ...c });
      return { ...c };
    },
    async returnToAi(conversationId) {
      const c = findConv(conversationId);
      c.state = "ia";
      c.aiPausedUntil = null;
      c.handoffReason = null;
      const m = msg({ conversationId, origin: "sistema", kind: "event", eventType: "returned_to_ai", createdAt: Date.now(), text: "Conversa devolvida para a IA" });
      messages.push(m);
      ev.message.emit({ ...m });
      ev.conversation.emit({ ...c });
      return { ...c };
    },
    async suggestReply(conversationId) {
      await delay(700);
      const c = findConv(conversationId);
      const first = (c.customerName ?? c.displayName).split(" ")[0];
      return `Oi, ${first}! Já estou vendo isso pra você, só um instante.`;
    },
    async listReservations() {
      return reservations.map((r) => ({ ...r })).sort((a, b) => b.createdAt - a.createdAt);
    },
    async approveReservation(id) {
      await delay(500);
      const r = reservations.find((x) => x.id === id);
      if (!r) throw new Error("Reserva não encontrada");
      r.status = "created";
      r.orderNumber = 1044;
      r.saleId = "s-1044";
      ev.reservation.emit({ ...r });
      return { ...r };
    },
    async rejectReservation(id) {
      const r = reservations.find((x) => x.id === id);
      if (!r) throw new Error("Reserva não encontrada");
      r.status = "rejected";
      ev.reservation.emit({ ...r });
      return { ...r };
    },
    async getUsage() {
      return { ...structuredClone(usage), monthlyAlertUsd: settings.ai.monthlyAlertUsd };
    },
    async listAudit(limit = 50) {
      return audit.slice(0, limit);
    },
    async openExternal(url) {
      window.open(url, "_blank", "noopener");
    },
    async openLogs() {
      /* sem registros no modo de demonstração */
    },
    async whatsappPairingCode() {
      return { ok: true, code: "K7PQ-2M9X", message: "Digite este código no celular da loja." };
    },
    async getAppInfo() {
      return { version: "0.1.0 (simulação)", platform: "browser" };
    },
    onStatus: (cb) => ev.status.on(cb),
    onConversation: (cb) => ev.conversation.on(cb),
    onMessage: (cb) => ev.message.on(cb),
    onQr: (cb) => ev.qr.on(cb),
    onReservation: (cb) => ev.reservation.on(cb),
    onNavigate: (cb) => ev.navigate.on(cb),
  };
  return api;
}
