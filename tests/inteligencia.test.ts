// Foto do cliente, jeito da loja, marcar como lida e memória do cliente.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;

describe("a IA fica mais esperta", () => {
  it("vê a foto que o cliente mandou", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "tem esse?", { kind: "image", mimetype: "image/jpeg", base64: Buffer.from("JPEGDATA").toString("base64") }));
    await t.clock.advance(2000);
    const user = t.ai.received[0]!.find((m) => m.role === "user")!;
    expect(Array.isArray(user.content)).toBe(true);
    expect(JSON.stringify(user.content)).toContain("data:image/jpeg;base64,");
  });

  it("usa respostas reais da equipe como exemplo, sem valores", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    await t.engine.sendHumanText(JID, "Oii amore! Temos sim, chegou ontem e tá R$ 89,90, quer que eu separe? 💕", "Murillo");
    await t.engine.returnToAi(JID);
    await t.engine.handleInbound(inbound(PHONE, "tem batom?"));
    await t.clock.advance(2000);
    const system = String(t.ai.received.at(-1)![0]!.content);
    expect(system).toContain("JEITO DA LOJA");
    expect(system).toContain("Oii amore!");
    expect(system).not.toContain("89,90");
  });

  it("marca como lida as mensagens que vai responder", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi", { waMessageId: "LIDA1" }));
    await t.clock.advance(2000);
    expect(t.wa.read).toEqual(["LIDA1"]);
  });

  it("lembra preferências do cliente na próxima conversa", async () => {
    const t = setup();
    t.ai.script(toolCall("anotar_preferencia", { nota: "Veste M e gosta de cores claras" }), reply("Anotado! Vou te mostrar opções."));
    await t.engine.handleInbound(inbound(PHONE, "eu visto M e gosto de cores claras"));
    await t.clock.advance(2000);
    expect(t.engine.getCustomerNotes(JID)).toEqual(["Veste M e gosta de cores claras"]);
    await t.engine.handleInbound(inbound(PHONE, "chegou novidade?"));
    await t.clock.advance(2000);
    expect(String(t.ai.received.at(-1)![0]!.content)).toContain("Veste M e gosta de cores claras");
    expect(t.engine.removeCustomerNote(JID, "Veste M e gosta de cores claras")).toEqual([]);
  });

  it("não anota CPF ou números longos", async () => {
    const t = setup();
    t.ai.script(toolCall("anotar_preferencia", { nota: "telefone 48999998888" }), reply("Certo!"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(t.engine.getCustomerNotes(JID)).toEqual([]);
  });
});
