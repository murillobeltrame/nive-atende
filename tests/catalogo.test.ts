import { describe, expect, it } from "vitest";
import { CatalogSummary, productKind, summarizeCatalog } from "../src/main/ai/catalog";
import { buildSystemPrompt } from "../src/main/ai/prompt";
import type { NiveApi, NiveProduct } from "../src/main/nive/client";
import { DEFAULT_SETTINGS } from "../src/main/settings";
import { Store } from "../src/main/store/db";

function prod(id: string, description: string, stock: number, extra: Partial<NiveProduct> = {}): NiveProduct {
  return {
    id,
    description,
    priceCash: 100,
    priceCredit: 110,
    active: true,
    tracksStock: true,
    imageUrl: null,
    variants: [{ id: `${id}-v`, label: "Único", stockQty: stock }],
    ...extra,
  };
}

const CATALOG = [
  prod("1", "Perfume Club de Nuit Intense Armaf 105 ml", 3, { brand: "Armaf" }),
  prod("2", "Perfume Árabe Musamam Lattafa 100 ml", 1, { brand: "Lattafa" }),
  prod("3", "Shampoo Kerasys Própolis 450 ml", 5, { brand: "Kerasys" }),
  prod("4", "Camiseta básica algodão", 0), // esgotada: não pode aparecer
  prod("5", "Hidratante corporal", 2, { category: "Corpo e banho", priceCash: 39.9 }),
];

describe("resumo do catálogo", () => {
  it("lista só os tipos com estoque", () => {
    const t = summarizeCatalog(CATALOG);
    expect(t).toContain("Perfume (2)");
    expect(t).toContain("Shampoo (1)");
    expect(t).toContain("Corpo e banho (1)");
    expect(t).not.toMatch(/Camiseta/);
    expect(t).toContain("Armaf");
    expect(t).toMatch(/R\$\s39,90/);
  });

  it("usa a categoria do cadastro ou a primeira palavra do nome", () => {
    expect(productKind(prod("x", "Kit de Body Splash", 1))).toBe("Body");
    expect(productKind(prod("y", "Qualquer", 1, { category: "Cabelo" }))).toBe("Cabelo");
  });

  it("lê todas as páginas da API e guarda o resumo", async () => {
    const pages: number[] = [];
    const nive = {
      async listProducts(page: number, take: number) {
        pages.push(page);
        const all = Array.from({ length: 150 }, (_, i) => prod(String(i), i < 100 ? `Perfume ${i}` : `Shampoo ${i}`, 1));
        return { items: all.slice((page - 1) * take, page * take), total: 150 };
      },
    } as unknown as NiveApi;
    const store = new Store(":memory:");
    const c = new CatalogSummary(store, nive, () => 1_000);
    const text = await c.get();
    expect(pages).toEqual([1, 2]);
    expect(text).toContain("Perfume (100)");
    expect(text).toContain("Shampoo (50)");
    // na segunda vez vem do banco, sem chamar a API
    expect(await c.get()).toBe(text);
    expect(pages).toEqual([1, 2]);
  });

  it("sem acesso ao catálogo, a IA segue sem o resumo", async () => {
    const nive = { async listProducts() { throw new Error("401"); } } as unknown as NiveApi;
    const c = new CatalogSummary(new Store(":memory:"), nive);
    expect(await c.get()).toBeNull();
  });
});

describe("instruções da IA", () => {
  const base = { settings: structuredClone(DEFAULT_SETTINGS), now: new Date(), identity: null, awaitingBirthDate: false, blocked: false };

  it("leva o catálogo e manda buscar antes de dizer que tem", () => {
    const p = buildSystemPrompt({ ...base, catalogSummary: summarizeCatalog(CATALOG) });
    expect(p).toContain("Perfume (2)");
    expect(p).toMatch(/Antes de dizer que a loja tem/);
    expect(p).toMatch(/Nunca sugira por conta própria um tipo de produto que a loja não vende/);
    expect(p).not.toMatch(/Confirme que tem com entusiasmo/);
  });

  it("fala como a equipe da loja, sem se apresentar como IA", () => {
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/Nunca diga nem dê a entender que é IA/);
    expect(p).not.toMatch(/diga que é o atendimento automático/);
    expect(p).toMatch(/fale só o que sabe/);
  });
});
