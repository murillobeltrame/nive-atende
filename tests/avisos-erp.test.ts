// Avisos "aguardando ação" no Nive ERP e o toque na tela do Nive Atende quando ninguém viu lá.
import { describe, expect, it } from "vitest";
import { ActionAlertSync, LOCAL_ALARM_AFTER_MS } from "../src/main/action-alerts";
import type { ActionAlertInput, ActionAlertState } from "../src/main/nive/client";
import type { ActionAlarm } from "../src/shared/types";
import { inbound, reply, setup, toolCall } from "./helpers";

const PHONE = "5521977776666";

function fakeErp() {
  const alerts = new Map<string, ActionAlertState & { input: ActionAlertInput }>();
  return {
    alerts,
    online: true,
    async upsertActionAlert(input: ActionAlertInput) {
      if (!this.online) throw new Error("ERP fora");
      const prev = alerts.get(input.externalRef);
      alerts.set(input.externalRef, { externalRef: input.externalRef, status: "open", shownAt: prev?.status === "open" ? prev.shownAt : null, acknowledgedAt: null, input });
      return true;
    },
    async resolveActionAlert(_source: string, ref: string) {
      if (!this.online) throw new Error("ERP fora");
      const a = alerts.get(ref);
      if (a) a.status = "resolved";
    },
    async getActionAlerts(_source: string, refs: string[]) {
      if (!this.online) throw new Error("ERP fora");
      return refs.flatMap((r) => (alerts.has(r) ? [alerts.get(r)!] : []));
    },
  };
}

function build(t: ReturnType<typeof setup>, erp: ReturnType<typeof fakeErp>) {
  const rings: ActionAlarm[][] = [];
  const sync = new ActionAlertSync({ store: t.store, nive: erp, now: () => t.clock.t, log: () => undefined, onAlarm: (a) => rings.push(a) });
  return { sync, rings };
}

async function reservar(t: ReturnType<typeof setup>) {
  t.ai.script(toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Pedro Alves" }), reply("Separado!"));
  await t.engine.handleInbound(inbound(PHONE, "separa a bolsa"));
  await t.clock.advance(2000);
  return t.store.listReservations()[0]!;
}

describe("avisos aguardando ação no ERP", () => {
  it("reserva lançada abre aviso no ERP com o rascunho; finalizada encerra", async () => {
    const t = setup();
    const erp = fakeErp();
    const { sync } = build(t, erp);
    const r = await reservar(t);
    await sync.sync();
    const a = erp.alerts.get(`res:${r.id}`)!;
    expect(a.input).toMatchObject({ source: "nive_atende", kind: "reservation", saleId: r.saleId, title: "Reserva pelo WhatsApp para aceitar" });
    expect(a.input.message).toContain("Pedro Alves · 1× Bolsa");
    t.store.updateReservation(r.id, { status: "completed" });
    await sync.sync();
    expect(erp.alerts.get(`res:${r.id}`)!.status).toBe("resolved");
  });

  it("conversa em \"precisa de você\" abre aviso; alguém respondeu encerra", async () => {
    const t = setup();
    const erp = fakeErp();
    const { sync } = build(t, erp);
    t.ai.script(toolCall("transferir_para_humano", { motivo: "cliente quer falar com o dono" }), reply("Já chamo alguém."));
    await t.engine.handleInbound(inbound(PHONE, "quero falar com o dono"));
    await t.clock.advance(2000);
    const conv = t.store.listConversations("precisa")[0]!;
    await sync.sync();
    expect(erp.alerts.get(`conv:${conv.id}`)!.input).toMatchObject({ kind: "handoff", title: "Cliente aguardando alguém da loja" });
    t.store.updateConversation(conv.id, { state: "humano" });
    await sync.sync();
    expect(erp.alerts.get(`conv:${conv.id}`)!.status).toBe("resolved");
  });

  it("ninguém viu no ERP em 1 minuto: toca aqui; o ERP mostrou: para", async () => {
    const t = setup();
    const erp = fakeErp();
    const { sync, rings } = build(t, erp);
    const r = await reservar(t);
    await sync.sync();
    expect(rings.at(-1)).toEqual([]); // ainda dentro do prazo do ERP
    t.clock.t += LOCAL_ALARM_AFTER_MS;
    await sync.sync();
    expect(rings.at(-1)!.map((a) => a.ref)).toEqual([`res:${r.id}`]);
    erp.alerts.get(`res:${r.id}`)!.shownAt = new Date().toISOString();
    await sync.sync();
    expect(rings.at(-1)).toEqual([]);
  });

  it("ERP fora do ar: toca aqui avisando; \"Vou ver\" silencia", async () => {
    const t = setup();
    const erp = fakeErp();
    erp.online = false;
    const { sync, rings } = build(t, erp);
    const r = await reservar(t);
    await sync.sync();
    t.clock.t += LOCAL_ALARM_AFTER_MS;
    await sync.sync();
    expect(rings.at(-1)![0]).toMatchObject({ ref: `res:${r.id}`, erpOffline: true });
    sync.dismiss([`res:${r.id}`]);
    await sync.sync();
    expect(rings.at(-1)).toEqual([]);
  });
});
