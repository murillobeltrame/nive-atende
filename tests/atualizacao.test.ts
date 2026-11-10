// 0.3.8: o app busca versão nova nas Releases do GitHub e oferece para atualizar.
import { describe, expect, it } from "vitest";
import { isNewerVersion, pickInstaller, Updater, type AutoBackend } from "../src/main/updater";
import type { UpdateState } from "../src/shared/types";

type Handlers = Parameters<AutoBackend["on"]>[0];

function fakeAuto() {
  let h: Handlers | null = null;
  const calls = { check: 0, install: 0 };
  let onCheck: (h: Handlers) => void | Promise<void> = (x) => x.none();
  const backend: AutoBackend = {
    check: async () => {
      calls.check++;
      await onCheck(h!);
    },
    install: () => void calls.install++,
    on: (handlers) => (h = handlers),
  };
  return { backend, calls, handlers: () => h!, setCheck: (fn: typeof onCheck) => (onCheck = fn) };
}

function release(version: string, extra: Record<string, unknown> = {}) {
  const base = `https://github.com/murillobeltrame/nive-atende/releases`;
  return {
    tag_name: `v${version}`,
    html_url: `${base}/tag/v${version}`,
    assets: [
      { name: `Nive-Atende-${version}-mac-arm64.dmg`, browser_download_url: `${base}/download/v${version}/Nive-Atende-${version}-mac-arm64.dmg` },
      { name: `Nive-Atende-${version}-win-x64.exe`, browser_download_url: `${base}/download/v${version}/Nive-Atende-${version}-win-x64.exe` },
    ],
    ...extra,
  };
}

const fetchRelease = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("comparação de versões", () => {
  it("compara número a número, não como texto", () => {
    expect(isNewerVersion("0.3.10", "0.3.9")).toBe(true);
    expect(isNewerVersion("v0.4.0", "0.3.99")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.3.8", "0.3.8")).toBe(false);
    expect(isNewerVersion("0.3.7", "0.3.8")).toBe(false);
    expect(isNewerVersion("", "0.3.8")).toBe(false);
  });
});

describe("Windows: baixa sozinho e oferece para atualizar", () => {
  it("versão nova: baixando → pronta → instala no clique", async () => {
    const a = fakeAuto();
    const u = new Updater({ currentVersion: "0.3.8", mode: "auto", platform: "win32", auto: a.backend });
    const seen: UpdateState["status"][] = [];
    u.on("state", (s) => seen.push(s.status));
    a.setCheck((h) => {
      h.available("0.3.9");
      h.progress(41.6);
      h.ready("0.3.9");
    });
    const s = await u.check();
    expect(s.status).toBe("ready");
    expect(s.version).toBe("0.3.9");
    expect(seen).toContain("downloading");
    expect(u.install()).toBe(true);
    expect(a.calls.install).toBe(1);
  });

  it("não instala antes de terminar de baixar", async () => {
    const a = fakeAuto();
    const u = new Updater({ currentVersion: "0.3.8", mode: "auto", platform: "win32", auto: a.backend });
    a.setCheck((h) => h.available("0.3.9"));
    expect((await u.check()).status).toBe("downloading");
    expect(u.install()).toBe(false);
    expect(a.calls.install).toBe(0);
  });

  it("sem versão nova: informa que já está atualizado", async () => {
    const a = fakeAuto();
    const u = new Updater({ currentVersion: "0.3.8", mode: "auto", platform: "win32", auto: a.backend, now: () => 123 });
    const s = await u.check();
    expect(s.status).toBe("none");
    expect(s.checkedAt).toBe(123);
  });

  it("falha de internet não derruba nada e a próxima verificação funciona", async () => {
    const a = fakeAuto();
    const u = new Updater({ currentVersion: "0.3.8", mode: "auto", platform: "win32", auto: a.backend });
    a.setCheck(() => {
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    });
    expect((await u.check()).status).toBe("error");
    a.setCheck((h) => h.ready("0.3.9"));
    expect((await u.check()).status).toBe("ready");
  });

  it("versão já baixada continua oferecida mesmo se uma verificação depois falhar", async () => {
    const a = fakeAuto();
    const u = new Updater({ currentVersion: "0.3.8", mode: "auto", platform: "win32", auto: a.backend });
    a.setCheck((h) => h.ready("0.3.9"));
    await u.check();
    a.setCheck((h) => h.error(new Error("sem internet")));
    const s = await u.check();
    expect(s.status).toBe("ready");
    expect(s.version).toBe("0.3.9");
  });

  it("duas verificações ao mesmo tempo viram uma só", async () => {
    const a = fakeAuto();
    const u = new Updater({ currentVersion: "0.3.8", mode: "auto", platform: "win32", auto: a.backend });
    await Promise.all([u.check(), u.check()]);
    expect(a.calls.check).toBe(1);
  });
});

describe("Mac: avisa e abre o download", () => {
  it("versão nova: mostra o link do .dmg", async () => {
    const u = new Updater({ currentVersion: "0.3.8", mode: "manual", platform: "darwin", fetchImpl: fetchRelease(release("0.3.9")) });
    const s = await u.check();
    expect(s.status).toBe("manual");
    expect(s.version).toBe("0.3.9");
    expect(s.downloadUrl).toMatch(/\.dmg$/);
    expect(s.canInstall).toBe(false);
    expect(u.install()).toBe(false);
  });

  it("mesma versão, rascunho ou pré-lançamento: nada a fazer", async () => {
    for (const body of [release("0.3.8"), release("0.3.9", { draft: true }), release("0.3.9", { prerelease: true })]) {
      const u = new Updater({ currentVersion: "0.3.8", mode: "manual", platform: "darwin", fetchImpl: fetchRelease(body) });
      expect((await u.check()).status).toBe("none");
    }
  });

  it("GitHub fora do ar: erro amigável", async () => {
    const u = new Updater({ currentVersion: "0.3.8", mode: "manual", platform: "darwin", fetchImpl: fetchRelease({}, 503) });
    const s = await u.check();
    expect(s.status).toBe("error");
    expect(s.message).toBeTruthy();
  });

  it("só aceita link de download do repositório do Nive Atende", () => {
    const evil = { tag_name: "v9.9.9", html_url: "https://exemplo.com/x", assets: [{ name: "a.dmg", browser_download_url: "https://exemplo.com/a.dmg" }] };
    expect(pickInstaller(evil, "darwin")).toBeNull();
    expect(pickInstaller(release("0.3.9"), "win32")).toMatch(/win-x64\.exe$/);
  });
});

describe("desenvolvimento", () => {
  it("não procura atualização", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const u = new Updater({ currentVersion: "0.3.8", mode: "off", platform: "darwin", fetchImpl });
    expect((await u.check()).status).toBe("idle");
    expect(called).toBe(false);
  });
});
