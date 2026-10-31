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

/** Interface usada pelo motor (permite trocar por um falso nos testes). */
export interface NiveApi {
  testConnection(): Promise<void>;
  findCustomersByPhone(phone: string): Promise<NiveCustomer[]>;
  findCustomerByCpf(cpf: string): Promise<NiveCustomer | null>;
  getStatement(customerId: string): Promise<NiveStatement>;
  searchProducts(term: string, limit?: number): Promise<NiveProduct[]>;
  getProduct(productId: string): Promise<NiveProduct | null>;
  createDraftSale(input: { customerId: string | null; variantId: string; quantity: number; notes: string }): Promise<NiveDraftSale>;
  /** Clientes cujo nome é exatamente o informado (sem diferenciar acentos/maiúsculas). */
  findCustomersByName(name: string): Promise<NiveCustomer[]>;
  createCustomer(input: { name: string; phone: string | null }): Promise<NiveCustomer>;
  /** Situação atual da venda no ERP. */
  getSaleState(saleId: string): Promise<{ state: "draft" | "completed" | "cancelled" | "not_found"; orderNumber: number | null }>;
  /** Cancela um rascunho (mantém o histórico no ERP). Não mexe em venda já finalizada. */
  cancelDraftSale(saleId: string, reason: string): Promise<"cancelled" | "not_draft" | "not_found">;
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
  constructor(
    private readonly cfg: () => { baseUrl: string; storeSlug: string; apiKey: string | null },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { baseUrl, storeSlug, apiKey } = this.cfg();
    if (!apiKey) throw new NiveApiError("Chave da API Nive não configurada", 401);
    if (!storeSlug) throw new NiveApiError("Slug da loja não configurado", 400);
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

  async getProduct(productId: string): Promise<NiveProduct | null> {
    try {
      const raw = await this.request<Json>("GET", `/products/${encodeURIComponent(productId)}`);
      return toProduct(raw, this.cfg().baseUrl);
    } catch (e) {
      if (e instanceof NiveApiError && e.status === 404) return null;
      throw e;
    }
  }

  async findCustomersByName(name: string): Promise<NiveCustomer[]> {
    const target = normalizeName(name);
    if (target.length < 3) return [];
    const raw = await this.request<unknown>("GET", `/customers?q=${encodeURIComponent(name.trim())}`);
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as Json)?.items) ? ((raw as Json).items as unknown[]) : [];
    return (list as Json[]).map(toCustomer).filter((c) => normalizeName(c.name) === target);
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
