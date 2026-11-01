// 0.3.2: "digitando…" do cliente no app e apagar conversa.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup } from "./helpers";
import { parseWebhook } from "../src/main/evolution/parse";

const PHONE = "5521966665555";
const JID = `${PHONE}@s.whatsapp.net`;

describe("cliente digitando", () => {
  it("avisa a interface quando o cliente digita, grava e para", () => {
    const t = setup();
    const seen: Array<string | null> = [];
    t.engine.on("typing", (e) => e.conversationId === JID && seen.push(e.state));
    t.engine.handleTyping(JID, "composing");
    t.engine.handleTyping(JID, "recording");
    t.engine.handleTyping(JID, "available");
    expect(seen).toEqual(["composing", "recording", null]);
  });

  it("Evolution: lê o presence.update do webhook", () => {
    const evs = parseWebhook({ event: "PRESENCE_UPDATE", data: { id: JID, presences: { [JID]: { lastKnownPresence: "composing" } } } });
    expect(evs).toEqual([{ type: "typing", jid: JID, state: "composing" }]);
    expect(parseWebhook({ event: "presence.update", data: { id: "1@g.us", presences: {} } })).toEqual([]);
  });
});

describe("apagar conversa", () => {
  it("apaga mensagens e a conversa; nova mensagem começa do zero", async () => {
    const t = setup();
    t.ai.script(reply("Oi! Como posso ajudar?"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(t.store.listMessages(JID).length).toBeGreaterThan(0);
    const deleted: string[] = [];
    t.engine.on("conversationDeleted", (id) => deleted.push(id));
    t.engine.deleteConversation(JID);
    expect(deleted).toEqual([JID]);
    expect(t.store.getConversation(JID)).toBeNull();
    expect(t.store.listMessages(JID)).toEqual([]);

    t.ai.script(reply("Olá de novo!"));
    await t.engine.handleInbound(inbound(PHONE, "voltei"));
    await t.clock.advance(2000);
    const c = t.store.getConversation(JID)!;
    expect(c.aiRepliesCount).toBe(1);
    expect(t.store.listMessages(JID).map((m) => m.text)).toEqual(["voltei", "Olá de novo!"]);
  });

  it("cancela a resposta que estava agendada", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    t.engine.deleteConversation(JID);
    await t.clock.advance(30_000);
    expect(t.wa.sent).toHaveLength(0);
  });
});
