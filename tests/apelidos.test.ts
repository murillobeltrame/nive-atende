// Apelidos de produtos: "o perfume da abelhinha" → Atheeri, nomes escritos errado e aprendizado.
import { describe, expect, it } from "vitest";
import { addNickname, fuzzySearch, listNicknames, matchNicknames, sameWord, saveCatalogIndex, type CatalogEntry } from "../src/main/ai/nicknames";
import { buildSystemPrompt } from "../src/main/ai/prompt";
import type { NiveProduct } from "../src/main/nive/client";
import { DEFAULT_SETTINGS } from "../src/main/settings";
import { Store } from "../src/main/store/db";
import { PRODUCTS, inbound, reply, setup, toolCall } from "./helpers";

const PHONE = "5521966665555";

const ATHEERI: NiveProduct = {
  id: "p-atheeri",
  description: "PERFUME ARABE ATHEERI LATTAFA 100ML",
  priceCash: 249.9,
  priceCredit: 269.9,
  active: true,
  tracksStock: true,
  imageUrl: "https://cdn.exemplo/atheeri.jpg",
  variants: [{ id: "v-atheeri", label: "Único", stockQty: 2 }],
  brand: "Lattafa",
};
PRODUCTS.push(ATHEERI);

const INDEX: CatalogEntry[] = [
  { id: "p-atheeri", nome: "Perfume Árabe Atheeri Lattafa 100 ml", marca: "Lattafa", tipo: "Perfume" },
  { id: "p-asad", nome: "Perfume Árabe Asad Lattafa 100 ml", marca: "Lattafa", tipo: "Perfume" },
  { id: "p-bolsa", nome: "Bolsa caramelo", marca: null, tipo: "Bolsa" },
];

/** Resultado da última ferramenta chamada, já em objeto. */
function lastTool(t: ReturnType<typeof setup>, name: string): Record<string, unknown> {
  type Msg = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string } }> };
  const msgs = t.ai.received.flat() as Msg[];
  const call = [...msgs].reverse().find((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === name));
  const id = call?.tool_calls?.find((c) => c.function.name === name)?.id;
  const out = msgs.find((m) => m.role === "tool" && m.tool_call_id === id);
  return JSON.parse(String(out?.content ?? "{}"));
}

describe("reconhecer palavras parecidas", () => {
  it("diminutivo, variação e erro de digitação", () => {
    expect(sameWord("abelha", "abelhinha")).toBe(true);
    expect(sameWord("azul", "azulzinho")).toBe(true);
    expect(sameWord("atheri", "atheeri")).toBe(true);
    expect(sameWord("aterri", "atheeri")).toBe(true);
    expect(sameWord("rosa", "rosto")).toBe(false);
    expect(sameWord("doce", "dose")).toBe(false);
  });

  it("acha o apelido no meio da frase do cliente", () => {
    const list = [{ apelido: "abelhinha", termo: "Atheeri", origem: "loja" as const, produtoId: null, criadoEm: 1 }];
    expect(matchNicknames(list, "vocês têm o perfume da abelhinha?")).toHaveLength(1);
    expect(matchNicknames(list, "perfume da abelha")).toHaveLength(1);
    expect(matchNicknames(list, "perfume doce")).toHaveLength(0);
  });

  it("busca no catálogo tolerando nome escrito errado", () => {
    expect(fuzzySearch(INDEX, "aterri").map((e) => e.id)).toEqual(["p-atheeri"]);
    expect(fuzzySearch(INDEX, "perfume atheri lattafa")[0]!.id).toBe("p-atheeri");
  });

  it("o que o lojista cadastrou não é trocado pelo que a IA aprendeu", () => {
    const store = new Store(":memory:");
    addNickname(store, { apelido: "abelhinha", termo: "Atheeri", origem: "loja" }, 1);
    addNickname(store, { apelido: "da abelhinha", termo: "Outro", origem: "ia" }, 2);
    expect(listNicknames(store)).toHaveLength(1);
    expect(listNicknames(store)[0]!.termo).toBe("Atheeri");
    expect(addNickname(store, { apelido: "123.456.789-09", termo: "X", origem: "ia" }, 3)).toBeNull();
  });
});

