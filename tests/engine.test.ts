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

  it("não envia valor em R$ que não veio das ferramentas: tenta de novo e, se insistir, passa para humano", async () => {
    const t = setup();
    t.ai.script(reply("A bolsa sai por R$ 99,00!"), reply("Sai por R$ 99,00 mesmo!"));
    await t.engine.handleInbound(inbound(PHONE, "quanto custa a bolsa?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(0);
    const conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("precisa_humano");
    expect(conv.handoffReason).toContain("valor não confirmado");
  });

  it("pode repetir o valor que o cliente pediu, mesmo escrito sem R$", async () => {
    const t = setup();
    t.ai.script(reply("Até R$ 100,00 temos estas opções, quer ver as fotos?"));
    await t.engine.handleInbound(inbound(PHONE, "que tens de whiskey até sem 100 reais ?"));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.state).not.toBe("precisa_humano");
    expect(t.wa.sent).toHaveLength(1);
  });

  it("valor inventado na primeira tentativa: refaz com o motivo e envia a resposta corrigida", async () => {
    const t = setup();
    t.ai.script(
      reply("A bolsa sai por R$ 99,00!"),
      toolCall("buscar_produto", { termo: "bolsa" }),
      reply("A bolsa caramelo está *R$ 159,90*. Quer que eu separe?"),
    );
    await t.engine.handleInbound(inbound(PHONE, "quanto custa a bolsa?"));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.state).not.toBe("precisa_humano");
    expect(t.wa.sent).toHaveLength(1);
    expect(JSON.stringify(t.wa.sent[0])).toContain("159,90");
    // a segunda tentativa recebeu o motivo
    expect(JSON.stringify(t.ai.received[1])).toContain("não veio das ferramentas");
  });

  it("quantidade × preço do sistema não é tratado como valor inventado", async () => {
    const t = setup();
    t.ai.script(toolCall("buscar_produto", { termo: "bolsa" }), reply("Duas bolsas ficam R$ 319,80."));
    await t.engine.handleInbound(inbound(PHONE, "quanto fica 2 bolsas?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
    expect(t.store.getConversation(JID)!.state).not.toBe("precisa_humano");
  });

  it("calcular_total usa o preço do sistema e libera o total na resposta", async () => {
    const t = setup();
    t.ai.script(
      toolCall("calcular_total", { itens: [{ produto_id: "p-bolsa", quantidade: 1 }, { produto_id: "p-tenis", quantidade: 1 }] }),
      (messages) => {
        const out = JSON.parse(String(messages[messages.length - 1]!.content));
        expect(out.total).toContain("449,80");
        return { content: `Fica ${out.total} no total.`, toolCalls: [], inputTokens: 1, outputTokens: 1 };
      },
    );
    await t.engine.handleInbound(inbound(PHONE, "bolsa e o tênis quanto fica?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
    expect(JSON.stringify(t.wa.sent[0])).toContain("449,80");
  });

  it("nome de ferramenta escrito na resposta não chega ao cliente", async () => {
    const t = setup();
    t.ai.script(reply("Já chamo alguém da loja. transferir_para_humano"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(JSON.stringify(t.wa.sent[0])).not.toContain("transferir_para_humano");
  });

  it("sem resposta depois de muitas buscas: pede a resposta em vez de passar para humano", async () => {
    const t = setup();
    for (let i = 0; i < 6; i++) t.ai.script(toolCall("buscar_produto", { termo: `bolsa ${i}` }));
    t.ai.script(reply("Tenho a bolsa caramelo por R$ 159,90!"));
    await t.engine.handleInbound(inbound(PHONE, "tem bolsa?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
    expect(t.store.getConversation(JID)!.state).not.toBe("precisa_humano");
  });

  it("transferir_para_humano marca a pendência, mas a IA segue atendendo e analisa a nova mensagem", async () => {
    const t = setup();
    t.ai.script(toolCall("transferir_para_humano", { motivo: "pedido de desconto" }), reply("Vou ver isso com a equipe, só um instante."));
    await t.engine.handleInbound(inbound(PHONE, "faz um desconto?"));
    await t.clock.advance(2000);
    let conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("precisa_humano");
    expect(conv.handoffReason).toBe("pedido de desconto");
    expect(conv.aiPausedUntil).toBeNull();
    expect(t.store.listMessages(JID).some((m) => m.origin === "sistema" && m.eventType === "handoff")).toBe(true);
    // nova mensagem: a IA responde, sabendo que a conversa está com a equipe
    t.ai.script(reply("A equipe já está vendo o desconto e te responde já já."));
    await t.engine.handleInbound(inbound(PHONE, "e aí?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(2);
    expect(JSON.stringify(t.ai.received[t.ai.received.length - 1])).toContain("já foi encaminhada para a equipe");
    expect(t.ai.toolsSeen[t.ai.toolsSeen.length - 1]).toContain("resolvido_sem_equipe");
    conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("precisa_humano");
  });

  it("mesmo motivo de novo não repete o aviso para a equipe", async () => {
    const t = setup();
    t.ai.script(toolCall("transferir_para_humano", { motivo: "pedido de desconto" }), reply("Vou ver com a equipe."));
    await t.engine.handleInbound(inbound(PHONE, "faz desconto?"));
    await t.clock.advance(2000);
    t.ai.script(toolCall("transferir_para_humano", { motivo: "pedido de desconto" }), reply("Já estão vendo, só um instante."));
    await t.engine.handleInbound(inbound(PHONE, "faz ou não?"));
    await t.clock.advance(2000);
    expect(t.store.listMessages(JID).filter((m) => m.eventType === "handoff")).toHaveLength(1);
  });

  it("a IA resolve sozinha a pendência quando a nova mensagem permite", async () => {
    const t = setup();
    t.ai.script(toolCall("transferir_para_humano", { motivo: "não entendi o pedido" }), reply("Vou chamar a equipe."));
    await t.engine.handleInbound(inbound(PHONE, "aquele lá"));
    await t.clock.advance(2000);
    t.ai.script(
      toolCall("buscar_produto", { termo: "bolsa" }),
      toolCall("resolvido_sem_equipe", { resumo: "cliente queria a bolsa caramelo" }),
      reply("Ah, a bolsa caramelo! Está R$ 159,90. Quer que eu separe?"),
    );
    await t.engine.handleInbound(inbound(PHONE, "a bolsa caramelo"));
    await t.clock.advance(2000);
    const conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("ia");
    expect(conv.handoffReason).toBeNull();
    expect(t.store.listMessages(JID).some((m) => m.eventType === "handoff_resolved")).toBe(true);
  });

  it("sem limite diário: a IA continua respondendo na mesma conversa", async () => {
    const t = setup();
    for (let i = 0; i < 35; i++) {
      await t.engine.handleInbound(inbound(PHONE, `pergunta ${i}`));
      await t.clock.advance(2000);
    }
    expect(t.wa.sent).toHaveLength(35);
    expect(t.store.getConversation(JID)!.state).not.toBe("precisa_humano");
  });

  it("conversa travada pelo limite antigo volta a ser atendida", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    t.store.updateConversation(JID, { state: "precisa_humano", handoffReason: "limite diário de respostas da IA nesta conversa", aiPausedUntil: t.clock.now() + 3600_000 });
    await t.engine.handleInbound(inbound(PHONE, "tem bolsa?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(2);
    expect(t.store.getConversation(JID)!.state).toBe("ia");
  });

  it("formas de pagamento vêm do sistema, sem o crediário", async () => {
    const t = setup();
    t.ai.script(toolCall("ver_formas_pagamento", {}), (messages) => {
      const out = JSON.parse(String(messages[messages.length - 1]!.content));
      expect(out.formas).toEqual(["Pix", "Cartão de crédito"]);
      expect(out.crediario).toContain("equipe");
      return { content: "Aceitamos Pix e cartão de crédito!", toolCalls: [], inputTokens: 1, outputTokens: 1 };
    });
    await t.engine.handleInbound(inbound(PHONE, "aceita pix?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
    expect(t.store.getConversation(JID)!.state).toBe("ia");
  });

  it("pedido de crediário sempre vai para a equipe, mesmo se a IA não transferir", async () => {
    const t = setup();
    t.ai.script(reply("Vou ver isso pra você."));
    await t.engine.handleInbound(inbound(PHONE, "posso pagar no crediário?"));
    await t.clock.advance(2000);
    const conv = t.store.getConversation(JID)!;
    expect(conv.state).toBe("precisa_humano");
    expect(conv.handoffReason).toBe("cliente quer crediário");
  });

  it("transferência por crediário não é recusada como pergunta simples", async () => {
    const { isAnswerableHandoff } = await import("../src/main/ai/tools");
    expect(isAnswerableHandoff("cliente quer crediário")).toBe(false);
    expect(isAnswerableHandoff("formas de pagamento")).toBe(true);
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
      toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Maria Teste" }),
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
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Maria Teste" }), (msgs) => {
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
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Maria Teste" }), reply("Separado!"));
    await t.engine.handleInbound(inbound(PHONE, "separa"));
    await t.clock.advance(2000);
    let res = "";
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Maria Teste" }), (msgs) => {
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
    t.ai.script(toolCall("reservar_produto", { produto_id: "p-tenis", variacao_id: "v-40", quantidade: 2, nome_cliente: "Maria Teste" }), (msgs) => {
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

  it("erro da plataforma de IA: passa para humano com o motivo real e avisa o status", async () => {
    const t = setup();
    t.ai.error = new AiError("messages.1.content.0.image.source: Unable to download the file", "other");
    const errors: AiError[] = [];
    t.engine.on("aiError", (e) => errors.push(e));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(errors[0]?.kind).toBe("other");
    const conv = t.store.listConversations("todas")[0]!;
    expect(conv.state).toBe("precisa_humano");
    expect(conv.handoffReason).toBe("erro ao gerar resposta: messages.1.content.0.image.source: Unable to download the file");
  });

  it("resposta da IA que dá certo avisa o status", async () => {
    const t = setup();
    let ok = 0;
    t.engine.on("aiOk", () => ok++);
    t.ai.script(reply("Oi! Em que posso ajudar?"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(ok).toBe(1);
  });
});

describe("aiErrorDetail", () => {
  it("encurta e nunca leva chave", async () => {
    const { aiErrorDetail } = await import("../src/main/engine/engine");
    expect(aiErrorDetail(new Error("invalid x-api-key sk-ant-api03-abcdefghijklmnop"))).toBe("invalid x-api-key [chave]");
    expect(aiErrorDetail(new Error("x".repeat(300))).length).toBe(178);
  });
});
