// Criptografia das chaves: cofre do sistema com plano B em arquivo.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretBox, type OsVault } from "../src/main/secret-box";
import { SettingsService } from "../src/main/settings";
import { Store } from "../src/main/store/db";

const keyFile = () => join(mkdtempSync(join(tmpdir(), "sb-")), "chave.key");
const goodVault: OsVault = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from("OS:" + Buffer.from(s).toString("base64")),
  decryptString: (b) => Buffer.from(b.toString().slice(3), "base64").toString(),
};

describe("cofre das chaves", () => {
  it("usa o cofre do sistema quando funciona", () => {
    const box = createSecretBox(goodVault, keyFile());
    const enc = box.encrypt("sl_live_abc");
    expect(Buffer.from(enc).toString()).toMatch(/^ss1:OS:/);
    expect(box.decrypt(enc)).toBe("sl_live_abc");
  });

  it("cofre do sistema falhando (app sem certificado no Mac): guarda no plano B e lê de volta", () => {
    const warns: string[] = [];
    const broken: OsVault = { isEncryptionAvailable: () => true, encryptString: () => { throw new Error("keychain negado"); }, decryptString: () => "" };
    const f = keyFile();
    const box = createSecretBox(broken, f, (m) => warns.push(m));
    const enc = box.encrypt("sl_live_abc");
    expect(Buffer.from(enc).toString("latin1")).toMatch(/^fk1:/);
    expect(Buffer.from(enc).toString("latin1")).not.toContain("sl_live_abc");
    // outra instância (app reaberto) lê com a mesma chave do arquivo
    expect(createSecretBox(broken, f).decrypt(enc)).toBe("sl_live_abc");
    expect(warns[0]).toContain("plano B");
  });

  it("cofre indisponível ou que devolve outra coisa também cai no plano B", () => {
    const off: OsVault = { ...goodVault, isEncryptionAvailable: () => false };
    const offBox = createSecretBox(off, keyFile());
    expect(offBox.decrypt(offBox.encrypt("x"))).toBe("x");
    const f = keyFile();
    const liar: OsVault = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from("zzz"), decryptString: () => "outra" };
    const box = createSecretBox(liar, f);
    expect(box.decrypt(box.encrypt("sk-123"))).toBe("sk-123");
  });

  it("lê chaves salvas pela versão antiga (sem prefixo)", () => {
    const box = createSecretBox(goodVault, keyFile());
    expect(box.decrypt(new Uint8Array(goodVault.encryptString("antiga")))).toBe("antiga");
  });

  it("nas configurações, a chave salva aparece como configurada com o final visível", () => {
    const broken: OsVault = { isEncryptionAvailable: () => true, encryptString: () => { throw new Error("x"); }, decryptString: () => "" };
    const s = new SettingsService(new Store(":memory:"), createSecretBox(broken, keyFile()));
    const out = s.setSecret("niveApiKey", "sl_live_1234567890abcd");
    expect(out.nive.hasApiKey).toBe(true);
    expect(out.nive.apiKeyEnd).toBe("abcd");
    expect(s.getSecret("niveApiKey")).toBe("sl_live_1234567890abcd");
  });
});
