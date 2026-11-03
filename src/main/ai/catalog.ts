// Resumo do que a loja vende de verdade (só produtos com estoque), para a IA nunca oferecer uma categoria
// que a loja não tem. Lido da API Nive, guardado no banco local e atualizado de tempos em tempos.
import type { NiveApi, NiveProduct } from "../nive/client";
import type { Store } from "../store/db";
import { prettyName } from "./format";
import { saveCatalogIndex } from "./nicknames";

const KEY = "catalogSummary";
/** Depois disso, o resumo é atualizado em segundo plano. */
const STALE_MS = 3 * 3_600_000;
/** Sem resumo nenhum ainda: espera no máximo isso antes de responder sem ele. */
const FIRST_WAIT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface Cached {
  at: number;
  text: string;
}

function inStock(p: NiveProduct): boolean {
  if (!p.tracksStock) return true;
  return p.variants.some((v) => v.stockQty > 0);
}

const SMALL = new Set(["de", "da", "do", "das", "dos", "e", "com", "para", "em", "kit"]);

/** Tipo do produto: a categoria do cadastro ou, sem ela, o começo do nome ("Perfume Árabe X" → "Perfume"). */
export function productKind(p: NiveProduct): string {
  const cat = p.category?.trim();
  if (cat) return cat;
  const words = p.description.trim().split(/\s+/).filter(Boolean);
  const first = words.find((w) => !SMALL.has(w.toLowerCase()) && /[a-zà-ú]/i.test(w)) ?? "Outros";
  const w = first.replace(/[^\p{L}-]/gu, "") || "Outros";
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** Monta o texto do resumo. Exportado para os testes. */
export function summarizeCatalog(products: NiveProduct[], partial = false): string {
  const available = products.filter((p) => p.active && inStock(p));
  if (!available.length) return "Nenhum produto com estoque no momento.";
  const kinds = new Map<string, number>();
  const brands = new Map<string, number>();
  for (const p of available) {
    const k = productKind(p);
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
    const b = p.brand?.trim();
    if (b) brands.set(b, (brands.get(b) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  const kindList = top(kinds, 15).map(([k, c]) => `${k} (${c})`).join(", ");
  const brandList = top(brands, 10).map(([b]) => b).join(", ");
  const prices = available.map((p) => p.priceCash).filter((v) => v > 0).sort((a, b) => a - b);
  const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const lines = [`Tipos de produto com estoque (quantidade de produtos): ${kindList}${kinds.size > 15 ? ", entre outros com poucos itens" : ""}.`];
  if (brandList) lines.push(`Marcas com mais opções: ${brandList}.`);
  if (prices.length) lines.push(`Preços de ${brl(prices[0]!)} a ${brl(prices[prices.length - 1]!)}.`);
  if (partial) lines.push("(Resumo feito com parte do catálogo: se o cliente pedir algo diferente, busque antes de dizer que não tem.)");
  return lines.join("\n");
}

export class CatalogSummary {
  private running: Promise<string | null> | null = null;

  constructor(
    private readonly store: Store,
    private readonly nive: NiveApi,
    private readonly now: () => number = Date.now,
  ) {}

  private cached(): Cached | null {
    return this.store.getKv<Cached>(KEY);
  }

  /** Lê o catálogo na API Nive e guarda o resumo. Nunca lança erro: sem resumo, a IA só busca mais. */
  refresh(): Promise<string | null> {
    if (this.running) return this.running;
    const list = this.nive.listProducts?.bind(this.nive);
    if (!list) return Promise.resolve(this.cached()?.text ?? null);
    this.running = (async () => {
      try {
        const all: NiveProduct[] = [];
        let partial = false;
        for (let page = 1; page <= MAX_PAGES; page++) {
          const { items, total } = await list(page, PAGE_SIZE);
          all.push(...items);
          if (items.length < PAGE_SIZE || (total != null && all.length >= total)) break;
          if (page === MAX_PAGES) partial = true;
        }
        const text = summarizeCatalog(all, partial);
        this.store.setKv(KEY, { at: this.now(), text } satisfies Cached);
        // nomes de tudo que tem estoque: a IA reconhece apelidos e nomes escritos errado por aqui
        saveCatalogIndex(
          this.store,
          all
            .filter((p) => p.active && inStock(p))
            .map((p) => ({ id: p.id, nome: prettyName(p.description), marca: p.brand?.trim() || null, tipo: productKind(p) })),
          this.now(),
        );
        return text;
      } catch (e) {
        console.warn("[catálogo] não foi possível montar o resumo:", (e as Error).message);
        return this.cached()?.text ?? null;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Resumo para a IA. Desatualizado: devolve o atual e atualiza em segundo plano. Sem nenhum: espera um pouco. */
  async get(): Promise<string | null> {
    const c = this.cached();
    if (c) {
      if (this.now() - c.at > STALE_MS) void this.refresh();
      return c.text;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), FIRST_WAIT_MS)));
    try {
      return await Promise.race([this.refresh(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
