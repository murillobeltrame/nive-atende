import { defineConfig } from "vitest/config";

// Os testes usam horários da loja (8h–20h30, horário comercial): fixa o fuso do Brasil
// para darem o mesmo resultado no computador e no GitHub (que roda em UTC).
process.env.TZ = "America/Sao_Paulo";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { TZ: "America/Sao_Paulo" },
  },
});
