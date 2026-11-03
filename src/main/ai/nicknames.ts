// Apelidos de produtos: como os clientes chamam os produtos de verdade ("o da abelhinha" → Atheeri).
// O lojista cadastra nas configurações e a IA aprende sozinha quando o cliente confirma qual era.
// Também guarda um índice leve do catálogo (nomes com estoque) para a IA reconhecer pelo nome.
import type { ProductNickname } from "../../shared/types";
import type { Store } from "../store/db";

const KEY = "productNicknames";
const MAX = 400;

/** Palavras que não identificam um produto ("o da", "perfume", "aquele"…). */
const FILLER = new Set([
  "a", "o", "as", "os", "um", "uma", "de", "da", "do", "das", "dos", "e", "com", "sem", "pra", "para", "no", "na", "em",
  "que", "aquele", "aquela", "esse", "essa", "este", "esta", "tem", "voces", "vcs", "quero", "queria", "famoso", "famosa",
]);

/** Sem acento, minúsculo, só letras/números e espaços simples. */
export function norm(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Palavras que contam para reconhecer o produto. */
export function coreWords(text: string, extraFiller: Iterable<string> = []): string[] {
  const skip = new Set([...FILLER, ...[...extraFiller].map(norm)]);
  return norm(text)
    .split(" ")
    .filter((w) => w.length >= 2 && !skip.has(w));
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Duas palavras "são a mesma": iguais, diminutivo/variação ("abelha" ~ "abelhinha", "azul" ~ "azulzinho")
 * ou erro de digitação ("atheri" ~ "atheeri").
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const short = Math.min(a.length, b.length);
  if (short < 4) return false;
  const p = commonPrefix(a, b);
  if (p >= 4 && p >= Math.ceil(short * 0.8)) return true;
  if (short >= 5) {
    // compara pelo som: "aterri" e "atheeri" viram "ateri"
    const pa = phonetic(a);
    const pb = phonetic(b);
    if (pa === pb) return true;
    return editDistance(pa, pb) <= (short >= 8 ? 2 : 1);
  }
  return false;
}

/** Como a palavra soa (do jeito que o cliente escreve de ouvido): th→t, ph→f, y→i, k→c, letras dobradas… */
export function phonetic(w: string): string {
  return w
    .replace(/ph/g, "f")
    .replace(/(sh|ch)/g, "x")
    .replace(/h/g, "")
    .replace(/y/g, "i")
    .replace(/w/g, "v")
    .replace(/[kq]/g, "c")
    .replace(/z/g, "s")
    .replace(/(.)\1+/g, "$1");
}

/** Todas as palavras de `needle` aparecem (parecidas) em `hay`. */
export function wordsMatch(needle: string[], hay: string[]): boolean {
  return needle.length > 0 && needle.every((n) => hay.some((h) => sameWord(n, h)));
}

export function listNicknames(store: Store): ProductNickname[] {
  return store.getKv<ProductNickname[]>(KEY) ?? [];
}

function save(store: Store, list: ProductNickname[]): ProductNickname[] {
  const kept = list.slice(-MAX);
  store.setKv(KEY, kept);
  return kept;
}

export function cleanNickname(raw: string): string | null {
  const s = raw.replace(/[\u0000-\u001f<>[\]{}*_`#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (coreWords(s).join("").length < 3) return null;
  if (/\d[\d\s.()-]{5,}\d/.test(s)) return null; // nada de telefone/CPF
  return s;
}

/**
 * Adiciona ou atualiza um apelido. O que o lojista cadastrou não é trocado pelo que a IA aprendeu.
 * Devolve null quando não dá para guardar.
 */
export function addNickname(
  store: Store,
  input: { apelido: string; termo: string; origem: ProductNickname["origem"]; produtoId?: string | null },
  now: number,
): ProductNickname | null {
  const apelido = cleanNickname(input.apelido);
  const termo = input.termo.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!apelido || termo.length < 2) return null;
  const key = coreWords(apelido).join(" ");
  const list = listNicknames(store);
  const existing = list.find((n) => coreWords(n.apelido).join(" ") === key);
  if (existing && existing.origem === "loja" && input.origem === "ia") return existing;
  const entry: ProductNickname = { apelido, termo, origem: input.origem, produtoId: input.produtoId ?? null, criadoEm: now };
  save(store, [...list.filter((n) => n !== existing), entry]);
  return entry;
}

export function removeNickname(store: Store, apelido: string): ProductNickname[] {
  const key = coreWords(apelido).join(" ");
  return save(store, listNicknames(store).filter((n) => coreWords(n.apelido).join(" ") !== key));
}

/** Apelidos que aparecem no que o cliente/IA escreveu ("perfume da abelhinha" → "abelhinha"). */
export function matchNicknames(list: ProductNickname[], text: string): ProductNickname[] {
  const words = coreWords(text);
  if (!words.length) return [];
  return list.filter((n) => wordsMatch(coreWords(n.apelido), words));
}

// ------------------------------------------------------------------ índice do catálogo

export interface CatalogEntry {
  id: string;
  nome: string;
  marca: string | null;
  tipo: string;
}

const INDEX_KEY = "catalogIndex";

export function saveCatalogIndex(store: Store, items: CatalogEntry[], now: number): void {
  store.setKv(INDEX_KEY, { at: now, items });
}

export function catalogIndex(store: Store): CatalogEntry[] {
  return store.getKv<{ at: number; items: CatalogEntry[] }>(INDEX_KEY)?.items ?? [];
}

/**
 * Busca local, tolerante a acento, ordem das palavras e erro de digitação
 * (o ERP busca por "contém" e não acha "atheri" nem "aterri").
 */
export function fuzzySearch(items: CatalogEntry[], term: string, limit = 8): CatalogEntry[] {
  const words = coreWords(term);
  if (!words.length) return [];
  const scored: Array<{ e: CatalogEntry; score: number }> = [];
  for (const e of items) {
    const hay = coreWords(`${e.nome} ${e.marca ?? ""}`);
    const hits = words.filter((w) => hay.some((h) => sameWord(w, h))).length;
    if (!hits) continue;
    // precisa bater todas as palavras, ou a maioria quando o termo é longo
    if (hits < words.length && (words.length < 3 || hits < words.length - 1)) continue;
    scored.push({ e, score: hits });
  }
  return scored.sort((a, b) => b.score - a.score || a.e.nome.localeCompare(b.e.nome)).slice(0, limit).map((x) => x.e);
}

/** Itens do índice de um tipo/marca (para a IA ler os nomes e reconhecer o produto). */
export function filterCatalog(items: CatalogEntry[], tipo: string, marca: string): CatalogEntry[] {
  const t = coreWords(tipo);
  const m = coreWords(marca);
  return items.filter((e) => {
    if (t.length && !wordsMatch(t, coreWords(`${e.tipo} ${e.nome}`))) return false;
    if (m.length && !wordsMatch(m, coreWords(`${e.marca ?? ""} ${e.nome}`))) return false;
    return true;
  });
}
