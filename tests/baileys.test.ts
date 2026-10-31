// WhatsApp embutido: testa a ponte com o Baileys usando um socket falso.
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaileysService } from "../src/main/whatsapp/baileys";
import type { EvolutionEvent } from "../src/main/evolution/parse";

class FakeSock {
  ev = new EventEmitter();
  sent: Array<{ jid: string; content: Record<string, unknown> }> = [];
  ended = false;
  async sendMessage(jid: string, content: Record<string, unknown>) {
    this.sent.push({ jid, content });
    return { key: { id: `SENT${this.sent.length}`, remoteJid: jid, fromMe: true } };
  }
  async sendPresenceUpdate() {}
  async logout() {}
  end() {
    this.ended = true;
  }
  updateMediaMessage = async () => ({});
  pairedWith: string | null = null;
  async requestPairingCode(phone: string) {
    this.pairedWith = phone;
    return "K7PQ2M9X";
  }
}

function fakeModule() {
  const sockets: FakeSock[] = [];
  const creds = { registered: false };
  const mod = {
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    useMultiFileAuthState: async () => ({ state: { creds, keys: {} }, saveCreds: async () => {} }),
    makeCacheableSignalKeyStore: (k: unknown) => k,
    makeWASocket: () => {
      const s = new FakeSock();
      sockets.push(s);
      return s;
    },
    downloadMediaMessage: async () => Buffer.from("midia"),
  };
  return { mod, sockets, creds };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wa-"));
  const f = fakeModule();
  const events: EvolutionEvent[] = [];
  const svc = new BaileysService({ authDir: join(dir, "auth"), toOggOpus: async (b) => b, load: async () => f.mod as never });
  svc.onEvents((e) => events.push(...e));
  return { svc, events, ...f, dir };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const nowSec = () => Math.floor(Date.now() / 1000);

describe("WhatsApp embutido (Baileys)", () => {
  it("gera QR Code como imagem e avisa quando conecta", async () => {
    const t = setup();
    const pending = t.svc.connect();
    await tick();
    t.sockets[0]!.ev.emit("connection.update", { qr: "2@abc,def,ghi" });
    const r = await pending;
    expect(r.state).toBe("connecting");
    expect(r.qrBase64).toMatch(/^data:image\/png;base64,/);
    t.sockets[0]!.ev.emit("connection.update", { connection: "open" });
    await tick();
    expect(await t.svc.connectionState()).toBe("open");
    expect(t.events.some((e) => e.type === "connection" && e.state === "open")).toBe(true);
  });

  it("entrega mensagens novas do cliente, já com a mídia baixada", async () => {
    const t = setup();
    void t.svc.connect();
    await tick();
    t.sockets[0]!.ev.emit("connection.update", { connection: "open" });
    t.sockets[0]!.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: { remoteJid: "5548999992210@s.whatsapp.net", fromMe: false, id: "M1" }, pushName: "Ana", messageTimestamp: { toNumber: () => nowSec() }, message: { conversation: "oi" } },
        { key: { remoteJid: "5548999992210@s.whatsapp.net", fromMe: false, id: "M2" }, messageTimestamp: nowSec(), message: { audioMessage: { seconds: 5, mimetype: "audio/ogg; codecs=opus", fileLength: 1000 } } },
      ],
    });
    await tick();
    const msgs = t.events.filter((e) => e.type === "message");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ waMessageId: "M1", text: "oi", phone: "5548999992210", pushName: "Ana" });
    expect(msgs[1]).toMatchObject({ kind: "audio", base64: Buffer.from("midia").toString("base64") });
  });

  it("aceita resposta recente enviada pelo celular e ignora histórico", async () => {
    const t = setup();
    void t.svc.connect();
    await tick();
    const sock = t.sockets[0]!;
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        { key: { remoteJid: "5548999992210@s.whatsapp.net", fromMe: true, id: "P1" }, messageTimestamp: nowSec(), message: { conversation: "respondi pelo celular" } },
        { key: { remoteJid: "5548999992210@s.whatsapp.net", fromMe: true, id: "OLD" }, messageTimestamp: nowSec() - 86400, message: { conversation: "antiga" } },
        { key: { remoteJid: "5548999992210@s.whatsapp.net", fromMe: false, id: "OLD2" }, messageTimestamp: nowSec(), message: { conversation: "histórico do cliente" } },
      ],
    });
    await tick();
    const ids = t.events.filter((e) => e.type === "message").map((e) => (e as { waMessageId: string }).waMessageId);
    expect(ids).toEqual(["P1"]);
  });

  it("envia texto, mídia por URL e áudio como mensagem de voz", async () => {
    const t = setup();
    void t.svc.connect();
    await tick();
    t.sockets[0]!.ev.emit("connection.update", { connection: "open" });
    const r = await t.svc.sendText("5548999992210@s.whatsapp.net", "olá");
    expect(r.waMessageId).toBe("SENT1");
    await t.svc.sendMedia("5548999992210@s.whatsapp.net", { mediatype: "image", mimetype: "image/jpeg", media: "https://cdn/x.jpg", caption: "" });
    await t.svc.sendAudio("5548999992210@s.whatsapp.net", Buffer.from("webm").toString("base64"));
    const sent = t.sockets[0]!.sent;
    expect(sent[1]!.content).toMatchObject({ image: { url: "https://cdn/x.jpg" } });
    expect(sent[2]!.content).toMatchObject({ mimetype: "audio/ogg; codecs=opus", ptt: true });
  });

  it("não envia nada com o WhatsApp desconectado", async () => {
    const t = setup();
    await expect(t.svc.sendText("5548999992210@s.whatsapp.net", "x")).rejects.toThrow(/não está conectado/);
  });

  it("desconectado pelo celular: apaga a sessão e pede QR de novo", async () => {
    const t = setup();
    void t.svc.connect();
    await tick();
    const auth = join(t.dir, "auth");
    writeFileSync(join(auth, "creds.json"), "{}");
    t.sockets[0]!.ev.emit("connection.update", { connection: "open" });
    t.sockets[0]!.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await tick();
    expect(existsSync(join(auth, "creds.json"))).toBe(false);
    expect(await t.svc.connectionState()).toBe("close");
  });

  it("reconecta sozinho ao abrir o app quando já existe sessão", async () => {
    const t = setup();
    const auth = join(t.dir, "auth");
    await import("node:fs").then((fs) => fs.mkdirSync(auth, { recursive: true }));
    writeFileSync(join(auth, "creds.json"), "{}");
    await t.svc.start();
    expect(t.sockets).toHaveLength(1);
  });

  it("depois de ler o QR (reinício 515) não avisa queda: segue conectando", async () => {
    const t = setup();
    void t.svc.connect();
    await tick();
    t.sockets[0]!.ev.emit("connection.update", { qr: "2@x" });
    await tick();
    t.events.length = 0;
    t.sockets[0]!.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await tick();
    expect(t.events.some((e) => e.type === "connection" && e.state === "close")).toBe(false);
    expect(t.sockets).toHaveLength(2); // reabriu
  });

  it("para de gerar QR depois de vários sem leitura e avisa que expirou", async () => {
    const t = setup();
    void t.svc.connect();
    await tick();
    for (let i = 0; i < 7; i++) t.sockets[0]!.ev.emit("connection.update", { qr: `2@q${i}` });
    await tick();
    expect(t.sockets[0]!.ended).toBe(true);
    expect(t.events.some((e) => e.type === "qr" && e.qrBase64 === null)).toBe(true);
  });

  it("gera código para conectar com número de telefone", async () => {
    const t = setup();
    const p = t.svc.pairingCode("55 (48) 99999-2210");
    await tick();
    t.sockets.at(-1)!.ev.emit("connection.update", { qr: "2@pronto" });
    expect(await p).toBe("K7PQ-2M9X");
    expect(t.sockets.at(-1)!.pairedWith).toBe("5548999992210");
  });

  it("recusa número sem DDI/DDD para o código", async () => {
    const t = setup();
    await expect(t.svc.pairingCode("99992210")).rejects.toThrow(/DDI e DDD/);
  });
});

describe("foto de perfil", () => {
  it("devolve a URL quando pública e null quando privada", async () => {
    const t = setup();
    void t.svc.connect();
    await tick();
    const sock = t.sockets[0]! as unknown as { ev: EventEmitter; profilePictureUrl: (jid: string) => Promise<string> };
    sock.ev.emit("connection.update", { connection: "open" });
    sock.profilePictureUrl = async (jid) => {
      if (jid.startsWith("5548")) return "https://pps.whatsapp.net/foto.jpg";
      throw new Error("item-not-found");
    };
    expect(await t.svc.getProfilePictureUrl("5548999992210@s.whatsapp.net")).toBe("https://pps.whatsapp.net/foto.jpg");
    expect(await t.svc.getProfilePictureUrl("5511999992210@s.whatsapp.net")).toBeNull();
  });
});
