// Desenvolvimento: Vite para a interface + Electron apontando para o servidor do Vite.
import { spawn } from "node:child_process";
import { createServer } from "vite";
import { execSync } from "node:child_process";

execSync("node scripts/build-main.mjs", { stdio: "inherit" });
const server = await createServer({ configFile: "vite.config.ts" });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:5199/";

const electronPath = (await import("electron")).default;
const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: { ...process.env, NIVE_ATENDE_DEV_URL: url },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
