// Decide se a conversa é assunto da loja (a IA responde) ou conversa pessoal do dono (fica para o humano).
import { type AiMessage, type AiProvider, messageText } from "./openai";

export interface TopicVerdict {
  store: boolean;
  reason: string;
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM = [
  "Você analisa conversas do WhatsApp de uma loja. O mesmo número é usado pelo dono para conversas pessoais.",
  "Decida se as ÚLTIMAS mensagens do contato são assunto que a loja deve responder ou se é conversa pessoal/particular.",
  "É da loja: produtos, preços, estoque, fotos, reservas, pedidos, entregas, horário, endereço, formas de pagamento, crediário, contas e parcelas, trocas, reclamações, ou cumprimento/pergunta de alguém que parece cliente.",
  "NÃO é da loja: família, amigos, namoro, combinados pessoais, piadas, correntes, assuntos de trabalho do dono com fornecedores, representantes, contador ou funcionários, cobranças pessoais, spam.",
  "Use o histórico: se o dono vinha conversando de forma pessoal com esse contato, um 'oi' ou 'e aí' também é pessoal. Contato sem histórico que só cumprimenta conta como cliente.",
  "Responda só com JSON: {\"loja\": true|false, \"motivo\": \"até 8 palavras\"}",
].join("\n");

export async function classifyTopic(ai: AiProvider, model: string, history: AiMessage[]): Promise<TopicVerdict> {
  const transcript = history
    .slice(-16)
    .map((m) => `${m.role === "user" ? "CONTATO" : "LOJA/DONO"}: ${messageText(m).slice(0, 400)}`)
    .join("\n");
  const res = await ai.chat(model, [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Conversa (mais recente por último):\n${transcript}` },
  ], []);
  const text = res.content ?? "";
  let store = true;
  let reason = "";
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text) as { loja?: unknown; motivo?: unknown };
    store = j.loja !== false;
    reason = typeof j.motivo === "string" ? j.motivo.slice(0, 80) : "";
  } catch {
    store = true; // na dúvida, atende
  }
  return { store, reason, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
}
