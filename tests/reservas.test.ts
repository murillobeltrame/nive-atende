// Reserva em nome do cliente: procura no cadastro, cadastra se for novo e cancela rascunho vencido.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";
import { cleanPersonName } from "../src/main/ai/tools";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;
const reserve = (nome: string) => toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: nome });

async function ask(t: ReturnType<typeof setup>, nome: string) {
  t.ai.script(reserve(nome), reply("Vou pedir para separarem e já confirmo."));
  await t.engine.handleInbound(inbound(PHONE, `pode separar em nome de ${nome}`));
  await t.clock.advance(2000);
  return t.store.listReservations()[0]!;
}

describe("reserva em nome do cliente", () => {
  it("cliente novo: vai direto para o sistema como rascunho, com cadastro (nome + telefone) e a conversa na observação", async () => {
    const t = setup();
    const r = await ask(t, "nathalia rocker beltrame");
    expect(r.status).toBe("created");
    expect(r.customerStatus).toBe("created_new");
    expect(r.customerName).toBe("Nathalia Rocker Beltrame");
    expect(t.nive.createdCustomers).toEqual([{ name: "Nathalia Rocker Beltrame", phone: "21977776666" }]);
    expect(t.nive.drafts[0]!.customerId).toBe("new-1");
    const notes = t.nive.drafts[0]!.notes;
    expect(notes).toContain("Reserva pelo WhatsApp (Nive Atende) · Nathalia Rocker Beltrame");
    expect(notes).toContain("Conversa:");
    expect(notes).toContain("Cliente: pode separar em nome de nathalia rocker beltrame");
    expect(t.store.listMessages(JID).some((m) => m.eventType === "reservation_pending")).toBe(false);
  });

  it("cliente já cadastrado com esse nome: vincula sem cadastrar de novo", async () => {
    const t = setup();
    const r = await ask(t, "Pedro Alves");
    expect(r.customerStatus).toBe("found_by_name");
    expect(t.nive.createdCustomers).toHaveLength(0);
    expect(t.nive.drafts[0]!.customerId).toBe("c-semdata");
  });

  it("vários clientes com o mesmo nome: não vincula a ninguém nem cadastra", async () => {
    const t = setup();
    t.nive.namedCustomers.push(
      { id: "x1", name: "Carla Dias", nickname: null, taxId: null, phone: "11900000001", birthDate: null },
      { id: "x2", name: "Carla Dias", nickname: null, taxId: null, phone: "11900000002", birthDate: null },
    );
    const r = await ask(t, "Carla Dias");
    expect(r.customerStatus).toBe("ambiguous");
    expect(t.nive.drafts[0]!.customerId).toBeNull();
    expect(t.nive.createdCustomers).toHaveLength(0);
  });

  it("limpa o nome informado", () => {
    expect(cleanPersonName("  MARIA DA SILVA 123 ")).toBe("Maria da Silva");
    expect(cleanPersonName("ok")).toBeNull();
  });
});

describe("reserva vencida", () => {
  it("cancela o rascunho no ERP se a venda não foi finalizada", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true, validityHours: 24 } } });
    const r = await ask(t, "Pedro Alves");
    expect(r.status).toBe("created");
    t.clock.t += 23 * 3_600_000;
    await t.engine.sweepExpiredReservations();
    expect(t.nive.cancelled).toHaveLength(0);
    t.clock.t += 2 * 3_600_000;
    await t.engine.sweepExpiredReservations();
    expect(t.nive.cancelled).toEqual([r.saleId]);
    expect(t.store.getReservation(r.id)!.status).toBe("expired");
    expect(t.store.listMessages(JID).some((m) => m.eventType === "reservation_expired")).toBe(true);
  });

  it("não mexe em venda já finalizada", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true, validityHours: 24 } } });
    const r = await ask(t, "Pedro Alves");
    t.nive.saleStatus[r.saleId!] = "COMPLETED";
    t.clock.t += 25 * 3_600_000;
    await t.engine.sweepExpiredReservations();
    expect(t.nive.cancelled).toHaveLength(0);
    expect(t.store.getReservation(r.id)!.status).toBe("completed");
  });

  it("rascunho excluído ou cancelado no sistema: o cliente é avisado", async () => {
    const t = setup();
    const r = await ask(t, "Pedro Alves");
    t.nive.saleStatus[r.saleId!] = "DRAFT_CANCELLED";
    await t.engine.syncReservationsWithErp();
    expect(t.store.getReservation(r.id)!.status).toBe("removed");
    expect(t.wa.sent.at(-1)!.body).toContain("não conseguiu manter *Bolsa");
    const sent = t.wa.sent.length;
    await t.engine.syncReservationsWithErp(); // não avisa de novo
    expect(t.wa.sent.length).toBe(sent);
  });

  it("respeita a opção de não cancelar rascunhos", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true, validityHours: 24, cancelExpiredDrafts: false } } });
    const r = await ask(t, "Pedro Alves");
    t.clock.t += 25 * 3_600_000;
    await t.engine.sweepExpiredReservations();
    expect(t.nive.cancelled).toHaveLength(0);
    expect(t.store.getReservation(r.id)!.status).toBe("created");
  });
});

