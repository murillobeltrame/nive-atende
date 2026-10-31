// Novidades da 0.2.4: catálogo com estoque, foto visível no app, apagar para todos, contexto e histórico.
import { describe, expect, it } from "vitest";
import { inbound, reply, setup, toolCall } from "./helpers";
import { parseRevoke, parseWebhook } from "../src/main/evolution/parse";
import { buildSystemPrompt } from "../src/main/ai/prompt";
import { DEFAULT_SETTINGS } from "../src/main/settings";

const PHONE = "5521977776666";
const JID = `${PHONE}@s.whatsapp.net`;

describe("vendedor", () => {
  it("busca devolve só itens com estoque e lista esgotados à parte", async () => {
    const t = setup();
    let result: Record<string, unknown> | null = null;
    t.ai.script(toolCall("buscar_produto", { termo: "tênis bolsa" }), (msgs) => {
      result = JSON.parse(String(msgs.at(-1)!.content));
      return reply("Tenho opções sim!");
    });
    await t.engine.handleInbound(inbound(PHONE, "o que tem?"));
    await t.clock.advance(2000);
    const r = result as unknown as { produtos: Array<{ produto_id: string; variacoes: Array<{ nome: string }> }> };
    const tenis = r.produtos.find((p) => p.produto_id === "p-tenis")!;
    // a variação 41 (estoque 0) não aparece
    expect(tenis.variacoes.map((v) => v.nome)).toEqual(["40"]);
  });

  it("prompt traz as orientações de venda e o contexto do lojista", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.personality.context = "Somos uma perfumaria; destaque os kits para presente.";
    const p = buildSystemPrompt({ settings: s, now: new Date(), identity: null, awaitingBirthDate: false, blocked: false });
    expect(p).toContain("COMO VENDER");
    expect(p).toContain("destaque os kits para presente");
    expect(p.indexOf("REGRAS QUE NUNCA MUDAM")).toBeLessThan(p.indexOf("destaque os kits"));
  });

  it("IA lê a conversa inteira até o limite configurado", async () => {
    const t = setup({ settings: { ai: { historyMessages: 30 } } });
    for (let i = 0; i < 12; i++) {
      await t.engine.handleInbound(inbound(PHONE, `mensagem ${i}`, { waMessageId: `HIST${i}` }));
      await t.clock.advance(2000);
    }
    const last = t.ai.received.at(-1)!;
    const texts = last.map((m) => String(m.content));
    expect(texts.some((c) => c.includes("mensagem 0"))).toBe(true);
    expect(texts.some((c) => c.includes("mensagem 11"))).toBe(true);
  });
});

describe("foto enviada pela IA", () => {
  it("fica salva e visível na conversa do app", async () => {
    const t = setup();
    t.ai.script(toolCall("buscar_produto", { termo: "bolsa" }), toolCall("mostrar_foto_produto", { produto_id: "p-bolsa" }), reply("Olha ela aqui! R$ 159,90."));
    await t.engine.handleInbound(inbound(PHONE, "tem bolsa?"));
    await t.clock.advance(2000);
    const img = t.store.listMessages(JID).find((m) => m.kind === "image" && m.origin === "ia")!;
    expect(img.hasMedia).toBe(true);
    expect(img.status).toBe("sent");
    expect(Buffer.from(t.store.getMedia(img.id)!.data).toString()).toBe("PNGDATA");
    // o mesmo arquivo baixado vai para o cliente
    expect(t.wa.sent.find((s) => s.type === "media")!.body).toBe(Buffer.from("PNGDATA").toString("base64"));
  });
});

describe("apagar para todos", () => {
  it("apaga mensagem da loja no WhatsApp e marca como apagada", async () => {
    const t = setup();
    t.ai.script(reply("Oi! Em que posso ajudar?"));
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    await t.clock.advance(2000);
    const ia = t.store.listMessages(JID).find((m) => m.origin === "ia")!;
    const r = await t.engine.deleteMessage(ia.id);
    expect(r.status).toBe("deleted");
    expect(t.wa.deleted).toEqual([{ jid: JID, id: ia.waMessageId }]);
  });

  it("não apaga mensagem do cliente", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "oi"));
    const cli = t.store.listMessages(JID)[0]!;
    await expect(t.engine.deleteMessage(cli.id)).rejects.toThrow(/enviadas pela loja/);
    expect(t.wa.deleted).toHaveLength(0);
  });

  it("mensagem apagada pelo cliente aparece como apagada e sai do histórico da IA", async () => {
    const t = setup();
    await t.engine.handleInbound(inbound(PHONE, "texto que vou apagar", { waMessageId: "CLI1" }));
    t.engine.handleRevoke("5500000000000@s.whatsapp.net", "CLI1"); // outra conversa: ignora
    expect(t.store.getMessageByWaId("CLI1")!.status).toBe("received");
    t.engine.handleRevoke(JID, "CLI1");
    expect(t.store.getMessageByWaId("CLI1")!.status).toBe("deleted");
  });

  it("reconhece o aviso de mensagem apagada (Baileys e Evolution)", () => {
    const raw = { key: { remoteJid: JID, fromMe: false, id: "P1" }, message: { protocolMessage: { type: 0, key: { id: "CLI1" } } } };
    expect(parseRevoke(raw)).toEqual({ type: "revoke", remoteJid: JID, waMessageId: "CLI1" });
    expect(parseRevoke({ key: { remoteJid: JID, id: "X" }, message: { protocolMessage: { type: 14, key: { id: "Y" } } } })).toBeNull();
    expect(parseWebhook({ event: "messages.upsert", data: raw })).toEqual([{ type: "revoke", remoteJid: JID, waMessageId: "CLI1" }]);
    expect(parseWebhook({ event: "MESSAGES_DELETE", data: { id: "CLI1", remoteJid: JID } })).toEqual([{ type: "revoke", remoteJid: JID, waMessageId: "CLI1" }]);
  });
});

import { prettyName, toWhatsApp } from "../src/main/ai/format";

describe("formatação das mensagens", () => {
  it("deixa nomes em CAIXA ALTA legíveis", () => {
    expect(prettyName("PERFUME CONNOISSEUR WOMAN ARMAF 100 ML FEMININO")).toBe("Perfume Connoisseur Woman Armaf 100 ml Feminino");
    expect(prettyName("PERFUME ÁRABE DELILAH BLANC DE MAISON ALHAMBRA 100ML")).toBe("Perfume Árabe Delilah Blanc de Maison Alhambra 100ml");
    expect(prettyName("Tênis Runner preto")).toBe("Tênis Runner preto");
  });

  it("converte Markdown para a formatação do WhatsApp", () => {
    expect(toWhatsApp("## Opções\n- **Perfume A** — R$ 10,00\n\n\n\n- [site](https://x.com)")).toBe("*Opções*\n• *Perfume A* — R$ 10,00\n\n• site https://x.com");
  });
});

describe("digitando…", () => {
  it("mostra 'digitando' enquanto a IA busca e para depois de responder", async () => {
    const t = setup();
    let presenceWhileThinking: string[] = [];
    t.ai.script(toolCall("buscar_produto", { termo: "bolsa" }), () => {
      presenceWhileThinking = [...t.wa.presence];
      return reply("Tenho sim! R$ 159,90.");
    });
    await t.engine.handleInbound(inbound(PHONE, "tem bolsa?"));
    await t.clock.advance(2000);
    expect(presenceWhileThinking).toEqual(["composing"]);
    expect(t.wa.presence.at(-1)).toBe("paused");
    expect(t.wa.sent).toHaveLength(1);
  });
});
