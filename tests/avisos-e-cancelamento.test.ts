// Reserva cancelada não recebe lembrete; cliente pode desligar as mensagens automáticas.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;

async function reservarBolsa(t: ReturnType<typeof setup>) {
  t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Pedro Alves" }), reply("Separado!"));
  await t.engine.handleInbound(inbound(PHONE, "separa a bolsa"));
  await t.clock.advance(2000);
  return t.store.listReservations()[0]!;
}

const comReserva = () => setup({ settings: { reservation: { autoEnabled: true, validityHours: 24, reminderHours: 3 }, attendance: { followUpEnabled: false } } });

describe("lembrete de reserva cancelada", () => {
  it("não lembra reserva cancelada no sistema da loja (e marca como removida)", async () => {
    const t = comReserva();
    const r = await reservarBolsa(t);
    t.nive.saleStatus[r.saleId!] = "DRAFT_CANCELLED";
    const sent = t.wa.sent.length;
    t.clock.t += 22 * 3_600_000;
    await t.engine.runProactive();
    // sem lembrete: só o aviso de que a loja não manteve a reserva
    expect(t.wa.sent.length).toBe(sent + 1);
    expect(t.wa.sent.at(-1)!.body).toContain("não conseguiu manter");
    expect(t.store.getReservation(r.id)!.status).toBe("removed");
  });

  it("não lembra reserva que o cliente cancelou pela conversa", async () => {
    const t = comReserva();
    const r = await reservarBolsa(t);
    t.ai.script(toolCall("cancelar_reserva", { reserva_id: "" }), reply("Cancelei, sem problema!"));
    await t.engine.handleInbound(inbound(PHONE, "pode cancelar, desisti"));
    await t.clock.advance(2000);
    expect(t.store.getReservation(r.id)!.status).toBe("cancelled");
    const sent = t.wa.sent.length;
    t.clock.t += 22 * 3_600_000;
    await t.engine.runProactive();
    expect(t.wa.sent.length).toBe(sent);
  });

  it("cancela todas as reservas de uma vez", async () => {
    const t = comReserva();
    await reservarBolsa(t);
    await reservarBolsa(t);
    t.ai.script(toolCall("cancelar_reserva", { reserva_id: "todas" }), reply("Cancelei as duas!"));
    await t.engine.handleInbound(inbound(PHONE, "cancela tudo"));
    await t.clock.advance(2000);
    expect(t.store.listReservations().every((r) => r.status === "cancelled")).toBe(true);
  });

  it("se o cliente disse que desistiu e a reserva ficou, não lembra: chama a loja", async () => {
    const t = comReserva();
    const r = await reservarBolsa(t);
    t.ai.script(reply("Tranquilo!")); // a IA não cancelou
    await t.engine.handleInbound(inbound(PHONE, "não quero mais a bolsa"));
    await t.clock.advance(2000);
    const sent = t.wa.sent.length;
    t.clock.t += 22 * 3_600_000;
    await t.engine.runProactive();
    expect(t.wa.sent.length).toBe(sent);
    expect(t.store.getReservation(r.id)!.status).toBe("created");
    expect(t.store.getConversation(JID)!.state).toBe("precisa_humano");
  });

  it("a IA sabe que a reserva foi cancelada e não fala dela como separada", async () => {
    const t = comReserva();
    const r = await reservarBolsa(t);
    await t.engine.cancelReservation(r.id);
    t.ai.script(reply("Oi!"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    const system = String(t.ai.received.at(-1)![0]!.content);
    expect(system).toContain("Reservas encerradas");
    expect(system).toContain("Não há nada separado");
  });
});

describe("cliente desliga as mensagens automáticas", () => {
  it("lembrete traz como parar; PARAR desliga e nada mais é enviado", async () => {
    const t = comReserva();
    await reservarBolsa(t);
    await reservarBolsa(t);
    t.clock.t += 22 * 3_600_000;
    const sent = t.wa.sent.length;
    await t.engine.runProactive();
    expect(t.wa.sent.length).toBeGreaterThan(sent);
    expect(t.wa.sent.at(-1)!.body).toContain("PARAR");

    const tentativas = t.ai.attempts;
    await t.engine.handleInbound(inbound(PHONE, "Parar"));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.autoMessagesOff).toBe(true);
    expect(t.wa.sent.at(-1)!.body).toContain("não te mando mais");
    expect(t.ai.attempts).toBe(tentativas); // PARAR não passa pela IA

    t.ai.script(reply("Temos sim! Quer ver?"));
    await t.engine.handleInbound(inbound(PHONE, "tem perfume?"));
    await t.clock.advance(2000);
    const depois = t.wa.sent.length;
    t.clock.t += 5 * 3_600_000;
    await t.engine.runProactive();
    expect(t.wa.sent.length).toBe(depois);
  });

  it("pedido em texto livre: a IA desliga pela ferramenta; o lojista religa pelo app", async () => {
    const t = setup();
    t.ai.script(toolCall("mensagens_automaticas", { receber: false }), reply("Pode deixar, não mando mais avisos."));
    await t.engine.handleInbound(inbound(PHONE, "para de me mandar essas mensagens por favor"));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.autoMessagesOff).toBe(true);
    expect(t.engine.setAutoMessages(JID, true, "loja").autoMessagesOff).toBe(false);
  });

  it("VOLTAR religa", async () => {
    const t = setup();
    t.store.ensureConversation(JID, PHONE, "");
    t.engine.setAutoMessages(JID, false, "cliente");
    await t.engine.handleInbound(inbound(PHONE, "voltar"));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.autoMessagesOff).toBe(false);
  });
});
