// Testes do motor: resposta automática, marcação IA × humano, pausa, reservas, áudio e falhas.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";
import { AiError } from "../src/main/ai/openai";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;

describe("resposta automática", () => {
  it("responde perguntas de produto com dados da ferramenta e marca como IA", async () => {
    const t = setup();
    t.ai.script(toolCall("buscar_produto", { termo: "bolsa caramelo" }), reply("Tenho sim! A bolsa caramelo está R$ 159,90. Quer que eu separe?"));
    await t.engine.handleInbound(inbound(PHONE, "tem a bolsa caramelo?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
    const msgs = t.store.listMessages(JID);
    expect(msgs.map((m) => m.origin)).toEqual(["consumidor", "ia"]);
    expect(msgs[1]!.status).toBe("sent");
    expect(t.store.getConversation(JID)!.aiRepliesCount).toBe(1);
  });

  it("junta mensagens seguidas do cliente numa resposta só", async () => {
    const t = setup({ settings: { attendance: { replyDelayMinSec: 5, replyDelayMaxSec: 5 } } });
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    await t.engine.handleInbound(inbound(PHONE, "tem tênis preto 40?"));
    await t.clock.advance(6000);
    expect(t.ai.received).toHaveLength(1);
    expect(t.wa.sent).toHaveLength(1);
  });

  it("não envia valor em R$ que não veio das ferramentas: passa para humano", async () => {
    const t = setup();
    t.ai.script(reply("A bolsa sai por R$ 99,00!"));
    await t.engine.handleInbound(inbound(PHONE, "quanto custa a bolsa?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(0);
    const conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("precisa_humano");
    expect(conv.handoffReason).toContain("valor não confirmado");
  });

  it("transferir_para_humano muda o estado, cria o evento e pausa a IA", async () => {
    const t = setup();
    t.ai.script(toolCall("transferir_para_humano", { motivo: "pedido de desconto" }), reply("Vou chamar alguém da loja, só um instante."));
    await t.engine.handleInbound(inbound(PHONE, "faz um desconto?"));
    await t.clock.advance(2000);
    const conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("precisa_humano");
    expect(conv.handoffReason).toBe("pedido de desconto");
    expect(t.store.listMessages(JID).some((m) => m.origin === "sistema" && m.eventType === "handoff")).toBe(true);
    // nova mensagem durante a pausa: a IA não responde
    await t.engine.handleInbound(inbound(PHONE, "e aí?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
  });

  it("atendimento automático desligado: não responde", async () => {
    const t = setup({ settings: { attendance: { autoEnabled: false } } });
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(t.ai.received).toHaveLength(0);
    expect(t.wa.sent).toHaveLength(0);
  });

  it("números ignorados ficam marcados e não recebem resposta", async () => {
    const t = setup({ settings: { attendance: { ignoredNumbers: ["(21) 97777-6666"] } } });
    await t.engine.handleInbound(inbound(PHONE, "segue o boleto"));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.state).toBe("ignorado");
    expect(t.wa.sent).toHaveLength(0);
  });

  it("mensagem antiga (chegou com o app parado) não é respondida automaticamente", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi", { timestamp: t.clock.now() - 5 * 3600_000 }));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(0);
    expect(t.store.getConversation(JID)!.state).toBe("precisa_humano");
  });

  it("fora do horário: manda a mensagem de horário uma vez e não chama a IA", async () => {
    const t = setup({ settings: { attendance: { businessHours: { enabled: true, days: [1], start: "08:00", end: "09:00" } } } });
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    await t.engine.handleInbound(inbound(PHONE, "alguém?"));
    await t.clock.advance(2000);
    expect(t.ai.received).toHaveLength(0);
    expect(t.wa.sent).toHaveLength(1);
    expect(t.wa.sent[0]!.body).toContain("fora do horário");
  });
});

describe("marcação IA × humano", () => {
  it("resposta enviada pelo celular é marcada como humano_celular e pausa a IA", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi", { fromMe: true, waMessageId: "PHONE1" }));
    await t.clock.advance(4000);
    const msgs = t.store.listMessages(JID);
    expect(msgs.find((m) => m.waMessageId === "PHONE1")?.origin).toBe("humano_celular");
    const conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("humano");
    expect(conv.aiPausedUntil).toBeGreaterThan(t.clock.now());
    // cliente responde: IA não entra
    await t.engine.handleInbound(inbound(PHONE, "obrigado"));
    await t.clock.advance(2000);
    expect(t.ai.received).toHaveLength(0);
  });

  it("o eco de uma mensagem enviada pelo app não vira humano_celular", async () => {
    const t = setup();
    t.ai.script(reply("Oi! Em que posso ajudar?"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    const sentId = t.store.listMessages(JID).find((m) => m.origin === "ia")!.waMessageId!;
    await t.engine.handleInbound(inbound(PHONE, "Oi! Em que posso ajudar?", { fromMe: true, waMessageId: sentId }));
    await t.clock.advance(5000);
    const origins = t.store.listMessages(JID).map((m) => m.origin);
    expect(origins.filter((o) => o === "humano_celular")).toHaveLength(0);
    expect(t.store.getConversation(JID)!.state).toBe("ia");
  });

  it("mensagem do app grava humano_app com o nome e pausa a IA", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.engine.sendHumanText(JID, "Oi, aqui é o Murillo!", "Murillo");
    const m = t.store.listMessages(JID).find((x) => x.origin === "humano_app")!;
    expect(m.author).toBe("Murillo");
    expect(m.status).toBe("sent");
    expect(t.store.getConversation(JID)!.state).toBe("humano");
    await t.clock.advance(3000);
    expect(t.ai.received).toHaveLength(0); // a mensagem pendente do cliente foi assumida pelo humano
  });

  it("devolver para a IA volta a responder automaticamente", async () => {
    const t = setup();
    t.store.ensureConversation(JID, PHONE, "Cliente");
    t.engine.takeOver(JID, "Murillo");
    expect(t.store.getConversation(JID)!.state).toBe("humano");
    t.engine.returnToAi(JID);
    t.ai.script(reply("Oi!"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
  });
});

describe("reservas", () => {
  it("reserva automática ligada cria rascunho no ERP", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    t.ai.script(
      toolCall("buscar_produto", { termo: "bolsa caramelo" }),
      toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1 }),
      reply("Separado! Fica reservada até amanhã."),
    );
    await t.engine.handleInbound(inbound(PHONE, "separa a bolsa caramelo pra mim"));
    await t.clock.advance(2000);
    expect(t.nive.drafts).toHaveLength(1);
    expect(t.nive.drafts[0]!.variantId).toBe("v-bolsa");
    const r = t.store.listReservations()[0]!;
    expect(r.status).toBe("created");
    expect(r.orderNumber).toBe(501);
  });

  it("reserva automática desligada fica aguardando aprovação; aprovar cria o rascunho e avisa o cliente", async () => {
    const t = setup();
    let result = "";
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1 }), (msgs) => {
      result = String((msgs.at(-1) as { content: string }).content);
      return reply("Vou pedir para separarem e já te confirmo.");
    });
    await t.engine.handleInbound(inbound(PHONE, "separa pra mim"));
    await t.clock.advance(2000);
    expect(result).toContain("AGUARDANDO_CONFIRMACAO_DA_LOJA");
    expect(t.nive.drafts).toHaveLength(0);
    const r = t.store.listReservations()[0]!;
    expect(r.status).toBe("pending_approval");
    const approved = await t.engine.approveReservation(r.id);
    expect(approved.status).toBe("created");
    expect(t.wa.sent.at(-1)!.body).toContain("Separado!");
  });

  it("não reserva acima do estoque disponível (descontando reservas já feitas)", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1 }), reply("Separado!"));
    await t.engine.handleInbound(inbound(PHONE, "separa"));
    await t.clock.advance(2000);
    let res = "";
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1 }), (msgs) => {
      res = String((msgs.at(-1) as { content: string }).content);
      return reply("Acabou de sair a última.");
    });
    await t.engine.handleInbound(inbound("5521911110000", "separa a bolsa"));
    await t.clock.advance(2000);
    expect(res).toContain("SEM_ESTOQUE_SUFICIENTE");
  });

  it("respeita o limite de unidades por reserva", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true, maxQtyPerOrder: 1 } } });
    let res = "";
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-tenis", variacao_id: "v-40", quantidade: 2 }), (msgs) => {
      res = String((msgs.at(-1) as { content: string }).content);
      return reply("Por aqui consigo separar 1.");
    });
    await t.engine.handleInbound(inbound(PHONE, "separa 2"));
    await t.clock.advance(2000);
    expect(res).toContain("QUANTIDADE_ACIMA_DO_LIMITE");
  });
});

