// Protege dados sensíveis antes de qualquer texto chegar à IA.
// O CPF e a data de nascimento digitados pelo cliente são retirados do texto e guardados só na sessão;
// a IA vê apenas "[CPF informado]" / "[data informada]" e as ferramentas usam o valor guardado.
import { digitsOnly } from "./phone";

export function isValidCpf(value: string): boolean {
  const cpf = digitsOnly(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

// Qualquer sequência de 11 dígitos, com ou sem separadores (ponto, traço, barra, espaço) entre eles:
// "529.982.247-25", "52998224725", "529 982 247 25". Não pega pedaço de número maior.
const ELEVEN_DIGITS_RE = /(?<!\d[\s.\-/]{0,2})\d(?:[\s.\-/]{0,2}\d){10}(?![\s.\-/]{0,2}\d)/g;

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

const NUMERIC_DATE_RE = /(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2}|\d{4})(?!\d)/g;
// "10 03 1990" (espaços, comum em transcrição de áudio) e "10031990"
const SPACED_DATE_RE = /(?<!\d)(\d{1,2})\s+(\d{1,2})\s+(\d{2}|\d{4})(?!\d)/g;
const COMPACT_DATE_RE = /(?<!\d)(\d{2})(\d{2})(\d{4})(?!\d)/g;
const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const WRITTEN_DATE_RE =
  /(?<!\d)(\d{1,2})\s+de\s+(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})(?!\d)/gi;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toIso(day: number, month: number, year: number): string | null {
  if (year < 100) year += year > (new Date().getFullYear() % 100) ? 1900 : 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export interface GuardResult {
  /** Texto seguro para enviar à IA. */
  safeText: string;
  /** CPFs válidos encontrados (somente dígitos). */
  cpfs: string[];
  /** Datas encontradas, em AAAA-MM-DD. */
  dates: string[];
}

/** Retira CPF e datas do texto. Sequências de 11 dígitos inválidas como CPF também são mascaradas. */
export function guardText(text: string): GuardResult {
  const cpfs: string[] = [];
  const dates: string[] = [];
  let safe = text.replace(ELEVEN_DIGITS_RE, (match) => {
    const d = digitsOnly(match);
    if (isValidCpf(d)) {
      cpfs.push(d);
      return "[CPF informado]";
    }
    return "[número informado]";
  });
  safe = safe.replace(WRITTEN_DATE_RE, (m, d: string, mon: string, y: string) => {
    const iso = toIso(Number(d), MONTHS[mon.toLowerCase()] ?? 0, Number(y));
    if (!iso) return m;
    dates.push(iso);
    return "[data informada]";
  });
  safe = safe.replace(ISO_DATE_RE, (m, y: string, mo: string, d: string) => {
    const iso = toIso(Number(d), Number(mo), Number(y));
    if (!iso) return m;
    dates.push(iso);
    return "[data informada]";
  });
  for (const re of [NUMERIC_DATE_RE, SPACED_DATE_RE, COMPACT_DATE_RE]) {
    safe = safe.replace(re, (m, d: string, mo: string, y: string) => {
      const iso = toIso(Number(d), Number(mo), Number(y));
      if (!iso) return m;
      dates.push(iso);
      return "[data informada]";
    });
  }
  return { safeText: safe, cpfs, dates };
}

/** Compara uma data informada com a data de nascimento do cadastro (ISO ou Date). */
export function sameBirthDate(informed: string, registered: string | null | undefined): boolean {
  if (!registered) return false;
  const reg = registered.slice(0, 10);
  return informed === reg;
}

/** Converte valores monetários escritos em texto ("R$ 1.234,56", "159,90") para números. */
export function extractMoneyValues(text: string): number[] {
  const out: number[] = [];
  const re = /R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[1]!.replace(/\./g, "").replace(",", ".");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(Math.round(n * 100) / 100);
  }
  return out;
}

export function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/ /g, " ");
}
