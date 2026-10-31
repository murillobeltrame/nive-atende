// Confere se o Node embutido no Electron tem o módulo node:sqlite (usado pelo banco local).
import { spawnSync } from "node:child_process";
import electronPath from "electron";

// Também confere se o motor do WhatsApp embutido (Baileys, pacote ESM) carrega no Node do Electron.
const code = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:'); db.exec('create table t(x)');
console.log('node:sqlite ok · Node', process.versions.node, '· Electron', process.versions.electron);
const { pathToFileURL } = require('node:url');
import(pathToFileURL(require.resolve('baileys')).href)
  .then((m) => { if (typeof m.makeWASocket !== 'function') throw new Error('makeWASocket ausente'); console.log('baileys ok'); })
  .catch((e) => { console.error('baileys falhou:', e.message); process.exit(1); });
`;
const r = spawnSync(electronPath, ["-e", code], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  encoding: "utf8",
});
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
if (r.status !== 0 || !/node:sqlite ok/.test(r.stdout ?? "") || !/baileys ok/.test(r.stdout ?? "")) {
  console.error("O Node embutido no Electron não carregou o node:sqlite ou o Baileys.");
  process.exit(1);
}
