// Avise-me quando chegar, lembrete de reserva, retomar conversa parada e resumo do dia.
import { describe, expect, it } from "vitest";
import { PRODUCTS, inbound, reply, setup, toolCall } from "./helpers";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;

describe("mensagens proativas", () => {
  it("avisa quando o produto esgotado volta ao estoque", async () => {
    const t = setup();
    t.ai.script(toolCall("avisar_quando_chegar", { produto_id: "p-tenis" }), reply("Combinado, te aviso!"));
    await t.engine.handleInbound(inbound(PHONE, "me avisa quando chegar o 41?"));
    await t.clock.advance(2000);
    expect(t.engine.listWaitlist()).toHaveLength(1);
    // ainda sem estoque novo? o tênis tem 2 no 40, então já "tem": troca por um produto zerado
    const tenis = PRODUCTS.find((p) => p.id === "p-tenis")!;
    const saved = tenis.variants.map((v) => v.stockQty);
    tenis.variants.forEach((v) => (v.stockQty = 0));
    await t.engine.runProactive();
    expect(t.wa.sent).toHaveLength(1);
    tenis.variants[1]!.stockQty = 3;
    await t.engine.runProactive();
    tenis.variants.forEach((v, i) => (v.stockQty = saved[i]!));
    expect(t.wa.sent).toHaveLength(2);
    expect(t.wa.sent[1]!.body).toContain("chegou");
    expect(t.engine.listWaitlist()[0]!.status).toBe("notified");
  });

  it("lembra a reserva algumas horas antes de vencer, uma vez só", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true, validityHours: 24, reminderHours: 3 } } });
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Pedro Alves" }), reply("Separado!"));
    await t.engine.handleInbound(inbound(PHONE, "separa a bolsa"));
    await t.clock.advance(2000);
    const sent = t.wa.sent.length;
    t.clock.t += 22 * 3_600_000; // faltam ~2 h
    const d = new Date(t.clock.t);
    if (d.getHours() < 8 || d.getHours() > 20) t.clock.t += 0; // horário do teste fica dentro de 8h–20h30
    await t.engine.runProactive();
    await t.engine.runProactive();
    expect(t.wa.sent.length).toBe(sent + 1);
    expect(t.wa.sent.at(-1)!.body).toContain("separado pra você");
  });

  it("retoma uma vez a conversa parada em que a IA fez uma pergunta", async () => {
    const t = setup({ settings: { attendance: { followUpHours: 4 } } });
    t.ai.script(reply("Temos sim! É pra você ou pra presente?"));
    await t.engine.handleInbound(inbound(PHONE, "tem perfume?"));
    await t.clock.advance(2000);
    t.clock.t += 5 * 3_600_000;
    t.ai.script(reply("Oi! Conseguiu pensar no perfume? Posso te mostrar umas opções 😊"));
    await t.engine.runProactive();
    await t.engine.runProactive();
    expect(t.wa.sent).toHaveLength(2);
    expect(t.wa.sent[1]!.body).toContain("Conseguiu pensar");
  });

  it("não manda nada fora do horário (ex.: de madrugada)", async () => {
    const t = setup({ settings: { attendance: { followUpHours: 1 } } });
    t.ai.script(reply("É pra você ou pra presente?"));
    await t.engine.handleInbound(inbound(PHONE, "tem perfume?"));
    await t.clock.advance(2000);
    t.clock.t = new Date("2026-11-01T02:00:00-03:00").getTime();
    await t.engine.runProactive();
    expect(t.wa.sent).toHaveLength(1);
  });

  it("monta o resumo do dia", async () => {
    const t = setup();
    t.ai.script(reply("Oi!"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    const s = t.engine.dailySummary();
    expect(s.conversations).toBe(1);
    expect(s.newContacts).toBe(1);
    expect(s.aiReplies).toBe(1);
  });
});
