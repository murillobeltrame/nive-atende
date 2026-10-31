// Versionador: sobe a versão, atualiza o CHANGELOG, faz commit, cria a tag e envia para o GitHub.
// A tag dispara o GitHub Actions, que gera os instaladores (Mac e Windows) e publica a Release.
//
// Uso:
//   npm run release -- patch      0.1.0 -> 0.1.1  (correções)
//   npm run release -- minor      0.1.0 -> 0.2.0  (novidades)
//   npm run release -- major      0.1.0 -> 1.0.0  (mudança grande)
//   npm run release -- 1.2.3      versão exata
//   npm run release -- atual      publica a versão que já está no package.json
//   --sem-enviar                  faz tudo localmente, sem git push
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const kind = args.find((a) => !a.startsWith("--")) ?? "patch";
const push = !args.includes("--sem-enviar");

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("Rode o versionador na branch main.");
if (git("status", "--porcelain")) fail("Há alterações sem commit. Faça o commit antes de lançar uma versão.");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
let next;
if (kind === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (kind === "minor") next = `${maj}.${min + 1}.0`;
else if (kind === "major") next = `${maj + 1}.0.0`;
else if (kind === "atual") next = pkg.version;
else if (/^\d+\.\d+\.\d+$/.test(kind)) next = kind;
else fail(`Tipo desconhecido: ${kind}. Use patch, minor, major, atual ou X.Y.Z.`);

const tag = `v${next}`;
if (git("tag", "--list", tag)) fail(`A versão ${tag} já existe.`);

// mudanças desde a última versão
let lastTag = "";
try {
  lastTag = git("describe", "--tags", "--abbrev=0", "--match", "v*");
} catch {
  /* primeira versão */
}
const log = git("log", "--no-merges", "--pretty=%s", ...(lastTag ? [`${lastTag}..HEAD`] : []))
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !/^Versão \d/.test(l));

const today = new Date().toLocaleDateString("pt-BR");
const section = `## ${tag} — ${today}\n\n${log.length ? log.map((l) => `- ${l}`).join("\n") : "- Ajustes internos"}\n`;
const header = "# Histórico de versões\n\n";
const current = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8").replace(header, "") : "";
writeFileSync("CHANGELOG.md", header + section + (current ? "\n" + current : ""));

if (next !== pkg.version) {
  pkg.version = next;
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  if (existsSync("package-lock.json")) {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    lock.version = next;
    if (lock.packages?.[""]) lock.packages[""].version = next;
    writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  }
}

git("add", "package.json", "CHANGELOG.md", ...(existsSync("package-lock.json") ? ["package-lock.json"] : []));
git("commit", "-m", `Versão ${next}`);
git("tag", "-a", tag, "-m", `Nive Atende ${tag}`);
console.log(`\n✔ Versão ${next} criada (commit + tag ${tag}).`);

if (push) {
  console.log("Enviando para o GitHub…");
  execFileSync("git", ["push", "origin", "main", "--follow-tags"], { stdio: "inherit" });
  const remote = git("remote", "get-url", "origin").replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
  console.log(`\n✔ Enviado. Os instaladores ficam prontos em ~15 min em:\n  ${remote}/releases/tag/${tag}\n  (andamento: ${remote}/actions)\n`);
} else {
  console.log("Não enviado (--sem-enviar). Para enviar: git push origin main --follow-tags");
}
