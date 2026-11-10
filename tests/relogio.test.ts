// 0.3.6: relógio do computador diferente do WhatsApp não bagunça a ordem nem o contexto da IA.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup } from "./helpers";
import { NiveClient } from "../src/main/nive/client";

const PHONE = "5521977771111";
const JID = `${PHONE}@s.whatsapp.net`;

/** Conversa "oi" → IA → resposta do cliente, com o relógio do PC deslocado em relação ao WhatsApp. */
async function conversa(skewMs: number, measured: boolean) {
  const t = setup();
  if (measured) t.nive.clockOffset = skewMs;
  // horário do WhatsApp = relógio real; o PC está "skewMs" adiantado (negativo = atrasado)
  const wa = () => t.clock.now() - skewMs;
  t.ai.script(reply("Boa tarde! Em que posso ajudar?"), reply("Temos sim, separo pra você?"));
  await t.engine.handleInbound(inbound(PHONE, "oi", { timestamp: wa() }));
  await t.clock.advance(2000);
  await t.clock.advance(40_000);
  await t.engine.handleInbound(inbound(PHONE, "tem o perfume azul?", { timestamp: wa() }));
  await t.clock.advance(2000);
  return t;
}

describe("relógio do computador diferente do WhatsApp", () => {
  for (const [label, skew, measured] of [
    ["atrasado 3 min", -3 * 60_000, true],
    ["adiantado 3 min", 3 * 60_000, true],
    ["adiantado 2 h", 2 * 3_600_000, true],
    ["atrasado 2 h", -2 * 3_600_000, true],
    ["atrasado 3 min, sem medir pela API", -3 * 60_000, false],
    ["adiantado 3 min, sem medir pela API", 3 * 60_000, false],
    ["certo", 0, true],
  ] as const) {
    it(`PC ${label}: mensagens na ordem e a IA vê o próprio cumprimento`, async () => {
      const t = await conversa(skew, measured);
      const texts = t.store.listMessages(JID).filter((m) => m.origin !== "sistema").map((m) => m.text);
      expect(texts).toEqual(["oi", "Boa tarde! Em que posso ajudar?", "tem o perfume azul?", "Temos sim, separo pra você?"]);
      const second = t.ai.received[1]!.filter((m) => m.role !== "system").map((m) => [m.role, m.content]);
      expect(second).toEqual([
        ["user", "oi"],
        ["assistant", "Boa tarde! Em que posso ajudar?"],
        ["user", "tem o perfume azul?"],
      ]);
    });
  }

  it("mensagem antiga recebida ao reconectar continua sendo tratada como antiga", async () => {
    const skew = -3 * 60_000;
    const t = setup();
    t.nive.clockOffset = skew;
    const wa = () => t.clock.now() - skew;
    t.ai.script(reply("Oi!"));
    await t.engine.handleInbound(inbound(PHONE, "oi", { timestamp: wa() }));
    await t.clock.advance(2000);
    // app desligado por 5 h; a mensagem foi enviada há 4 h e chega agora
    await t.clock.advance(5 * 3_600_000);
    await t.engine.handleInbound(inbound(PHONE, "ainda tem?", { timestamp: wa() - 4 * 3_600_000 }));
    await t.clock.advance(2000);
    expect(t.wa.sent.filter((s) => s.body === "Certo!")).toHaveLength(0);
    expect(t.store.getConversation(JID)!.state).toBe("precisa_humano");
  });

  it("empate de horário mantém a ordem de chegada", () => {
    const t = setup();
    const conv = t.store.ensureConversation(JID, PHONE, "Cliente");
    for (const text of ["a", "b", "c", "d"]) {
      t.store.insertMessage({ conversationId: conv.id, origin: "consumidor", kind: "text", text, status: "received", createdAt: 1000 });
    }
    expect(t.store.listMessages(JID).map((m) => m.text)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("medição do relógio pela API Nive", () => {
  it("calcula quanto o PC está adiantado pelo cabeçalho Date", async () => {
    let local = Date.parse("2026-11-10T15:03:00.000Z");
    const fetchImpl = (async () => {
      local += 200; // 200 ms de ida e volta
      return new Response("[]", { status: 200, headers: { date: "Wed, 10 Nov 2026 15:00:00 GMT" } });
    }) as unknown as typeof fetch;
    const c = new NiveClient(() => ({ baseUrl: "https://api.test", storeSlug: "loja", apiKey: "k" }), fetchImpl, () => local);
    expect(c.clockOffsetMs()).toBeNull();
    await c.testConnection();
    // PC 3 min adiantado (±1 s da precisão do cabeçalho)
    expect(Math.abs(c.clockOffsetMs()! - 180_000)).toBeLessThanOrEqual(1000);
  });

  it("guarda a última medida para usar ao abrir o app de novo", async () => {
    const t = setup();
    t.nive.clockOffset = 90_000;
    await t.engine.handleInbound(inbound(PHONE, "oi", { timestamp: t.clock.now() - 90_000 }));
    expect(t.store.getKv<number>("clock:offset")).toBe(90_000);
  });
});
