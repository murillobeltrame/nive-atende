// Criptografia das chaves (Nive, OpenAI, Evolution).
// Preferência: o cofre do sistema (safeStorage do Electron: Chaveiro no Mac, DPAPI no Windows).
// Plano B: se o cofre do sistema não estiver disponível ou falhar (comum em app sem certificado da
// Apple), AES-256-GCM com uma chave aleatória guardada num arquivo só do usuário, na pasta do app.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { SecretBox } from "./settings";

export interface OsVault {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(data: Buffer): string;
}

const PREFIX_OS = Buffer.from("ss1:");
const PREFIX_FILE = Buffer.from("fk1:");

function startsWith(data: Uint8Array, prefix: Buffer): boolean {
  return data.length >= prefix.length && Buffer.from(data.subarray(0, prefix.length)).equals(prefix);
}

export function createSecretBox(vault: OsVault, keyFile: string, onWarn: (msg: string, err?: unknown) => void = () => {}): SecretBox {
  let fileKey: Buffer | null = null;
  const getFileKey = (): Buffer => {
    if (fileKey) return fileKey;
    if (existsSync(keyFile)) {
      fileKey = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
    }
    if (!fileKey || fileKey.length !== 32) {
      fileKey = randomBytes(32);
      writeFileSync(keyFile, fileKey.toString("base64"), { mode: 0o600 });
    }
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      /* Windows */
    }
    return fileKey;
  };

  const encryptFile = (plain: string): Uint8Array => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", getFileKey(), iv);
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return new Uint8Array(Buffer.concat([PREFIX_FILE, iv, c.getAuthTag(), enc]));
  };

  const decryptFile = (data: Uint8Array): string => {
    const b = Buffer.from(data.subarray(PREFIX_FILE.length));
    const iv = b.subarray(0, 12);
    const tag = b.subarray(12, 28);
    const d = createDecipheriv("aes-256-gcm", getFileKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  };

  return {
    isAvailable: () => true,
    encrypt(plain) {
      try {
        if (vault.isEncryptionAvailable()) {
          const enc = vault.encryptString(plain);
          // confere na hora: há casos em que o cofre aceita guardar mas não consegue ler depois
          if (vault.decryptString(enc) === plain) return new Uint8Array(Buffer.concat([PREFIX_OS, enc]));
          onWarn("cofre do sistema não devolveu a chave corretamente; usando o plano B");
        } else {
          onWarn("cofre do sistema indisponível; usando o plano B");
        }
      } catch (e) {
        onWarn("falha no cofre do sistema; usando o plano B", e);
      }
      return encryptFile(plain);
    },
    decrypt(data) {
      if (startsWith(data, PREFIX_FILE)) return decryptFile(data);
      const raw = startsWith(data, PREFIX_OS) ? data.subarray(PREFIX_OS.length) : data; // sem prefixo = versão antiga
      return vault.decryptString(Buffer.from(raw));
    },
  };
}
