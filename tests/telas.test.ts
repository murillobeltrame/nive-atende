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
