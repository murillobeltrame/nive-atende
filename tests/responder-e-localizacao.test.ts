// Botão "Responder com a IA" e localização da loja (pino no WhatsApp + leitura do link do Maps).
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";
import { parseCoords, project, resolveLocation } from "../src/main/maps";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;

describe("Responder com a IA", () => {
  it("responde mensagem antiga que chegou com o programa fechado", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "tem bolsa?", { timestamp: t.clock.now() - 5 * 3600_000 }));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(0);
    t.ai.script(reply("Tenho sim! Desculpa a demora."));
    const r = await t.engine.replyNow(JID);
    expect(r.sent).toBe(true);
    expect(t.wa.sent).toHaveLength(1);
  });

  it("passa por cima da pausa de quando a equipe assumiu", async () => {
    const t = setup();
    t.ai.script(reply("Oi!"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    t.engine.takeOver(JID, "Ana");
    await t.engine.handleInbound(inbound(PHONE, "tem bolsa?"));
    await t.clock.advance(2000);
    expect(t.wa.sent).toHaveLength(1);
    t.ai.script(reply("Tenho sim!"));
    const r = await t.engine.replyNow(JID);
    expect(r.sent).toBe(true);
    expect(t.wa.sent).toHaveLength(2);
    expect(t.store.getConversation(JID)!.aiPausedUntil).toBeNull();
  });

  it("fora do horário e com o atendimento desligado também responde quando o lojista pede", async () => {
    const t = setup({ settings: { attendance: { autoEnabled: false } } });
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    t.ai.script(reply("Oi! Em que posso ajudar?"));
    const r = await t.engine.replyNow(JID);
    expect(r.sent).toBe(true);
  });

  it("última mensagem já é da loja: avisa em vez de responder de novo", async () => {
    const t = setup();
    t.ai.script(reply("Oi! Em que posso ajudar?"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    await expect(t.engine.replyNow(JID)).rejects.toThrow(/última mensagem já é da loja/);
  });
});

describe("localização da loja", () => {
  const withLocation = { location: { name: "Loja Exemplo", address: "Rua A, 10", latitude: -27.5954, longitude: -48.548 } };

  it("a IA manda o pino quando o cliente pergunta onde fica", async () => {
    const t = setup({ settings: withLocation });
    t.ai.script(toolCall("enviar_localizacao", {}), reply("Fica na Rua A, 10, no Centro!"));
    await t.engine.handleInbound(inbound(PHONE, "onde fica a loja?"));
    await t.clock.advance(2000);
    expect(t.wa.sent.map((s) => s.type)).toEqual(["text", "location"]);
    const loc = t.store.listMessages(JID).find((m) => m.kind === "location")!;
    expect(loc.origin).toBe("ia");
    expect(loc.geo).toEqual({ lat: -27.5954, lng: -48.548 });
  });

  it("sem localização cadastrada a ferramenta nem aparece", async () => {
    const t = setup();
    t.ai.script(reply("Oi!"));
    await t.engine.handleInbound(inbound(PHONE, "onde fica?"));
    await t.clock.advance(2000);
    expect(t.ai.toolsSeen[0]).not.toContain("enviar_localizacao");
  });

  it("botão da equipe envia o pino e pausa a IA como resposta humana", async () => {
    const t = setup({ settings: withLocation });
    await t.engine.handleInbound(inbound(PHONE, "onde fica?"));
    const m = await t.engine.sendStoreLocation(JID, "humano", "Ana");
    expect(m.origin).toBe("humano_app");
    expect(m.geo).toEqual({ lat: -27.5954, lng: -48.548 });
    expect(t.wa.sent.some((s) => s.type === "location")).toBe(true);
  });
});

describe("link do Google Maps", () => {
  it("lê coordenadas de vários formatos", () => {
    expect(parseCoords("-27.5954, -48.5480")).toEqual({ lat: -27.5954, lng: -48.548 });
    expect(parseCoords("-27,5954; -48,5480")).toEqual({ lat: -27.5954, lng: -48.548 });
    expect(parseCoords("https://www.google.com/maps/place/Loja/@-27.59,-48.54,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-27.5954!4d-48.548")).toEqual({ lat: -27.5954, lng: -48.548 });
    expect(parseCoords("https://maps.google.com/?q=-27.5954,-48.548")).toEqual({ lat: -27.5954, lng: -48.548 });
    expect(parseCoords("Rua das Flores")).toBeNull();
  });

  it("segue o link curto até achar as coordenadas", async () => {
    const fake = (async (url: string) => {
      if (url.includes("goo.gl")) return new Response(null, { status: 302, headers: { location: "https://www.google.com/maps/place/X/@-27.5,-48.5,17z/data=!3d-27.5954!4d-48.548" } });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await resolveLocation("https://maps.app.goo.gl/abc123", fake)).toEqual({ lat: -27.5954, lng: -48.548 });
  });

  it("projeta o ponto no mapa", () => {
    const p = project({ lat: 0, lng: 0 }, 1);
    expect(p).toEqual({ x: 256, y: 256 });
  });
});
