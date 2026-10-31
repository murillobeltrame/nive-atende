// Normalização de telefones brasileiros e de JIDs do WhatsApp.
//
// Segurança: o número de quem chamou vem do WhatsApp SEMPRE com código do país. Só aceitamos +55;
// números estrangeiros nunca "batem" com um cadastro (ex.: +1 408 123-4567 não pode virar (14) 08123-4567).

export function digitsOnly(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** Número nacional (DDD + número, 10 ou 11 dígitos) de quem chamou. Exige +55. */
export function callerNational(value: string | null | undefined): string | null {
  const d = digitsOnly(value);
  if (!d.startsWith("55") || (d.length !== 12 && d.length !== 13)) return null;
  const nat = d.slice(2);
  return validNational(nat) ? nat : null;
}

/**
 * Número nacional de um telefone do cadastro (como o lojista digitou): aceita com ou sem 55,
 * com zero de longa distância e código de operadora.
 */
export function registeredNational(value: string | null | undefined): string | null {
  let d = digitsOnly(value).replace(/^0+/, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  else if (d.length === 12 || d.length === 13) d = d.slice(2); // 0 + operadora + DDD + número
  return validNational(d) ? d : null;
}

function validNational(n: string): boolean {
  if (n.length !== 10 && n.length !== 11) return false;
  if (!/^[1-9][1-9]/.test(n)) return false; // DDD válido: 11 a 99, sem zero
  if (n.length === 11 && n[2] !== "9") return false; // 11 dígitos só para celular (nono dígito)
  return true;
}

/** Iguais, ou diferentes só pelo nono dígito de celular. */
function sameNational(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length === 11 && b.length === 10 ? [a, b] : b.length === 11 && a.length === 10 ? [b, a] : [null, null];
  if (!long || !short) return false;
  // celular antigo sem o 9: o número de 8 dígitos começa com 6, 7, 8 ou 9
  return long.slice(0, 2) === short.slice(0, 2) && long.slice(3) === short.slice(2) && /[6-9]/.test(short[2]!);
}

/** O telefone do cadastro é o mesmo de quem chamou pelo WhatsApp? */
export function samePhone(registered: string | null | undefined, caller: string | null | undefined): boolean {
  const r = registeredNational(registered);
  const c = callerNational(caller);
  return r !== null && c !== null && sameNational(r, c);
}

/** Converte um telefone do cadastro em JID do WhatsApp (+55), ou null se não for um número válido. */
export function registeredToJid(registered: string | null | undefined): string | null {
  const n = registeredNational(registered);
  return n ? `55${n}@s.whatsapp.net` : null;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

/** Dígitos de um JID de usuário (5547999998888@s.whatsapp.net -> 5547999998888). */
export function jidToPhone(jid: string): string {
  return digitsOnly(jid.split("@")[0]?.split(":")[0]);
}

export function phoneToJid(phone: string): string {
  return `${digitsOnly(phone)}@s.whatsapp.net`;
}

/** Exibe o telefone mascarado: +55 48 9●●●●-2210. */
export function maskPhone(phone: string): string {
  const n = callerNational(phone) ?? registeredNational(phone);
  if (!n) return phone ? "número oculto" : "";
  const ddd = n.slice(0, 2);
  const rest = n.slice(2);
  const tail = rest.slice(-4);
  const head = rest.length === 9 ? rest[0] : "";
  return `+55 ${ddd} ${head}●●●●-${tail}`;
}