import { NiveClient } from "../src/main/nive/client";

describe("API Nive: clientes e rascunhos", () => {
  function client(routes: Record<string, unknown>) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.test", "");
      calls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${init.method} ${path.split("?")[0]}`;
      const data = routes[key];
      if (data === undefined) return new Response(JSON.stringify({ error: "x" }), { status: 404 });
      return new Response(JSON.stringify(data), { status: 200 });
    }) as unknown as typeof fetch;
    return { c: new NiveClient(() => ({ baseUrl: "https://api.test", storeSlug: "loja", apiKey: "k" }), fetchImpl), calls };
  }

  it("busca por nome exato (ignora acentos) e cadastra com telefone", async () => {
    const { c, calls } = client({
      "GET /customers": [{ id: "1", name: "Nathália Rocker Beltrame" }, { id: "2", name: "Nathalia Rocker" }],
      "POST /customers": { id: "9", name: "Nathalia Rocker Beltrame" },
    });
    expect((await c.findCustomersByName("nathalia rocker beltrame")).map((x) => x.id)).toEqual(["1"]);
    await c.createCustomer({ name: "Nathalia Rocker Beltrame", phone: "48920025980" });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/customers", body: { name: "Nathalia Rocker Beltrame", phone: "48920025980" } });
  });

  it("cancela só rascunho; venda finalizada fica como está", async () => {
    const draft = client({ "GET /sales/s1": { id: "s1", status: "DRAFT" }, "POST /sales/s1/cancel-draft": { id: "s1", status: "DRAFT_CANCELLED" } });
    expect(await draft.c.cancelDraftSale("s1", "venceu")).toBe("cancelled");
    expect(draft.calls.at(-1)).toMatchObject({ method: "POST", path: "/sales/s1/cancel-draft", body: { reason: "venceu" } });
    const done = client({ "GET /sales/s1": { id: "s1", status: "COMPLETED" } });
    expect(await done.c.cancelDraftSale("s1", "venceu")).toBe("not_draft");
    expect(done.calls).toHaveLength(1);
    expect(await client({}).c.cancelDraftSale("s1", "x")).toBe("not_found");
  });
});

describe("reserva acompanhada no ERP", () => {
  it("rascunho finalizado vira Finalizada; excluído ou cancelado vira Removida", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    const a = await ask(t, "Pedro Alves");
    t.nive.saleStatus[a.saleId!] = "COMPLETED";
    await t.engine.sweepExpiredReservations();
    await t.engine.syncReservationsWithErp();
    expect(t.store.getReservation(a.id)).toMatchObject({ status: "completed", orderNumber: 777 });

    const t2 = setup({ settings: { reservation: { autoEnabled: true } } });
    const b = await ask(t2, "Pedro Alves");
    t2.nive.saleStatus[b.saleId!] = "GONE";
    await t2.engine.syncReservationsWithErp();
    expect(t2.store.getReservation(b.id)!.status).toBe("removed");

    const t3 = setup({ settings: { reservation: { autoEnabled: true } } });
    const c = await ask(t3, "Pedro Alves");
    t3.nive.saleStatus[c.saleId!] = "DRAFT_CANCELLED";
    await t3.engine.syncReservationsWithErp();
    expect(t3.store.getReservation(c.id)!.status).toBe("removed");
  });

  it("rascunho ainda aberto continua como está", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    const a = await ask(t, "Pedro Alves");
    await t.engine.syncReservationsWithErp();
    expect(t.store.getReservation(a.id)!.status).toBe("created");
  });
});

describe("cancelar reserva pelo app", () => {
  it("cancela o rascunho no ERP e marca como Cancelada", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    const r = await ask(t, "Pedro Alves");
    const out = await t.engine.cancelReservation(r.id);
    expect(out.status).toBe("cancelled");
    expect(t.nive.cancelled).toEqual([r.saleId]);
    expect(t.store.listMessages(JID).some((m) => m.text?.includes("Reserva cancelada pela loja"))).toBe(true);
  });

  it("não cancela venda já finalizada", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    const r = await ask(t, "Pedro Alves");
    t.nive.saleStatus[r.saleId!] = "COMPLETED";
    await expect(t.engine.cancelReservation(r.id)).rejects.toThrow(/já foi finalizada/);
    expect(t.store.getReservation(r.id)!.status).toBe("completed");
  });
});

describe("cliente desiste da reserva", () => {
  const cancel = (id = "") => toolCall("cancelar_reserva", { reserva_id: id });

  it("reserva já aprovada: cancela o rascunho no ERP e o estoque volta", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    const r = await ask(t, "Pedro Alves");
    expect(r.status).toBe("created");
    t.ai.script(cancel(), reply("Tudo bem, cancelei por aqui. Se mudar de ideia é só chamar!"));
    await t.engine.handleInbound(inbound(PHONE, "desisti, não quero mais"));
    await t.clock.advance(2000);
    expect(t.store.getReservation(r.id)!.status).toBe("cancelled");
    expect(t.nive.cancelled).toEqual([r.saleId]);
    const evt = t.store.listMessages(JID).find((m) => m.text?.includes("Cliente desistiu da reserva"))!;
    expect(evt.text).toContain("estoque voltou");
  });

  it("venda já finalizada: passa para a equipe", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    const r = await ask(t, "Pedro Alves");
    t.nive.saleStatus[r.saleId!] = "COMPLETED";
    t.ai.script(cancel(), toolCall("transferir_para_humano", { motivo: "cliente desistiu, cancelar venda já finalizada" }), reply("A equipe já vê isso com você."));
    await t.engine.handleInbound(inbound(PHONE, "não quero mais"));
    await t.clock.advance(2000);
    expect(t.store.getConversation(JID)!.state).toBe("precisa_humano");
  });

  it("só cancela reservas desta conversa", async () => {
    const t = setup({ settings: { reservation: { autoEnabled: true } } });
    const r = await ask(t, "Pedro Alves");
    t.ai.script(toolCall("cancelar_reserva", { reserva_id: "outra" }), reply("Qual delas?"));
    await t.engine.handleInbound(inbound(PHONE, "cancela"));
    await t.clock.advance(2000);
    expect(t.store.getReservation(r.id)!.status).toBe("created");
  });
});

describe("prazo da reserva na mensagem", () => {
  it("informa até quando fica reservado quando ligado", async () => {
    const t = setup();
    let toolResult = "";
    t.ai.script(reserve("Pedro Alves"), (msgs) => {
      toolResult = String(msgs.at(-1)!.content);
      return reply("Separado!");
    });
    await t.engine.handleInbound(inbound(PHONE, "separa pra mim"));
    await t.clock.advance(2000);
    expect(toolResult).toContain("valido_ate");
  });

  it("não informa o prazo quando desligado (nem para a IA)", async () => {
    const t2 = setup({ settings: { reservation: { showDeadline: false, autoEnabled: true } } });
    let toolResult = "";
    t2.ai.script(reserve("Pedro Alves"), (msgs) => {
      toolResult = String(msgs.at(-1)!.content);
      return reply("Separado!");
    });
    await t2.engine.handleInbound(inbound(PHONE, "separa pra mim"));
    await t2.clock.advance(2000);
    expect(toolResult).toContain("RESERVADO");
    expect(toolResult).not.toContain("valido_ate");
  });
});

describe("nome parecido com cadastro existente", () => {
  const aliny = { id: "c-aliny", name: "ALINY ROCKER BELTRAME", nickname: null, taxId: null, phone: "48911112222", birthDate: null };

  it("só o primeiro nome: a IA pede nome e sobrenome antes de reservar", async () => {
    const t = setup();
    let out = "";
    t.ai.script(reserve("Aliny"), (msgs) => {
      out = String(msgs.at(-1)!.content);
      return reply("Me passa seu nome completo?");
    });
    await t.engine.handleInbound(inbound(PHONE, "separa pra mim"));
    await t.clock.advance(2000);
    expect(out).toContain("PRECISA_NOME_COMPLETO");
    expect(t.store.listReservations()).toHaveLength(0);
  });

  it("nome parecido: rascunho sai sem cliente e sem cadastrar ninguém (o lojista confere pela observação)", async () => {
    const t = setup();
    t.nive.namedCustomers.push(aliny);
    const r = await ask(t, "Aliny Rocker");
    expect(r.status).toBe("created");
    expect(r.customerStatus).toBe("confirm");
    expect(t.nive.drafts[0]!.customerId).toBeNull();
    expect(t.nive.drafts[0]!.notes).toContain("Aliny Rocker");
    expect(t.nive.createdCustomers).toHaveLength(0);
  });

  it("não é nenhum dos parecidos: cadastra como cliente novo", async () => {
    const t = setup();
    t.nive.namedCustomers.push(aliny);
    const r = await ask(t, "Aliny Souza");
    expect(r.customerStatus).toBe("created_new"); // "Souza" não bate com Aliny Rocker Beltrame
    expect(t.nive.createdCustomers).toEqual([{ name: "Aliny Souza", phone: "21977776666" }]);
  });
});
