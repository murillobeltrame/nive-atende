// 0.3.7: erro passageiro da IA não deixa o cliente sem resposta.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup } from "./helpers";
import { AiError, classifyAiError, type AiChatResult } from "../src/main/ai/openai";

const PHONE = "5521977772222";
const JID = `${PHONE}@s.whatsapp.net`;

describe("erro passageiro da IA", () => {
  for (const kind of ["rate_limit", "unavailable"] as const) {
    it(`${kind}: tenta de novo sozinho e responde quando a IA volta`, async () => {
      const t = setup();
      t.ai.error = new AiError("falha passageira", kind);
      await t.engine.handleInbound(inbound(PHONE, "oi, tem perfume?"));
      await t.clock.advance(5000);
      expect(t.wa.sent).toHaveLength(0);
      expect(t.store.listUnprocessed(JID)).toHaveLength(1);

      t.ai.error = null;
      t.ai.script(reply("Temos sim!"));
      await t.clock.advance(60_000);
      expect(t.wa.sent.map((s) => s.body)).toEqual(["Temos sim!"]);
      expect(t.store.listUnprocessed(JID)).toHaveLength(0);
      expect(t.store.getConversation(JID)!.state).toBe("ia");
    });
  }

  it("continua tentando, com intervalos maiores, enquanto a IA não volta", async () => {
    const t = setup();
    t.ai.error = new AiError("fora do ar", "unavailable");
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(20 * 60_000);
    const attempts = t.ai.attempts;
    expect(attempts).toBeGreaterThanOrEqual(5);
    expect(attempts).toBeLessThanOrEqual(12);
    t.ai.error = null;
    t.ai.script(reply("Oi!"));
    await t.clock.advance(6 * 60_000);
    expect(t.wa.sent.map((s) => s.body)).toEqual(["Oi!"]);
  });

  it("IA fora do ar por mais de 2 h: passa para humano em vez de responder atrasado", async () => {
    const t = setup();
    t.ai.error = new AiError("fora do ar", "unavailable");
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(3 * 3_600_000);
    expect(t.wa.sent).toHaveLength(0);
    expect(t.store.getConversation(JID)!.state).toBe("precisa_humano");
    const attempts = t.ai.attempts;
    await t.clock.advance(3_600_000);
    expect(t.ai.attempts).toBe(attempts); // parou de tentar
  });

  it("timeout e queda de conexão contam como falha passageira (sem pausar a conversa)", async () => {
    expect(classifyAiError(new Error("Request timed out.")).kind).toBe("unavailable");
    expect(classifyAiError(new Error("Connection error.")).kind).toBe("unavailable");
    expect(classifyAiError(new DOMException("The operation was aborted due to timeout", "TimeoutError")).kind).toBe("unavailable");
    expect(classifyAiError(new Error("read ECONNRESET")).kind).toBe("unavailable");

    const t = setup();
    t.ai.error = classifyAiError(new Error("Request timed out."));
    await t.engine.handleInbound(inbound(PHONE, "oi, tem perfume?"));
    await t.clock.advance(5000);
    const c = t.store.getConversation(JID)!;
    expect(c.state).toBe("ia");
    expect(c.aiPausedUntil).toBeNull();
    t.ai.error = null;
    t.ai.script(reply("Temos sim!"));
    await t.clock.advance(60_000);
    expect(t.wa.sent.map((s) => s.body)).toEqual(["Temos sim!"]);
  });

  it("a equipe respondeu enquanto a IA estava fora: não tenta mais", async () => {
    const t = setup();
    t.ai.error = new AiError("fora do ar", "unavailable");
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(5000);
    await t.engine.sendHumanText(JID, "Oi! Já te atendo.", "Ana");
    const attempts = t.ai.attempts;
    t.ai.error = null;
    await t.clock.advance(30 * 60_000);
    expect(t.ai.attempts).toBe(attempts);
    expect(t.wa.sent).toHaveLength(1);
  });

  it("áudio: falha passageira na transcrição também tenta de novo", async () => {
    const t = setup();
    t.ai.transcribeError = new AiError("fora do ar", "unavailable");
    await t.engine.handleInbound(inbound(PHONE, null, { kind: "audio", mimetype: "audio/ogg", durationSec: 5, base64: Buffer.from("x").toString("base64") }));
    await t.clock.advance(5000);
    expect(t.store.getConversation(JID)!.state).toBe("ia");
    t.ai.transcribeError = null;
    t.ai.script(reply("Temos sim!"));
    await t.clock.advance(60_000);
    expect(t.wa.sent.map((s) => s.body)).toEqual(["Temos sim!"]);
  });
});

describe("trava de segurança do atendimento", () => {
  it("atendimento travado é abandonado e a conversa volta a responder", async () => {
    const t = setup();
    const logs: string[] = [];
    t.onLog((level, msg) => logs.push(`${level} ${msg}`));
    t.ai.script((() => new Promise<AiChatResult>(() => undefined)) as never);
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(0);
    t.ai.script(reply("Oi! Desculpe a demora."));
    await t.clock.advance(7 * 60_000);
    expect(t.wa.sent.map((s) => s.body)).toEqual(["Oi! Desculpe a demora."]);
    expect(logs.some((l) => l.startsWith("error") && l.includes("travado"))).toBe(true);
  });

  it("resposta que chega depois de abandonada não é enviada em dobro", async () => {
    const t = setup();
    let release: (r: AiChatResult) => void = () => undefined;
    t.ai.script((() => new Promise<AiChatResult>((r) => (release = r))) as never);
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    t.ai.script(reply("Oi!"));
    await t.clock.advance(7 * 60_000);
    release(reply("Resposta atrasada"));
    await t.clock.advance(60_000);
    expect(t.wa.sent.map((s) => s.body)).toEqual(["Oi!"]);
  });

  it("erros do atendimento vão para o log, sem o texto das mensagens", async () => {
    const t = setup();
    const logs: string[] = [];
    t.onLog((level, msg, extra) => logs.push(`${level} ${msg} ${extra instanceof Error ? extra.message : ""}`));
    t.ai.error = new AiError("limite atingido", "rate_limit");
    await t.engine.handleInbound(inbound(PHONE, "mensagem secreta do cliente"));
    await t.clock.advance(5000);
    expect(logs.some((l) => l.includes("rate_limit"))).toBe(true);
    expect(logs.join("\n")).not.toContain("mensagem secreta");
  });
});
