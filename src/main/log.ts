// Log simples em arquivo (pasta de dados do app/logs), para diagnosticar problemas na loja.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 1024 * 1024;
let dir: string | null = null;

export function initLog(baseDir: string): string {
  dir = join(baseDir, "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function logDir(): string | null {
  return dir;
}

/** Nunca registre chaves, CPF ou conteúdo de mensagens aqui. */
export function log(file: string, level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
  if (!dir) return;
  try {
    const path = join(dir, `${file}.log`);
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra === undefined ? "" : " " + safe(extra)}\n`;
    appendFileSync(path, line);
  } catch {
    /* log nunca derruba o app */
  }
}

function safe(v: unknown): string {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    return JSON.stringify(v).slice(0, 600);
  } catch {
    return String(v);
  }
}

/** Logger no formato que o Baileys espera (pino), gravando só avisos e erros. */
export function baileysLogger(file = "whatsapp") {
  const write = (level: "warn" | "error") => (obj: unknown, msg?: string) => {
    const text = typeof obj === "string" ? obj : msg ?? "";
    log(file, level, `[baileys] ${text}`, typeof obj === "object" && obj !== null ? summarize(obj) : undefined);
  };
  const logger = {
    level: "info",
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: (obj: unknown, msg?: string) => {
      const text = typeof obj === "string" ? obj : msg ?? "";
      if (/pair|error|fail|restart|opened|closed|logout|stream/i.test(text)) {
        log(file, "info", `[baileys] ${text}`, typeof obj === "object" && obj !== null ? summarize(obj) : undefined);
      }
    },
    warn: write("warn"),
    error: write("error"),
    fatal: write("error"),
  };
  return logger;
}

function summarize(obj: object): unknown {
  const o = obj as Record<string, unknown>;
  const err = o.err ?? o.error;
  if (err instanceof Error) return { error: err.message };
  if (err && typeof err === "object") return { error: (err as { message?: string }).message ?? "erro" };
  const trace = o.trace ?? o.ackErr;
  if (trace) return { detalhe: String((trace as { message?: string }).message ?? trace).slice(0, 300) };
  return undefined;
}
