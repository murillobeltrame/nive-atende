// Confere se o Node embutido no Electron tem o módulo node:sqlite (usado pelo banco local).
import { spawnSync } from "node:child_process";
import electronPath from "electron";

const r = spawnSync(electronPath, ["-e", "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('create table t(x)'); console.log('node:sqlite ok · Node', process.versions.node, '· Electron', process.versions.electron)"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  encoding: "utf8",
});
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
if (r.status !== 0 || !/node:sqlite ok/.test(r.stdout ?? "")) {
  console.error("O Electron desta versão não tem node:sqlite. Troque a versão do Electron ou o banco.");
  process.exit(1);
}
