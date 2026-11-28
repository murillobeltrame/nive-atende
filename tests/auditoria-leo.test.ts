// Ajustes da auditoria das conversas da Léo Conveniência (28/11).
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";
import { dateBR, isInternalPaymentMethod } from "../src/main/ai/tools";
import { reservationNotes } from "../src/main/engine/engine";
import type { ChatMessage } from "../src/shared/types";

const PHONE = "5521977776666";

describe("estoque na busca com reserva do próprio cliente", () => {
  it("a última unidade que o cliente acabou de pedir não aparece como esgotada para ele", async () => {
    const t = setup();
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Pedro Alves" }), reply("Separado!"));
    await t.engine.handleInbound(inbound(PHONE, "separa a bolsa"));
    await t.clock.advance(2000);
    // simula o pedido ainda aguardando a loja (reservas antigas da aprovação no app)
    const r = t.store.listReservations()[0]!;
    t.store.updateReservation(r.id, { status: "pending_approval" });
    let out = "";
    t.ai.script(toolCall("buscar_produto", { termo: "bolsa" }), (msgs) => {
      out = String(msgs.at(-1)!.content);
      return reply("Tá separada pra você.");
    });
    await t.engine.handleInbound(inbound(PHONE, "e a bolsa?"));
    await t.clock.advance(2000);
    expect(out).toContain("ja_pedido_por_este_cliente");
    expect(out).not.toContain("esgotados");
  });
});

describe("fim da promoção no horário de Brasília", () => {
  it("30/11 23:59 em Brasília (01/12 em UTC) é 30/11", () => {
    expect(dateBR("2026-12-01T02:59:59.000Z", true)).toBe("30/11/2026");
    expect(dateBR("2026-12-01T03:00:00.000Z", true)).toBe("30/11/2026");
    expect(dateBR("2026-11-30", true)).toBe("30/11/2026");
  });
  it("vencimento de conta continua pela data gravada", () => {
    expect(dateBR("2026-11-27T00:00:00.000Z")).toBe("27/11/2026");
  });
});

describe("formas de pagamento ao consumidor", () => {
  it("esconde as de uso interno", () => {
    expect(["Permuta", "Vale-troca", "Vale Troca", "Bonificação"].every(isInternalPaymentMethod)).toBe(true);
    expect(["PIX", "Dinheiro", "Cartão de crédito", "Boleto", "Cheque"].some(isInternalPaymentMethod)).toBe(false);
  });
});

describe("observação do rascunho com a conversa", () => {
  const msg = (i: number, origin: ChatMessage["origin"], text: string): ChatMessage => ({
    id: `m${i}`, conversationId: "c", waMessageId: null, origin, kind: "text", text, transcript: null, mediaMime: null,
    hasMedia: false, fileName: null, durationSec: null, createdAt: Date.UTC(2026, 10, 27, 22, 45 + i), status: "sent", author: null, eventType: null,
  });
  it("leva cliente e atendente, sem eventos do sistema, no horário de Brasília", () => {
    const n = reservationNotes("Reserva", [msg(0, "consumidor", "Ainda tem?"), msg(1, "sistema", "evento"), msg(2, "ia", "Tem sim!")]);
    expect(n).toBe("Reserva\n\n[Conversa Nive Atende]\n27/11, 19:45 Cliente: Ainda tem?\n27/11, 19:47 Atendente: Tem sim!\n[/Conversa Nive Atende]");
  });
  it("conversa longa: guarda o final e cabe no limite do sistema", () => {
    const many = Array.from({ length: 80 }, (_, i) => msg(i, i % 2 ? "ia" : "consumidor", `mensagem número ${i} `.repeat(4)));
    const n = reservationNotes("Reserva", many);
    expect(n.length).toBeLessThanOrEqual(1990);
    expect(n).toContain("mensagem número 79");
    expect(n).toContain("[Conversa Nive Atende]\n…\n");
    expect(n.endsWith("[/Conversa Nive Atende]")).toBe(true);
  });
});
