// Conversa pessoal no número da loja: a IA não interfere.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;
const verdict = (loja: boolean, motivo = "") => reply(JSON.stringify({ loja, motivo }));

describe("só assuntos da loja", () => {
  it("conversa pessoal: não responde, não mostra 'digitando' e não pede humano", async () => {
    const t = setup({ settings: { attendance: { onlyStoreTopics: true } } });
    t.ai.script(verdict(false, "conversa com amiga"));
    await t.engine.handleInbound(inbound(PHONE, "amiga, bora no churrasco sábado?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(0);
    expect(t.wa.presence).toHaveLength(0);
    const conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("ia");
    expect(t.store.listMessages(JID).some((m) => m.eventType === "personal")).toBe(true);
    expect(t.ai.received).toHaveLength(1); // só a análise
  });

  it("assunto da loja: atende normalmente", async () => {
    const t = setup({ settings: { attendance: { onlyStoreTopics: true } } });
    t.ai.script(verdict(true), toolCall("buscar_produto", { termo: "bolsa" }), reply("Tenho sim! R$ 159,90."));
    await t.engine.handleInbound(inbound(PHONE, "tem bolsa caramelo?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
  });

  it("no meio de um atendimento da IA não analisa de novo a cada mensagem", async () => {
    const t = setup({ settings: { attendance: { onlyStoreTopics: true } } });
    t.ai.script(verdict(true), reply("Oi! Em que posso ajudar?"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    t.ai.script(reply("Temos sim!"));
    await t.engine.handleInbound(inbound(PHONE, "tem perfume?"));
    await t.clock.advance(2000);
    expect(t.ai.received).toHaveLength(3);
    expect(t.wa.sent).toHaveLength(2);
  });

  it("se a análise falhar, atende normalmente", async () => {
    const t = setup({ settings: { attendance: { onlyStoreTopics: true } } });
    t.ai.script(reply("não sei"), reply("Oi! Em que posso ajudar?"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
  });

  it("contato pessoal não recebe aviso de fora do horário", async () => {
    const t = setup({ settings: { attendance: { onlyStoreTopics: true } } });
    t.ai.script(verdict(false, "família"));
    await t.engine.handleInbound(inbound(PHONE, "mãe, chego tarde hoje"));
    await t.clock.advance(2000);
    t.setSettings({ attendance: { businessHours: { enabled: true, days: [], start: "08:00", end: "09:00" } } });
    await t.engine.handleInbound(inbound(PHONE, "tá aí?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(0);
  });
});
