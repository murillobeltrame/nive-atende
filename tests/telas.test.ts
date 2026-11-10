// 0.3.9: textos da barra de status e nome do contato nunca em branco.
import { describe, expect, it } from "vitest";
import { lowerFirst } from "../src/main/status/monitor";
import { conversationName } from "../src/renderer/src/lib/format";

describe("barra de status", () => {
  it("não estraga nomes próprios e siglas ao juntar a frase", () => {
    expect(lowerFirst("WhatsApp desconectado")).toBe("WhatsApp desconectado");
    expect(lowerFirst("API Nive lenta ou indisponível")).toBe("API Nive lenta ou indisponível");
    expect(lowerFirst("IA ok")).toBe("IA ok");
    expect(lowerFirst("Sem internet")).toBe("sem internet");
    expect(lowerFirst("Seus créditos da OpenAI acabaram")).toBe("seus créditos da OpenAI acabaram");
  });
});

describe("nome do contato", () => {
  it("usa o nome, depois o telefone, e nunca fica em branco", () => {
    expect(conversationName({ displayName: "Maria", phone: "5548999990000" })).toBe("Maria");
    expect(conversationName({ displayName: "5548999990000", phone: "5548999990000" })).toBe("+55 (48) 99999-0000");
    expect(conversationName({ displayName: "", phone: "5548999990000" })).toBe("+55 (48) 99999-0000");
    expect(conversationName({ displayName: "  ", phone: "" })).toBe("Contato sem nome");
  });
});

import { waitingSince } from "../src/renderer/src/lib/format";

describe("tempo de espera nas pendências", () => {
  const now = new Date("2026-11-10T12:00:00-03:00").getTime();
  it("mostra há quanto tempo o cliente espera", () => {
    expect(waitingSince(now - 20_000, now)).toBe("agora");
    expect(waitingSince(now - 5 * 60_000, now)).toBe("há 5 min");
    expect(waitingSince(now - 3 * 3_600_000, now)).toBe("há 3 h");
    expect(waitingSince(now - 26 * 3_600_000, now)).toBe("há 1 dia");
    expect(waitingSince(now - 7 * 86_400_000, now)).toBe("há 7 dias");
    expect(waitingSince(now + 60_000, now)).toBe("agora");
  });
});
