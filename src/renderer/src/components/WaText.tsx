// Mostra texto com a formatação do WhatsApp: *negrito*, _itálico_, ~riscado~ e ```monoespaçado```.
import type { ReactNode } from "react";

const RULES: Array<{ re: RegExp; wrap: (c: ReactNode, k: string) => ReactNode }> = [
  { re: /```([^`]+?)```/, wrap: (c, k) => <code key={k}>{c}</code> },
  { re: /(?<![\p{L}\p{N}*])\*(\S(?:[^*\n]*?\S)?)\*(?![\p{L}\p{N}*])/u, wrap: (c, k) => <strong key={k}>{c}</strong> },
  { re: /(?<![\p{L}\p{N}_])_(\S(?:[^_\n]*?\S)?)_(?![\p{L}\p{N}_])/u, wrap: (c, k) => <em key={k}>{c}</em> },
  { re: /(?<![\p{L}\p{N}~])~(\S(?:[^~\n]*?\S)?)~(?![\p{L}\p{N}~])/u, wrap: (c, k) => <s key={k}>{c}</s> },
];

function render(text: string, depth: number, key: string): ReactNode[] {
  if (depth >= RULES.length || !text) return text ? [text] : [];
  const { re, wrap } = RULES[depth]!;
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest) {
    const m = re.exec(rest);
    if (!m) break;
    out.push(...render(rest.slice(0, m.index), depth + 1, `${key}.${i}a`));
    out.push(wrap(depth === 0 ? m[1] : render(m[1]!, depth + 1, `${key}.${i}b`), `${key}.${i}w`));
    rest = rest.slice(m.index + m[0].length);
    i++;
  }
  out.push(...render(rest, depth + 1, `${key}.end`));
  return out;
}

export function WaText({ text }: { text: string }) {
  return <span className="wa-text">{render(text, 0, "t")}</span>;
}
