// Simulador: conversa de teste com a IA, isolada do WhatsApp e do ERP.
import { describe, expect, it } from "vitest";
import { FakeAi, FakeNive, makeSettings, reply, toolCall } from "./helpers";
import { Simulator } from "../src/main/simulator";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("simulador", () => {
  it("responde usando o catálogo, sem criar rascunho de verdade", async () => {
    const ai = new FakeAi();
    const nive = new FakeNive();
    const sim = new Simulator({ settings: () => makeSettings(), nive, ai, fetchImage: async () => null });
    ai.script(
      toolCall("buscar_produto", { termo: "bolsa" }),
      toolCall("reservar_produto", { produto_id: "p-bolsa", variacao_id: "v-bolsa", quantidade: 1, nome_cliente: "Teste Simulado" }),
      reply("Separado! R$ 159,90."),
    );
    await sim.send("separa a bolsa caramelo");
    await wait(50);
    const msgs = sim.messages();
    expect(msgs.map((m) => m.origin)).toContain("ia");
    expect(nive.drafts).toHaveLength(0);
    expect(nive.calls.some((c) => c.startsWith("search:"))).toBe(true);
    sim.reset();
    expect(sim.messages()).toHaveLength(0);
  });
});
