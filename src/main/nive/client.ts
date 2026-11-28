// Cliente da API pública da Nive (api.nivesistemas.com.br).
// Autenticação: Authorization: Bearer <chave> + X-Store-Slug. Endpoints conferidos no código do ERP.
import { callerNational, digitsOnly, samePhone } from "../engine/phone";

export class NiveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface NiveCustomer {
  id: string;
  name: string;
  nickname: string | null;
  taxId: string | null;
  phone: string | null;
  birthDate: string | null;
}

export interface NiveVariant {
  id: string;
  label: string;
  stockQty: number;
}

export interface NiveProduct {
  id: string;
  description: string;
  priceCash: number;
  priceCredit: number;
  active: boolean;
  tracksStock: boolean;
  imageUrl: string | null;
  variants: NiveVariant[];
  brand?: string | null;
  category?: string | null;
}

export interface NiveStatementItem {
  description: string;
  variantLabel: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface NiveStatementOrder {
  orderNumber: number | null;
  description: string | null;
  balance: number;
  originalAmount: number;
  dueDate: string | null;
  items: NiveStatementItem[];
}

export interface NiveInstallment {
  sequence: number;
  amount: number;
  balance: number;
  dueDate: string | null;
  status: string;
}

export interface NiveStatement {
  customerId: string;
  customerName: string;
  openBalance: number;
  overdueBalance: number;
  orders: NiveStatementOrder[];
  /** Parcelas em aberto de todas as contas. */
  installments: Array<NiveInstallment & { orderNumber: number | null }>;
}

export interface NiveDraftSale {
  id: string;
  orderNumber: number | null;
}

/** Promoção valendo agora no ERP (campanha, por quantidade, brinde ou atacarejo). */
export interface NivePromotion {
  id: string;
  kind: "campaign" | "quantity" | "gift" | "wholesale";
  name: string;
  /** Regra em português ("Leve 3, pague 2", "Atacado: R$ 3,99 a partir de 12"). */
  description: string;
  endsAt: string | null;
  productCount: number;
  products: Array<{ id: string; description: string; priceCash: number; promoPrice: number | null }>;
}

/** Interface usada pelo motor (permite trocar por um falso nos testes). */
export interface NiveApi {
  testConnection(): Promise<void>;
  findCustomersByPhone(phone: string): Promise<NiveCustomer[]>;
  findCustomerByCpf(cpf: string): Promise<NiveCustomer | null>;
  getStatement(customerId: string): Promise<NiveStatement>;
  searchProducts(term: string, limit?: number): Promise<NiveProduct[]>;
  getProduct(productId: string): Promise<NiveProduct | null>;
  /** Uma página do catálogo de mercadorias ativas (para o resumo do que a loja vende). */
  listProducts?(page: number, take: number): Promise<{ items: NiveProduct[]; total: number | null }>;
  createDraftSale(input: { customerId: string | null; variantId: string; quantity: number; notes: string }): Promise<NiveDraftSale>;
  /** Promoções valendo agora; null quando o ERP ainda não tem a consulta. */
  listActivePromotions?(term?: string): Promise<NivePromotion[] | null>;
  /** Formas de pagamento ativas nas vendas; null quando o ERP não tem a consulta ou a chave não tem acesso. */
  listPaymentMethods?(): Promise<NivePaymentMethod[] | null>;
  /** Clientes cujo nome é exatamente o informado (sem diferenciar acentos/maiúsculas). */
  findCustomersByName(name: string): Promise<NiveCustomer[]>;
  /** Clientes cujo nome contém todas as palavras informadas (ex.: "Aliny" → "Aliny Rocker Beltrame"). */
  findSimilarCustomers(name: string): Promise<NiveCustomer[]>;
  createCustomer(input: { name: string; phone: string | null }): Promise<NiveCustomer>;
  /** Situação atual da venda no ERP. */
  getSaleState(saleId: string): Promise<{ state: "draft" | "completed" | "cancelled" | "not_found"; orderNumber: number | null }>;
  /** Cancela um rascunho (mantém o histórico no ERP). Não mexe em venda já finalizada. */
  cancelDraftSale(saleId: string, reason: string): Promise<"cancelled" | "not_draft" | "not_found">;
  /**
   * Quanto o relógio do computador está adiantado (positivo) ou atrasado (negativo) em relação ao
   * horário certo, medido pelo cabeçalho Date das respostas da API. null enquanto não houve resposta.
   */
  clockOffsetMs?(): number | null;
  /** Abre/atualiza aviso "aguardando ação" no ERP; false quando o ERP ainda não tem os avisos. */
  upsertActionAlert?(input: ActionAlertInput): Promise<boolean>;
  resolveActionAlert?(source: string, externalRef: string): Promise<void>;
  /** Situação dos avisos no ERP; null quando o ERP ainda não tem os avisos. */
  getActionAlerts?(source: string, refs: string[]): Promise<ActionAlertState[] | null>;
}

export interface ActionAlertInput {
  source: string;
  externalRef: string;
  kind: "handoff" | "reservation" | "other";
  title: string;
  message: string;
  linkUrl?: string | null;
  saleId?: string | null;
}

export interface ActionAlertState {
  externalRef: string;
  status: string;
  shownAt: string | null;
  acknowledgedAt: string | null;
}

/** Normaliza nome para comparar: sem acentos, minúsculo, espaços simples. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Json = Record<string, unknown>;

const n = (v: unknown): number => (v == null || v === "" ? 0 : Number(v)) || 0;
const s = (v: unknown): string | null => (v == null ? null : String(v));

function toCustomer(raw: Json): NiveCustomer {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ""),
    nickname: s(raw.nickname),
    taxId: s(raw.taxId ?? raw.cpf),
    phone: s(raw.phone),
    birthDate: s(raw.birthDate),
  };
}

function nameOf(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  const o = v as Json;
  return o.name ? String(o.name) : o.description ? String(o.description) : null;
}

function toProduct(raw: Json, baseUrl: string): NiveProduct {
  const variants = Array.isArray(raw.variants) ? (raw.variants as Json[]) : [];
  let image = s(raw.imageUrl) ?? s(raw.thumbnailUrl);
  if (image && image.startsWith("/")) image = baseUrl + image;
  return {
    id: String(raw.id),
    description: String(raw.description ?? ""),
    priceCash: n(raw.priceCash),
    priceCredit: n(raw.priceCredit),
    active: raw.active !== false,
    tracksStock: raw.tracksStock !== false,
    imageUrl: image,
    variants: variants.map((v) => ({ id: String(v.id), label: String(v.label ?? "Único"), stockQty: n(v.stockQty) })),
    brand: nameOf(raw.brand) ?? s(raw.brandName),
    category: nameOf(raw.category) ?? s(raw.categoryName),
  };
}

export class NiveClient implements NiveApi {
  private offsetMs: number | null = null;

  constructor(
    private readonly cfg: () => { baseUrl: string; storeSlug: string; apiKey: string | null },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly localNow: () => number = Date.now,
  ) {}

  clockOffsetMs(): number | null {
    return this.offsetMs;
  }

  /** Mede a diferença do relógio do computador pelo cabeçalho Date (precisão de 1 s). */
  private measureClock(res: Response, sentAt: number): void {
    const header = res.headers?.get?.("date");
    const server = header ? Date.parse(header) : NaN;
    if (!Number.isFinite(server)) return;
    const receivedAt = this.localNow();
    if (receivedAt - sentAt > 5000) return; // resposta lenta: medida imprecisa
    // o Date vem truncado no segundo: soma meio segundo; usa o meio do caminho da requisição
    this.offsetMs = Math.round((sentAt + receivedAt) / 2 - (server + 500));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { baseUrl, storeSlug, apiKey } = this.cfg();
    if (!apiKey) throw new NiveApiError("Chave da API Nive não configurada", 401);
    if (!storeSlug) throw new NiveApiError("Slug da loja não configurado", 400);
    const sentAt = this.localNow();
    const res = await this.fetchImpl(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Store-Slug": storeSlug,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    this.measureClock(res, sentAt);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const obj = data && typeof data === "object" ? (data as Json) : {};
      const msg = String(obj.error ?? obj.message ?? `HTTP ${res.status}`);
      throw new NiveApiError(msg, res.status);
    }
    return data as T;
  }

