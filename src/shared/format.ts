// Deixa o texto da IA com cara de WhatsApp: nomes legíveis e formatação nativa (*negrito*, listas).

const SMALL = new Set(["de", "da", "do", "das", "dos", "e", "com", "para", "em", "a", "o", "as", "os", "no", "na", "sem", "p/", "c/"]);
const UNITS: Record<string, string> = { ML: "ml", L: "L", G: "g", KG: "kg", MG: "mg", CM: "cm", MM: "mm", M: "m", UN: "un", UND: "un", PC: "pç", PCS: "pçs" };

/** "PERFUME FEM ARABE 100 ML" → "Perfume Fem Arabe 100 ml". Nomes já em caixa mista ficam como estão. */
export function prettyName(name: string): string {
  const s = name.replace(/\s+/g, " ").trim();
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (!letters) return s;
  const upper = letters.replace(/[^A-ZÀ-Ý]/g, "").length;
  if (upper / letters.length < 0.7) return s;
  return s
    .split(" ")
    .map((w, i) => {
      const m = w.match(/^(\d+(?:[.,]\d+)?)([A-Za-z]+)$/);
      const unit = m ? UNITS[m[2]!.toUpperCase()] : undefined;
      if (m && unit) return m[1] + unit;
      if (UNITS[w.toUpperCase()] && i > 0 && /\d$/.test(s.split(" ")[i - 1] ?? "")) return UNITS[w.toUpperCase()]!;
      const lower = w.toLocaleLowerCase("pt-BR");
      if (i > 0 && SMALL.has(lower)) return lower;
      return lower.replace(/(^|[-/(])(\p{L})/gu, (_, p: string, c: string) => p + c.toLocaleUpperCase("pt-BR"));
    })
    .join(" ");
}

/** Converte Markdown que a IA às vezes usa para a formatação do WhatsApp. */
export function toWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*") // **negrito** → *negrito*
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*") // títulos
    .replace(/^[ \t]*[-*•][ \t]+/gm, "• ") // listas
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 $2") // links markdown
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
