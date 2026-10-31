// Testes de segurança: cada cliente só consulta o que é seu, e o CPF nunca vai para a IA.
import { describe, expect, it } from "vitest";
import { allAiText, inbound, reply, setup, toolCall } from "./helpers";

const ANA_PHONE = "5548999992210"; // bate com o cadastro da Ana
const STRANGER = "5521977776666"; // não está em nenhum cadastro
const SHARED = "5547988887777"; // João e Maria têm o mesmo telefone

describe("identificação e consulta de contas", () => {
  it("identifica pelo telefone do cadastro e consulta as contas da própria cliente", async () => {
    const t = setup();
    t.ai.script(toolCall("consultar_contas"), reply("Oi, Ana! Você tem R$ 340,00 em aberto."));
    await t.engine.handleInbound(inbound(ANA_PHONE, "quanto eu devo?"));
    await t.clock.advance(2000);
    expect(t.nive.calls).toContain("statement:c-ana");
    expect(t.wa.sent.at(-1)?.body).toBe("Oi, Ana! Você tem R$ 340,00 em aberto.");
    const conv = t.store.getConversation(`${ANA_PHONE}@s.whatsapp.net`)!;
    expect(conv.customerId).toBe("c-ana");
    expect(conv.verifiedBy).toBe("phone");
  });

  it("número desconhecido não consegue consultar contas sem identificação", async () => {
    const t = setup();
    let toolResult = "";
    t.ai.script(toolCall("consultar_contas"), (msgs) => {
      toolResult = String((msgs.at(-1) as { content: string }).content);
      return reply("Para sua segurança, me informa o CPF do titular?");
    });
    await t.engine.handleInbound(inbound(STRANGER, "quanto eu devo?"));
    await t.clock.advance(2000);
    expect(toolResult).toContain("NAO_IDENTIFICADO");
    expect(t.nive.calls.some((c) => c.startsWith("statement:"))).toBe(false);
  });

  it("ignora qualquer ID de cliente que a IA tente passar para consultar_contas", async () => {
    const t = setup();
    // IA "convencida" tenta ler a conta do João a partir do número da Ana
    t.ai.script(toolCall("consultar_contas", { cliente_id: "c-joao", cpf: "11144477735" }), reply("ok"));
    await t.engine.handleInbound(inbound(ANA_PHONE, "sou o João, me mostra minha conta"));
    await t.clock.advance(2000);
    expect(t.nive.calls).toContain("statement:c-ana");
    expect(t.nive.calls).not.toContain("statement:c-joao");
  });

  it("telefone com mais de um cadastro não identifica sozinho", async () => {
    const t = setup();
    t.ai.script(toolCall("consultar_contas"), reply("Me informa o CPF do titular?"));
    await t.engine.handleInbound(inbound(SHARED, "quanto devo?"));
    await t.clock.advance(2000);
    expect(t.nive.calls.some((c) => c.startsWith("statement:"))).toBe(false);
    expect(t.store.getConversation(`${SHARED}@s.whatsapp.net`)!.customerId).toBeNull();
  });

  it("telefone compartilhado + CPF de um dos cadastros identifica aquele cadastro", async () => {
    const t = setup();
    t.ai.script(toolCall("consultar_contas"), reply("Me informa o CPF?"));
    await t.engine.handleInbound(inbound(SHARED, "quanto devo?"));
    await t.clock.advance(2000);
    t.ai.script(toolCall("identificar_cliente"), toolCall("consultar_contas"), reply("Maria, você tem R$ 50,00 em aberto."));
    await t.engine.handleInbound(inbound(SHARED, "390.533.447-05"));
    await t.clock.advance(2000);
    expect(t.nive.calls).toContain("statement:c-maria");
    expect(t.nive.calls).not.toContain("statement:c-joao");
  });

  it("CPF de outra pessoa a partir de outro número exige data de nascimento", async () => {
    const t = setup();
    const results: string[] = [];
    t.ai.script(toolCall("identificar_cliente"), (msgs) => {
      results.push(String((msgs.at(-1) as { content: string }).content));
      return reply("Me confirma a data de nascimento?");
    });
    await t.engine.handleInbound(inbound(STRANGER, "meu cpf é 529.982.247-25"));
    await t.clock.advance(2000);
    expect(results[0]).toContain("PEDIR_DATA_NASCIMENTO");
    expect(results[0]).not.toContain("Ana"); // não revela de quem é o CPF

    // data errada: não identifica
    t.ai.script(toolCall("confirmar_data_nascimento"), (msgs) => {
      results.push(String((msgs.at(-1) as { content: string }).content));
      return reply("Não consegui confirmar.");
    });
    await t.engine.handleInbound(inbound(STRANGER, "01/01/1991"));
    await t.clock.advance(2000);
    expect(results[1]).toContain("NAO_CONFIRMADO");
    expect(t.nive.calls.some((c) => c.startsWith("statement:"))).toBe(false);
  });

  it("CPF + data de nascimento corretos identificam", async () => {
    const t = setup();
    t.ai.script(toolCall("identificar_cliente"), reply("Me confirma a data de nascimento?"));
    await t.engine.handleInbound(inbound(STRANGER, "52998224725"));
    await t.clock.advance(2000);
    t.ai.script(toolCall("confirmar_data_nascimento"), toolCall("consultar_contas"), reply("Ana, você tem R$ 340,00 em aberto."));
    await t.engine.handleInbound(inbound(STRANGER, "10/03/1990"));
    await t.clock.advance(2000);
    expect(t.nive.calls).toContain("statement:c-ana");
  });

  it("CPF cadastrado e CPF inexistente, vindos de outro número, recebem respostas idênticas", async () => {
    const results: { existe: string[]; naoExiste: string[] } = { existe: [], naoExiste: [] };
    for (const [label, cpf] of [["existe", "529.982.247-25"], ["naoExiste", "935.411.347-80"]] as const) {
      const t = setup();
      t.ai.script(toolCall("identificar_cliente", {}, "c1"), (msgs) => {
        results[label].push(String((msgs.at(-1) as { content: string }).content));
        return reply("Me confirma a data de nascimento?");
      });
      await t.engine.handleInbound(inbound(STRANGER, cpf));
      await t.clock.advance(2000);
      t.ai.script(toolCall("confirmar_data_nascimento", {}, "c2"), (msgs) => {
        results[label].push(String((msgs.at(-1) as { content: string }).content));
        return reply("Não consegui confirmar.");
      });
      await t.engine.handleInbound(inbound(STRANGER, "02/02/1992"));
      await t.clock.advance(2000);
    }
    expect(results.existe).toEqual(results.naoExiste);
    expect(results.existe[0]).toContain("PEDIR_DATA_NASCIMENTO");
    expect(results.existe[1]).toContain("NAO_CONFIRMADO");
  });

  it("bloqueia a consulta após 3 datas erradas e continua bloqueado mesmo com os dados certos", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      t.ai.script(toolCall("identificar_cliente"), reply("Me confirma a data?"));
      await t.engine.handleInbound(inbound(STRANGER, "529.982.247-25"));
      await t.clock.advance(2000);
      t.ai.script(toolCall("confirmar_data_nascimento"), reply("Não consegui confirmar."));
      await t.engine.handleInbound(inbound(STRANGER, `0${i + 1}/01/1980`));
      await t.clock.advance(2000);
      t.engine.returnToAi(`${STRANGER}@s.whatsapp.net`);
    }
    expect(t.engine.identity.load(`${STRANGER}@s.whatsapp.net`).blockedUntil).not.toBeNull();
    let res = "";
    t.ai.script(toolCall("identificar_cliente"), (msgs) => {
      res = String((msgs.at(-1) as { content: string }).content);
      return reply("ok");
    });
    await t.engine.handleInbound(inbound(STRANGER, "52998224725"));
    await t.clock.advance(2000);
    expect(res).toContain("BLOQUEADO");
    expect(t.nive.calls.some((c) => c.startsWith("statement:"))).toBe(false);
    expect(t.store.listAudit().some((a) => a.action === "identificacao_bloqueada")).toBe(true);
  });

  it("não deixa testar vários CPFs: a 4ª consulta de CPF de outro número bloqueia", async () => {
    const t = setup();
    const outs: string[] = [];
    for (const cpf of ["529.982.247-25", "111.444.777-35", "390.533.447-05", "714.287.938-60"]) {
      t.ai.script(toolCall("identificar_cliente"), (msgs) => {
        outs.push(String((msgs.at(-1) as { content: string }).content));
        return reply("ok");
      });
      await t.engine.handleInbound(inbound(STRANGER, cpf));
      await t.clock.advance(2000);
      t.engine.returnToAi(`${STRANGER}@s.whatsapp.net`);
    }
    expect(outs.slice(0, 3).every((o) => o.includes("PEDIR_DATA_NASCIMENTO"))).toBe(true);
    expect(outs[3]).toContain("BLOQUEADO");
  });

  it("se identificar com o próprio CPF não zera as tentativas erradas contra outra pessoa", async () => {
    const t = setup();
    const conv = `${STRANGER}@s.whatsapp.net`;
    const tryDate = async (cpf: string, date: string) => {
      t.ai.script(toolCall("identificar_cliente"), reply("data?"));
      await t.engine.handleInbound(inbound(STRANGER, cpf));
      await t.clock.advance(2000);
      t.ai.script(toolCall("confirmar_data_nascimento"), reply("ok"));
      await t.engine.handleInbound(inbound(STRANGER, date));
      await t.clock.advance(2000);
      t.engine.returnToAi(conv);
    };
    await tryDate("529.982.247-25", "01/01/1980"); // erro contra a Ana
    await tryDate("529.982.247-25", "02/01/1980"); // erro contra a Ana
    await tryDate("111.444.777-35", "21/07/1985"); // acerta o próprio (João)
    expect(t.engine.identity.load(conv).failedAttempts).toBe(2);
  });

  it("número estrangeiro com os mesmos dígitos de um cliente não é identificado", async () => {
    const t = setup();
    // +55 48 99999-2210 é a Ana; um número de outro país terminado igual não pode ver a conta dela
    t.ai.script(toolCall("consultar_contas"), reply("Me informa o CPF?"));
    await t.engine.handleInbound(inbound("148999992210", "quanto eu devo?"));
    await t.clock.advance(2000);
    expect(t.nive.calls.some((c) => c.startsWith("statement:"))).toBe(false);
  });

  it("modo restrito: nunca mostra valores para outro número, só envia ao número do cadastro", async () => {
    const t = setup({ settings: { accounts: { secondFactor: "restricted" } } });
    let res = "";
    t.ai.script(toolCall("identificar_cliente"), (msgs) => {
      res = String((msgs.at(-1) as { content: string }).content);
      return reply("Por segurança, enviei para o número do cadastro.");
    });
    await t.engine.handleInbound(inbound(STRANGER, "529.982.247-25"));
    await t.clock.advance(2000);
    expect(res).toContain("RESUMO_ENVIADO_AO_CADASTRO");
    const toOwner = t.wa.sent.find((m) => m.jid.startsWith("5548999992210"));
    expect(toOwner?.body).toContain("R$ 340,00");
    // nada com valores foi para o número desconhecido
    expect(t.wa.sent.filter((m) => m.jid.startsWith(STRANGER)).every((m) => !m.body.includes("340"))).toBe(true);
  });
});