describe("apelidos na conversa", () => {
  it("apelido conhecido traz o produto certo primeiro", async () => {
    const t = setup();
    t.engine.addNickname("abelhinha", "Atheeri");
    t.ai.script(toolCall("buscar_produto", { termo: "perfume da abelhinha" }), reply("Tenho sim!"));
    await t.engine.handleInbound(inbound(PHONE, "tem o perfume da abelhinha?"));
    await t.clock.advance(2000);
    const out = lastTool(t, "buscar_produto");
    expect(out.apelido_conhecido).toContain("Atheeri");
    expect((out.produtos as Array<{ produto_id: string }>)[0]!.produto_id).toBe("p-atheeri");
    // e a IA já sabe do apelido nas instruções
    expect(String(t.ai.received[0]![0]!.content)).toContain('"abelhinha" = Atheeri');
  });

  it("nome escrito errado ainda acha pelo índice do catálogo", async () => {
    const t = setup();
    saveCatalogIndex(t.store, INDEX, 1);
    t.ai.script(toolCall("buscar_produto", { termo: "aterri" }), reply("Tenho!"));
    await t.engine.handleInbound(inbound(PHONE, "tem aterri?"));
    await t.clock.advance(2000);
    const out = lastTool(t, "buscar_produto");
    expect((out.produtos as Array<{ produto_id: string }>).map((p) => p.produto_id)).toContain("p-atheeri");
  });

  it("ver_catalogo lista os nomes do tipo para a IA reconhecer", async () => {
    const t = setup();
    saveCatalogIndex(t.store, INDEX, 1);
    t.ai.script(toolCall("ver_catalogo", { tipo: "perfume", marca: "" }), reply("É o Atheeri?"));
    await t.engine.handleInbound(inbound(PHONE, "tem o da abelhinha?"));
    await t.clock.advance(2000);
    const out = lastTool(t, "ver_catalogo");
    expect(out.total).toBe(2);
    expect(JSON.stringify(out)).toContain("Atheeri");
    expect(JSON.stringify(out)).not.toContain("Bolsa");
  });

  it("aprende o apelido quando fica claro qual é o produto", async () => {
    const t = setup();
    t.ai.script(
      toolCall("buscar_produto", { termo: "atheeri" }),
      toolCall("aprender_apelido", { apelido: "abelhinha", produto_id: "p-atheeri" }),
      reply("Isso, é o Atheeri!"),
    );
    await t.engine.handleInbound(inbound(PHONE, "isso, é esse da abelhinha"));
    await t.clock.advance(2000);
    const list = t.engine.listNicknames();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ apelido: "abelhinha", origem: "ia", produtoId: "p-atheeri" });
    expect(list[0]!.termo).toContain("Atheeri");
  });

  it("não aprende nome genérico nem produto que não viu", async () => {
    const t = setup();
    t.ai.script(
      toolCall("aprender_apelido", { apelido: "abelhinha", produto_id: "p-atheeri" }),
      toolCall("buscar_produto", { termo: "atheeri" }),
      toolCall("aprender_apelido", { apelido: "perfume lattafa", produto_id: "p-atheeri" }),
      reply("Certo!"),
    );
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(t.engine.listNicknames()).toEqual([]);
  });

  it("sugestão da IA (só leitura) não aprende apelidos", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    await t.engine.suggestReply(`${PHONE}@s.whatsapp.net`);
    expect(t.ai.toolsSeen.at(-1)).not.toContain("aprender_apelido");
    expect(t.ai.toolsSeen.at(-1)).toContain("ver_catalogo");
  });

  it("o lojista cadastra e remove", () => {
    const t = setup();
    expect(() => t.engine.addNickname("", "Atheeri")).toThrow();
    t.engine.addNickname("frasco dourado", "Khamrah");
    expect(t.engine.listNicknames().map((n) => n.apelido)).toEqual(["frasco dourado"]);
    expect(t.engine.removeNickname("frasco dourado")).toEqual([]);
  });
});

describe("instruções", () => {
  it("ensinam a tratar apelido como pista de um produto", () => {
    const p = buildSystemPrompt({ settings: structuredClone(DEFAULT_SETTINGS), now: new Date(), identity: null, awaitingBirthDate: false, blocked: false });
    expect(p).toContain("APELIDOS E NOMES POPULARES");
    expect(p).toMatch(/ver_catalogo/);
    expect(p).toMatch(/aprender_apelido/);
  });
});