describe("áudio", () => {
  it("transcreve o áudio e responde com base no texto", async () => {
    const t = setup();
    t.ai.script(toolCall("buscar_produto", { termo: "bolsa caramelo" }), reply("Tenho sim, R$ 159,90!"));
    await t.engine.handleInbound(inbound(PHONE, null, { kind: "audio", mimetype: "audio/ogg", durationSec: 8, base64: Buffer.from("fake-ogg").toString("base64") }));
    await t.clock.advance(2000);
    const audio = t.store.listMessages(JID).find((m) => m.kind === "audio")!;
    expect(audio.transcript).toContain("bolsa caramelo");
    expect(t.wa.sent).toHaveLength(1);
    expect(JSON.stringify(t.ai.received[0])).toContain("(áudio) oi, vocês ainda têm aquela bolsa caramelo?");
  });

  it("áudio acima da duração máxima vai para humano", async () => {
    const t = setup({ settings: { audio: { maxSeconds: 60 } } });
    await t.engine.handleInbound(inbound(PHONE, null, { kind: "audio", durationSec: 300, base64: "AAAA" }));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.state).toBe("precisa_humano");
    expect(t.ai.received).toHaveLength(0);
  });
});

describe("atendimento parado", () => {
  it("com o atendimento bloqueado as mensagens ficam aguardando e são respondidas quando volta", async () => {
    const t = setup();
    t.setBlocked("WhatsApp desconectado");
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(0);
    expect(t.store.countUnprocessed()).toBe(1);
    t.setBlocked(null);
    t.ai.script(reply("Oi! Em que posso ajudar?"));
    await t.engine.resumeWaiting();
    expect(t.wa.sent).toHaveLength(1);
    expect(t.store.countUnprocessed()).toBe(0);
  });

  it("IA sem crédito: não manda resposta quebrada e mantém a mensagem aguardando", async () => {
    const t = setup();
    t.ai.error = new AiError("sem créditos", "no_credit");
    const errors: AiError[] = [];
    t.engine.on("aiError", (e) => errors.push(e));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(errors[0]?.kind).toBe("no_credit");
    expect(t.wa.sent).toHaveLength(0);
    expect(t.store.countUnprocessed()).toBe(1);
  });
});