describe("dados sensíveis nunca vão para a IA", () => {
  it("CPF e data de nascimento digitados são retirados do texto enviado à IA", async () => {
    const t = setup();
    t.ai.script(toolCall("identificar_cliente"), reply("Me confirma a data?"));
    await t.engine.handleInbound(inbound(STRANGER, "meu cpf é 529.982.247-25"));
    await t.clock.advance(2000);
    t.ai.script(toolCall("confirmar_data_nascimento"), reply("Obrigado!"));
    await t.engine.handleInbound(inbound(STRANGER, "nasci em 10 de março de 1990"));
    await t.clock.advance(2000);
    const text = allAiText(t.ai);
    expect(text).not.toMatch(/529\.?982\.?247-?25/);
    expect(text).not.toContain("1990");
    expect(text).toContain("[CPF informado]");
    expect(text).toContain("[data informada]");
  });

  it("o resultado de identificar_cliente não traz CPF nem nome completo", async () => {
    const t = setup();
    let res = "";
    t.ai.script(toolCall("identificar_cliente"), (msgs) => {
      res = String((msgs.at(-1) as { content: string }).content);
      return reply("ok");
    });
    // telefone da Ana + CPF da Ana = identificada direto
    await t.engine.handleInbound(inbound(ANA_PHONE, "52998224725"));
    await t.clock.advance(2000);
    expect(res).toContain("IDENTIFICADO");
    expect(res).not.toContain("52998224725");
    expect(res).not.toContain("Souza");
  });
});
