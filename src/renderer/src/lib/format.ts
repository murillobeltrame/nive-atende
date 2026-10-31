import type { Conversation, MessageOrigin } from "../../../shared/types";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
  return (first + last).toUpperCase();
}

const AVATAR_COLORS: Array<[string, string]> = [
  ["#E8D9F2", "#5B3A78"],
  ["#FCE3D3", "#8E3F10"],
  ["#D8E6FA", "#2F4FA8"],
  ["#E1EEDB", "#3A6A2A"],
  ["#F6E7B8", "#6B5310"],
  ["#DDEEEA", "#0B5C4B"],
];

export function avatarColors(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? ["#E6E9E8", "#3C4844"];
}

export function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function listTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(ts);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length < 8) return phone;
  const cc = d.length > 11 ? `+${d.slice(0, d.length - 11)} ` : "";
  const rest = d.slice(-11);
  const ddd = rest.length === 11 ? rest.slice(0, 2) : rest.slice(0, 2);
  const last = rest.slice(-4);
  const first = rest.length === 11 ? rest.slice(2, 3) : "";
  return `${cc}${ddd} ${first}●●●●-${last}`;
}

export function money(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function usd(v: number): string {
  return `US$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })}`;
}

export function remaining(until: number, now = Date.now()): string {
  const ms = Math.max(0, until - now);
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export function previewPrefix(origin: MessageOrigin | null): string {
  if (origin === "ia") return "IA: ";
  if (origin === "humano_app" || origin === "humano_celular") return "Você: ";
  return "";
}

export function auxLine(c: Conversation, now = Date.now()): string {
  if (c.state === "ignorado") return "Número na lista de ignorados";
  if (c.state === "precisa_humano") return c.handoffReason ?? "A IA passou para você";
  if (c.aiPausedUntil && c.aiPausedUntil > now) return `IA pausada · ${remaining(c.aiPausedUntil, now)} restante`;
  if (c.lastOrigin === "humano_celular") return "Respondido pelo celular";
  if (c.customerName && c.verifiedBy) return `Cliente verificado · ${c.verifiedBy === "phone" ? "telefone" : "CPF"}`;
  const last = c.lastAiActions[c.lastAiActions.length - 1];
  return last?.label ?? "";
}

export async function fileToBase64(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
