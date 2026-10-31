// Testes das peças pequenas: telefone, CPF/datas, eventos da Evolution, configurações.
import { describe, expect, it } from "vitest";
import { callerNational, maskPhone, registeredToJid, samePhone } from "../src/main/engine/phone";
import { extractMoneyValues, guardText, isValidCpf } from "../src/main/engine/guard";
import { parseWebhook } from "../src/main/evolution/parse";
import { DEFAULT_SETTINGS, SettingsService, deepMerge } from "../src/main/settings";
import { Store } from "../src/main/store/db";

describe("telefone", () => {
  it("compara cadastro com quem chamou (com/sem 55, com/sem nono dígito, com máscara)", () => {
    expect(samePhone("(48) 99999-2210", "5548999992210")).toBe(true);
    expect(samePhone("48999992210", "554899992210")).toBe(true); // JID antigo sem o 9
    expect(samePhone("4899992210", "5548999992210")).toBe(true); // cadastro antigo sem o 9
    expect(samePhone("48 3333-4444", "554833334444")).toBe(true); // fixo
    expect(samePhone("+55 (48) 99999-2210", "5548999992210")).toBe(true);
    expect(samePhone("047 48 99999-2210", "5548999992210")).toBe(true); // 0 + operadora
    expect(samePhone("47999992210", "5548999992210")).toBe(false); // DDD diferente
  });
  it("número estrangeiro nunca bate com cadastro brasileiro", () => {
    // +1 408 123-4567 tem os mesmos "DDD 14 + 8 dígitos" de (14) 98123-4567
    expect(samePhone("(14) 98123-4567", "14081234567")).toBe(false);
    expect(samePhone("(35) 91234-5678", "351912345678")).toBe(false); // Portugal
    expect(callerNational("14081234567")).toBeNull();
  });
  it("fixo e celular com os mesmos 8 dígitos não batem", () => {
    expect(samePhone("(47) 3333-4444", "5547933334444")).toBe(false);
  });
  it("mascara para exibição e monta JID do cadastro", () => {
    expect(maskPhone("5548999992210")).toBe("+55 48 9●●●●-2210");
    expect(registeredToJid("(48) 99999-2210")).toBe("5548999992210@s.whatsapp.net");
    expect(registeredToJid("123")).toBeNull();
  });
});

describe("CPF e datas", () => {
  it("valida CPF", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("111.111.111-11")).toBe(false);
    expect(isValidCpf("529.982.247-24")).toBe(false);
  });
  it("retira CPF e datas do texto", () => {
    const g = guardText("cpf 52998224725 e nasci em 10/03/1990, ou 1990-03-10, ou 10 de março de 1990");
    expect(g.cpfs).toEqual(["52998224725"]);
    expect(g.dates).toEqual(["1990-03-10", "1990-03-10", "1990-03-10"]);
    expect(g.safeText).not.toMatch(/\d{11}/);
    expect(g.safeText).not.toContain("1990");
  });
  it("pega CPF e data com espaços (como sai em transcrição de áudio) e sem separador", () => {
    const g = guardText("meu cpf é 529 982 247 25, nasci 10 03 1990 ou 10031990");
    expect(g.cpfs).toEqual(["52998224725"]);
    expect(g.dates).toEqual(["1990-03-10", "1990-03-10"]);
    expect(g.safeText).not.toMatch(/529|1990/);
  });
  it("mascara sequências de 11 dígitos mesmo quando não são CPF válido", () => {
    expect(guardText("12345678900").safeText).toBe("[número informado]");
  });
  it("lê valores em reais", () => {
    expect(extractMoneyValues("Total R$ 1.234,56 e R$ 159,90 e R$10")).toEqual([1234.56, 159.9, 10]);
  });
});

