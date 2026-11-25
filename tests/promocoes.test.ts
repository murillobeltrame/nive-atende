// Promoções: a IA varre o sistema e responde, em vez de passar para humano.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";
import { isAnswerableHandoff } from "../src/main/ai/tools";
import type { NivePromotion } from "../src/main/nive/client";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;

const PROMOS: NivePromotion[] = [
  {
    id: "c1",
    kind: "campaign",
    name: "Semana da bolsa",
    description: "Preço promocional",
    endsAt: "2026-11-30T23:59:59.000Z",
    productCount: 1,
    products: [{ id: "p-bolsa", description: "Bolsa caramelo", priceCash: 159.9, promoPrice: 129.9 }],
  },
  {
    id: "q1",
    kind: "quantity",
    name: "Tênis leve 2",
    description: "Leve 2, pague 1",
    endsAt: null,
    productCount: 1,
    products: [{ id: "p-tenis", description: "Tênis Runner preto", priceCash: 289.9, promoPrice: null }],
  },
];

/** Conteúdo devolvido pela ferramenta na última chamada da IA. */
function lastToolOutput(t: ReturnType<typeof setup>, name: string): Record<string, unknown> {
  for (const msgs of [...t.ai.received].reverse()) {
    type Call = { id: string; function: { name: string } };
    const callsOf = (m: unknown) => ((m as { tool_calls?: Call[] }).tool_calls ?? []);
    const assistant = [...msgs].reverse().find((m) => m.role === "assistant" && callsOf(m).some((c) => c.function.name === name));
    if (!assistant) continue;
    const id = callsOf(assistant).find((c) => c.function.name === name)!.id;
    const out = msgs.find((m) => m.role === "tool" && (m as { tool_call_id?: string }).tool_call_id === id);
    if (out) return JSON.parse(String(out.content)) as Record<string, unknown>;
  }
  throw new Error(`sem saída de ${name}`);
}

describe("promoções", () => {
  it("pedido de humano por pergunta de promoção é recusado e a IA responde com a varredura", async () => {
    const t = setup();
    t.nive.promotions = PROMOS;
    t.ai.script(
      toolCall("transferir_para_humano", { motivo: "cliente pergunta sobre promoções de bebidas" }),
      toolCall("ver_promocoes", { termo: "bolsa" }),
      reply("Tem sim! A *Bolsa caramelo* está de R$ 159,90 por *R$ 129,90* até 30/11. Quer que eu separe?"),
    );
    await t.engine.handleInbound(inbound(PHONE, "Gostaria de saber sobre as promoções da bolsa"));
    await t.clock.advance(2000);
    const conv = t.store.getConversation(JID)!;
    expect(conv.state).not.toBe("precisa_humano");
    expect(t.wa.sent).toHaveLength(1);
    expect(JSON.stringify(t.wa.sent[0])).toContain("129,90");
    expect(lastToolOutput(t, "transferir_para_humano")).toMatchObject({ resultado: "NAO_TRANSFERIDO" });
    const promo = lastToolOutput(t, "ver_promocoes") as { promocoes: Array<{ produtos: Array<Record<string, string>> }> };
    expect(promo.promocoes[0]!.produtos[0]).toMatchObject({ de: "R$ 159,90", por: "R$ 129,90" });
  });

  it("insistindo na transferência depois da recusa, passa para humano", async () => {
    const t = setup();
    t.ai.script(
      toolCall("transferir_para_humano", { motivo: "promoções" }),
      toolCall("transferir_para_humano", { motivo: "promoções" }),
      reply("Já chamo alguém."),
    );
    await t.engine.handleInbound(inbound(PHONE, "promo?"));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.state).toBe("precisa_humano");
  });

  it("termo sem promoção: mostra todas as promoções valendo, avisando", async () => {
    const t = setup();
    t.nive.promotions = PROMOS;
    t.ai.script(toolCall("ver_promocoes", { termo: "vodka" }), reply("Promoção de vodka agora não tenho."));
    await t.engine.handleInbound(inbound(PHONE, "promo de vodka?"));
    await t.clock.advance(2000);
    const out = lastToolOutput(t, "ver_promocoes") as { obs?: string; total: number };
    expect(out.obs).toContain("vodka");
    expect(out.total).toBe(2);
  });

  it("categoria ampla ('bebidas') vira varredura de tudo", async () => {
    const t = setup();
    t.nive.promotions = PROMOS;
    t.ai.script(toolCall("ver_promocoes", { termo: "bebidas" }), reply("Olha o que tem:"));
    await t.engine.handleInbound(inbound(PHONE, "promo de bebidas"));
    await t.clock.advance(2000);
    const out = lastToolOutput(t, "ver_promocoes") as { obs?: string; total: number };
    expect(out.obs).toBeUndefined();
    expect(out.total).toBe(2);
  });

  it("sem promoção nenhuma ou ERP antigo: manda responder com o preço normal", async () => {
    const t = setup();
    t.nive.promotions = null;
    t.ai.script(toolCall("ver_promocoes", { termo: "" }), reply("Agora não tenho promoção."));
    await t.engine.handleInbound(inbound(PHONE, "promo?"));
    await t.clock.advance(2000);
    expect(lastToolOutput(t, "ver_promocoes")).toMatchObject({ resultado: "PROMOCOES_INDISPONIVEIS" });
    expect(t.store.getConversation(JID)!.state).not.toBe("precisa_humano");
  });

  it("busca marca o produto em promoção e o total usa o preço promocional", async () => {
    const t = setup();
    t.nive.promotions = PROMOS;
    t.ai.script(
      toolCall("buscar_produto", { termo: "bolsa" }),
      toolCall("calcular_total", { itens: [{ produto_id: "p-bolsa", quantidade: 2 }] }),
      reply("Duas ficam R$ 259,80."),
    );
    await t.engine.handleInbound(inbound(PHONE, "quanto fica 2 bolsas?"));
    await t.clock.advance(2000);
    const busca = lastToolOutput(t, "buscar_produto") as { produtos: Array<{ em_promocao?: Array<Record<string, unknown>> }> };
    expect(busca.produtos[0]!.em_promocao?.[0]).toMatchObject({ promocao: "Semana da bolsa", por: "R$ 129,90" });
    expect(lastToolOutput(t, "calcular_total")).toMatchObject({ total: "R$ 259,80" });
    expect(t.store.getConversation(JID)!.state).not.toBe("precisa_humano");
  });

  it("separa motivo de humano legítimo de pergunta que a IA responde", () => {
    expect(isAnswerableHandoff("cliente pergunta sobre promoções de bebidas")).toBe(true);
    expect(isAnswerableHandoff("preço da vodka")).toBe(true);
    expect(isAnswerableHandoff("pedido de desconto")).toBe(false);
    expect(isAnswerableHandoff("troca de produto com defeito")).toBe(false);
    expect(isAnswerableHandoff("cliente pediu para falar com uma pessoa")).toBe(false);
  });
});