  async testConnection(): Promise<void> {
    await this.request("GET", "/products?take=1&active=true");
  }

  async findCustomersByPhone(phone: string): Promise<NiveCustomer[]> {
    // A busca por dígitos do ERP é por "contém"; buscamos pelos 8 últimos dígitos e conferimos aqui.
    // só números brasileiros (+55) podem bater com um cadastro
    const national = callerNational(phone);
    if (!national) return [];
    const last8 = national.slice(-8);
    const raw = await this.request<unknown>("GET", `/customers?q=${encodeURIComponent(last8)}`);
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as Json)?.items) ? ((raw as Json).items as unknown[]) : [];
    return (list as Json[]).map(toCustomer).filter((c) => samePhone(c.phone, phone));
  }

  async findCustomerByCpf(cpf: string): Promise<NiveCustomer | null> {
    const d = digitsOnly(cpf);
    if (d.length !== 11) return null;
    let raw: Json;
    try {
      raw = await this.request<Json>("GET", `/customers/tax-id-lookup/${d}`);
    } catch (e) {
      // 400 (dígito verificador) e 404 = não encontrado; outros erros sobem
      if (e instanceof NiveApiError && (e.status === 400 || e.status === 404)) return null;
      throw e;
    }
    const existing = raw?.existingCustomer as Json | null | undefined;
    if (!existing) return null;
    const c = toCustomer(existing);
    // defesa extra: o documento devolvido precisa ser o mesmo
    if (c.taxId && digitsOnly(c.taxId) !== d) return null;
    if (!c.birthDate || !c.phone) {
      // a consulta por documento pode não trazer todos os campos; busca o detalhe
      try {
        const full = toCustomer(await this.request<Json>("GET", `/customers/${encodeURIComponent(c.id)}`));
        return full;
      } catch {
        return c;
      }
    }
    return c;
  }

  async getStatement(customerId: string): Promise<NiveStatement> {
    const raw = await this.request<Json>(
      "GET",
      `/receivables/customers/${encodeURIComponent(customerId)}/statement`,
    );
    const customer = (raw.customer ?? {}) as Json;
    const summary = (raw.summary ?? {}) as Json;
    const details = (raw.details ?? {}) as Json;
    const orders = (Array.isArray(details.orders) ? details.orders : []) as Json[];
    const receivables = (Array.isArray(raw.receivables) ? raw.receivables : []) as Json[];

    const installments: NiveStatement["installments"] = [];
    for (const r of receivables) {
      const status = String(r.status ?? "");
      if (status !== "OPEN" && status !== "PARTIAL") continue;
      const sale = (r.sale ?? null) as Json | null;
      const orderNumber = sale?.orderNumber == null ? null : n(sale.orderNumber);
      const inst = (Array.isArray(r.installments) ? r.installments : []) as Json[];
      if (inst.length === 0) {
        if (n(r.balance) > 0.009)
          installments.push({ sequence: 1, amount: n(r.originalAmount), balance: n(r.balance), dueDate: s(r.dueDate), status, orderNumber });
        continue;
      }
      for (const i of inst) {
        if (n(i.balance) <= 0.009) continue;
        installments.push({
          sequence: n(i.sequence),
          amount: n(i.amount),
          balance: n(i.balance),
          dueDate: s(i.dueDate),
          status: String(i.status ?? ""),
          orderNumber,
        });
      }
    }
    installments.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));

    return {
      customerId: String(customer.id ?? ""),
      customerName: String(customer.name ?? ""),
      openBalance: n(summary.openBalance),
      overdueBalance: n(summary.overdueBalance),
      orders: orders
        .filter((o) => n(o.balance) > 0.009)
        .map((o) => ({
          orderNumber: o.orderNumber == null ? null : n(o.orderNumber),
          description: s(o.description),
          balance: n(o.balance),
          originalAmount: n(o.originalAmount),
          dueDate: s(o.dueDate),
          items: ((Array.isArray(o.items) ? o.items : []) as Json[]).map((it) => ({
            description: String(it.description ?? ""),
            variantLabel: String(it.variantLabel ?? ""),
            quantity: n(it.quantity),
            unitPrice: n(it.unitPrice),
            lineTotal: n(it.lineTotal),
          })),
        })),
      installments,
    };
  }

  async searchProducts(term: string, limit = 5): Promise<NiveProduct[]> {
    const q = term.trim();
    if (!q) return [];
    const raw = await this.request<Json>(
      "GET",
      `/products?q=${encodeURIComponent(q)}&active=true&productType=MERCHANDISE&take=${Math.min(20, limit)}`,
    );
    const items = (Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw : []) as Json[];
    const base = this.cfg().baseUrl;
    return items.map((p) => toProduct(p, base)).filter((p) => p.active).slice(0, limit);
  }

  async listProducts(page: number, take: number): Promise<{ items: NiveProduct[]; total: number | null }> {
    const raw = await this.request<Json>(
      "GET",
      `/products?active=true&productType=MERCHANDISE&page=${Math.max(1, page)}&take=${Math.min(100, Math.max(1, take))}`,
    );
    const items = (Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw : []) as Json[];
    const total = typeof raw.total === "number" ? raw.total : null;
    const base = this.cfg().baseUrl;
    return { items: items.map((p) => toProduct(p, base)), total };
  }

  async getProduct(productId: string): Promise<NiveProduct | null> {
    try {
      const raw = await this.request<Json>("GET", `/products/${encodeURIComponent(productId)}`);
      return toProduct(raw, this.cfg().baseUrl);
    } catch (e) {
      if (e instanceof NiveApiError && e.status === 404) return null;
      throw e;
    }
  }

  async listActivePromotions(term = ""): Promise<NivePromotion[] | null> {
    const q = term.trim().slice(0, 120);
    let raw: Json;
    try {
      raw = await this.request<Json>("GET", `/products/promotions/active${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    } catch (e) {
      // ERP antigo (rota não existe) ou chave sem acesso a produtos
      if (e instanceof NiveApiError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
    const items = (Array.isArray(raw.items) ? raw.items : []) as Json[];
    const kinds = ["campaign", "quantity", "gift", "wholesale"] as const;
    return items.map((p) => ({
      id: String(p.id ?? ""),
      kind: (kinds as readonly string[]).includes(String(p.kind)) ? (p.kind as NivePromotion["kind"]) : "campaign",
      name: String(p.name ?? ""),
      description: String(p.description ?? ""),
      endsAt: s(p.endsAt),
      productCount: n(p.productCount),
      products: ((Array.isArray(p.products) ? p.products : []) as Json[]).map((x) => ({
        id: String(x.id ?? ""),
        description: String(x.description ?? ""),
        priceCash: n(x.priceCash),
        promoPrice: x.promoPrice == null ? null : n(x.promoPrice),
      })),
    }));
  }

  /** Formas de pagamento ativas nas vendas. null = ERP sem a rota ou chave sem acesso. */
  async listPaymentMethods(): Promise<NivePaymentMethod[] | null> {
    let raw: unknown = null;
    // /sales/payment-methods vale com a permissão de vendas da chave; a rota completa precisa de permissão de configuração
    for (const path of ["/sales/payment-methods", "/payment-methods?active=true"]) {
      try {
        raw = await this.request<unknown>("GET", path);
        break;
      } catch (e) {
        if (e instanceof NiveApiError && [400, 403, 404].includes(e.status)) continue;
        throw e;
      }
    }
    if (raw === null) return null;
    const items = (Array.isArray(raw) ? raw : Array.isArray((raw as Json)?.items) ? ((raw as Json).items as unknown[]) : []) as Json[];
    return items
      .filter((m) => m.active !== false && m.availableInSales !== false && String(m.name ?? "").trim())
      .map((m) => {
        const name = String(m.name).trim();
        return { id: String(m.id ?? ""), name, storeCredit: isStoreCredit(name, s(m.fiscalCode)) };
      });
  }

  async findCustomersByName(name: string): Promise<NiveCustomer[]> {
    const target = normalizeName(name);
    if (target.length < 3) return [];
    const raw = await this.request<unknown>("GET", `/customers?q=${encodeURIComponent(name.trim())}`);
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as Json)?.items) ? ((raw as Json).items as unknown[]) : [];
    return (list as Json[]).map(toCustomer).filter((c) => normalizeName(c.name) === target);
  }

  async findSimilarCustomers(name: string): Promise<NiveCustomer[]> {
    const words = normalizeName(name).split(" ").filter((w) => w.length >= 2);
    if (!words.length || words.join("").length < 3) return [];
    const raw = await this.request<unknown>("GET", `/customers?q=${encodeURIComponent(name.trim())}`);
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as Json)?.items) ? ((raw as Json).items as unknown[]) : [];
    return (list as Json[])
      .map(toCustomer)
      .filter((c) => {
        const parts = normalizeName(c.name).split(" ");
        return words.every((w) => parts.some((p) => p.startsWith(w)));
      })
      .slice(0, 8);
  }

  async createCustomer(input: { name: string; phone: string | null }): Promise<NiveCustomer> {
    const raw = await this.request<Json>("POST", "/customers", {
      name: input.name.trim().slice(0, 200),
      ...(input.phone ? { phone: input.phone } : {}),
      notes: "Cadastrado pelo Nive Atende (reserva pelo WhatsApp)",
    });
    return toCustomer(raw);
  }

  async getSaleState(saleId: string): Promise<{ state: "draft" | "completed" | "cancelled" | "not_found"; orderNumber: number | null }> {
    let sale: Json;
    try {
      sale = await this.request<Json>("GET", `/sales/${encodeURIComponent(saleId)}`);
    } catch (e) {
      if (e instanceof NiveApiError && e.status === 404) return { state: "not_found", orderNumber: null };
      throw e;
    }
    const status = String(sale.status ?? "");
    const orderNumber = sale.orderNumber == null ? null : n(sale.orderNumber);
    if (status === "DRAFT") return { state: "draft", orderNumber };
    if (status === "DRAFT_CANCELLED" || status === "CANCELLED") return { state: "cancelled", orderNumber };
    return { state: "completed", orderNumber };
  }

  async cancelDraftSale(saleId: string, reason: string): Promise<"cancelled" | "not_draft" | "not_found"> {
    const { state } = await this.getSaleState(saleId);
    if (state === "not_found") return "not_found";
    if (state === "cancelled") return "cancelled";
    if (state !== "draft") return "not_draft";
    await this.request("POST", `/sales/${encodeURIComponent(saleId)}/cancel-draft`, { reason: reason.slice(0, 500) });
    return "cancelled";
  }

  async upsertActionAlert(input: ActionAlertInput): Promise<boolean> {
    try {
      await this.request("POST", "/integrations/action-alerts", input);
      return true;
    } catch (e) {
      if (e instanceof NiveApiError && e.status === 404) return false;
      throw e;
    }
  }

  async resolveActionAlert(source: string, externalRef: string): Promise<void> {
    try {
      await this.request("POST", "/integrations/action-alerts/resolve", { source, externalRef });
    } catch (e) {
      if (e instanceof NiveApiError && e.status === 404) return;
      throw e;
    }
  }

  async getActionAlerts(source: string, refs: string[]): Promise<ActionAlertState[] | null> {
    try {
      const out = await this.request<{ items?: Json[] }>(
        "GET",
        `/integrations/action-alerts?source=${encodeURIComponent(source)}&refs=${encodeURIComponent(refs.slice(0, 100).join(","))}`,
      );
      return (out.items ?? []).map((i) => ({
        externalRef: String(i.externalRef ?? ""),
        status: String(i.status ?? ""),
        shownAt: s(i.shownAt),
        acknowledgedAt: s(i.acknowledgedAt),
      }));
    } catch (e) {
      if (e instanceof NiveApiError && e.status === 404) return null;
      throw e;
    }
  }

  async createDraftSale(input: {
    customerId: string | null;
    variantId: string;
    quantity: number;
    notes: string;
  }): Promise<NiveDraftSale> {
    const sale = await this.request<Json>("POST", "/sales", input.customerId ? { customerId: input.customerId } : {});
    const id = String(sale.id);
    await this.request("POST", `/sales/${encodeURIComponent(id)}/items`, {
      variantId: input.variantId,
      quantity: input.quantity,
    });
    try {
      await this.request("PATCH", `/sales/${encodeURIComponent(id)}`, { notes: input.notes });
    } catch {
      // observação é opcional; o rascunho já existe
    }
    return { id, orderNumber: sale.orderNumber == null ? null : n(sale.orderNumber) };
  }
}

export interface NivePaymentMethod {
  id: string;
  name: string;
  /** Crediário / crédito da loja: a decisão é sempre da equipe. */
  storeCredit: boolean;
}

/** Crediário da loja: código fiscal 05 (crédito loja) ou nome que indique venda na conta da loja. */
export function isStoreCredit(name: string, fiscalCode: string | null): boolean {
  if (fiscalCode === "05") return true;
  return /credi[aá]rio|fiado|carn[eê]|cr[eé]dito\s+(na|da)?\s*loja|caderneta|nota\s+promiss|conta\s+(do|de)\s+cliente/i.test(name);
}