describe("webhook da Evolution", () => {
  it("lê mensagem de texto", () => {
    const [ev] = parseWebhook({
      event: "messages.upsert",
      data: { key: { remoteJid: "5548999992210@s.whatsapp.net", fromMe: false, id: "ABC" }, pushName: "Ana", message: { conversation: "oi" }, messageTimestamp: 1793480000 },
    });
    expect(ev).toMatchObject({ type: "message", waMessageId: "ABC", phone: "5548999992210", text: "oi", kind: "text", fromMe: false, ignorable: false });
  });
  it("resolve o telefone quando o WhatsApp manda @lid", () => {
    const [ev] = parseWebhook({
      event: "MESSAGES_UPSERT",
      data: { key: { remoteJid: "123456@lid", remoteJidAlt: "5548999992210@s.whatsapp.net", fromMe: false, id: "L1" }, message: { extendedTextMessage: { text: "olá" } } },
    });
    expect(ev).toMatchObject({ phone: "5548999992210", remoteJid: "123456@lid", text: "olá" });
  });
  it("lê áudio com duração e base64", () => {
    const [ev] = parseWebhook({
      event: "messages.upsert",
      data: { key: { remoteJid: "5548999992210@s.whatsapp.net", id: "A1" }, message: { audioMessage: { seconds: 8, mimetype: "audio/ogg; codecs=opus" }, base64: "T2dn" } },
    });
    expect(ev).toMatchObject({ kind: "audio", durationSec: 8, base64: "T2dn" });
  });
  it("@lid sem telefone resolvido fica com telefone vazio (não identifica pelo número)", () => {
    const [ev] = parseWebhook({ event: "messages.upsert", data: { key: { remoteJid: "14081234567890@lid", id: "L2" }, message: { conversation: "oi" } } });
    expect(ev).toMatchObject({ phone: "", remoteJid: "14081234567890@lid" });
  });
  it("ignora grupos e status", () => {
    const evs = parseWebhook({ event: "messages.upsert", data: { key: { remoteJid: "123@g.us", id: "G1" }, message: { conversation: "oi grupo" } } });
    expect(evs[0]).toMatchObject({ ignorable: true });
  });
  it("lê conexão e QR", () => {
    expect(parseWebhook({ event: "connection.update", data: { state: "open" } })).toEqual([{ type: "connection", state: "open" }]);
    expect(parseWebhook({ event: "qrcode.updated", data: { qrcode: { base64: "data:image/png;base64,xx" } } })[0]).toMatchObject({ type: "qr", qrBase64: "data:image/png;base64,xx" });
  });
});

describe("configurações", () => {
  const box = { isAvailable: () => true, encrypt: (s: string) => new TextEncoder().encode("enc:" + s), decrypt: (b: Uint8Array) => new TextDecoder().decode(b).slice(4) };

  it("mescla sem aceitar chaves desconhecidas nem tipos errados", () => {
    const r = deepMerge(DEFAULT_SETTINGS, { attendance: { replyDelayMinSec: "x", bogus: 1 }, hack: true });
    expect(r.attendance.replyDelayMinSec).toBe(DEFAULT_SETTINGS.attendance.replyDelayMinSec);
    expect((r as unknown as Record<string, unknown>).hack).toBeUndefined();
  });

  it("guarda chaves criptografadas e expõe só se existem", () => {
    const store = new Store(":memory:");
    const s = new SettingsService(store, box);
    expect(s.get().openai.hasApiKey).toBe(false);
    s.setSecret("openaiApiKey", " sk-teste ");
    expect(s.get().openai.hasApiKey).toBe(true);
    expect(s.getSecret("openaiApiKey")).toBe("sk-teste");
    expect(JSON.stringify(s.get())).not.toContain("sk-teste");
    // o valor no banco não é o texto puro
    expect(new TextDecoder().decode(store.getSecretBlob("openaiApiKey")!)).toBe("enc:sk-teste");
    s.clearSecret("openaiApiKey");
    expect(s.get().openai.hasApiKey).toBe(false);
  });

  it("não salva a chave quando a criptografia do sistema não está disponível", () => {
    const s = new SettingsService(new Store(":memory:"), { ...box, isAvailable: () => false });
    expect(() => s.setSecret("niveApiKey", "sl_live_x")).toThrow();
  });
});
