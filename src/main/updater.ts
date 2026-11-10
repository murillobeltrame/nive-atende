// Atualização do app pelas Releases do GitHub.
// Windows: baixa sozinho em segundo plano e oferece "Atualizar agora" (reinicia já na versão nova).
// Mac: o instalador não é assinado pela Apple, então o sistema não deixa trocar o app sozinho;
//      o app só avisa que há versão nova e abre o download.
import { EventEmitter } from "node:events";
import type { UpdateState } from "../shared/types";

export const RELEASES_REPO = "murillobeltrame/nive-atende";

/** Parte que instala sozinha (electron-updater), isolada para poder testar sem o Electron. */
export interface AutoBackend {
  check(): Promise<void>;
  /** Fecha o app, instala e abre de novo. */
  install(): void;
  on(handlers: {
    available: (version: string) => void;
    none: () => void;
    progress: (percent: number) => void;
    ready: (version: string) => void;
    error: (e: unknown) => void;
  }): void;
}

export interface UpdaterDeps {
  currentVersion: string;
  /** auto = instala sozinho (Windows); manual = avisa e abre o download (Mac); off = desenvolvimento. */
  mode: "auto" | "manual" | "off";
  platform: NodeJS.Platform;
  auto?: AutoBackend;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

function parts(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]!
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

/** "0.3.10" é mais nova que "0.3.9"? */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/** Instalador da plataforma dentro de uma Release (só links do próprio GitHub). */
export function pickInstaller(release: GithubRelease, platform: NodeJS.Platform): string | null {
  const ext = platform === "darwin" ? ".dmg" : platform === "win32" ? ".exe" : null;
  const safe = (u: string | undefined) => (u && u.startsWith(`https://github.com/${RELEASES_REPO}/`) ? u : null);
  const asset = ext ? release.assets?.find((a) => a.name?.toLowerCase().endsWith(ext)) : undefined;
  return safe(asset?.browser_download_url) ?? safe(release.html_url);
}

export class Updater extends EventEmitter<{ state: [UpdateState] }> {
  private current: UpdateState;
  private checking: Promise<UpdateState> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: UpdaterDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.current = {
      status: "idle",
      currentVersion: deps.currentVersion,
      version: null,
      percent: null,
      downloadUrl: null,
      message: null,
      checkedAt: null,
      canInstall: deps.mode === "auto",
    };
    deps.auto?.on({
      available: (version) => {
        // já baixou esta versão: continua oferecendo
        if (this.current.status === "ready" && this.current.version === version) return;
        this.set({ status: "downloading", version, percent: 0, message: null });
      },
      none: () => {
        if (this.current.status !== "ready") this.set({ status: "none", version: null, percent: null, message: null });
      },
      progress: (percent) => {
        if (this.current.status !== "downloading") return;
        const p = Math.max(0, Math.min(100, Math.round(percent)));
        if (p !== this.current.percent) this.set({ percent: p });
      },
      ready: (version) => this.set({ status: "ready", version, percent: 100, message: null }),
      error: (e) => this.fail(e),
    });
  }

  state(): UpdateState {
    return { ...this.current };
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.current = { ...this.current, ...patch };
    this.emit("state", this.state());
    return this.state();
  }

  private fail(e: unknown): void {
    this.deps.log?.("warn", "falha ao buscar atualização", e);
    // versão já baixada continua valendo; o resto volta a tentar na próxima verificação
    if (this.current.status === "ready") return;
    this.set({ status: "error", percent: null, message: "Não foi possível verificar agora. O programa tenta de novo sozinho." });
  }

  /** Procura versão nova (uma verificação por vez). */
  check(): Promise<UpdateState> {
    if (this.deps.mode === "off") return Promise.resolve(this.state());
    if (this.checking) return this.checking;
    const run = (async () => {
      // download em andamento ou pronto: não recomeça
      if (this.current.status !== "downloading" && this.current.status !== "ready") this.set({ status: "checking", message: null });
      try {
        if (this.deps.mode === "auto" && this.deps.auto) await this.deps.auto.check();
        else await this.checkManual();
      } catch (e) {
        this.fail(e);
      }
      if (this.current.status === "checking") this.set({ status: "none" });
      return this.set({ checkedAt: this.now() });
    })().finally(() => {
      this.checking = null;
    });
    this.checking = run;
    return run;
  }

  private async checkManual(): Promise<void> {
    const res = await (this.deps.fetchImpl ?? fetch)(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "nive-atende" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const release = (await res.json()) as GithubRelease;
    const version = String(release.tag_name ?? "").replace(/^v/i, "");
    if (!version || release.draft || release.prerelease || !isNewerVersion(version, this.deps.currentVersion)) {
      this.set({ status: "none", version: null, downloadUrl: null, message: null });
      return;
    }
    this.set({ status: "manual", version, downloadUrl: pickInstaller(release, this.deps.platform), percent: null, message: null });
  }

  /** "Atualizar agora": só quando a versão nova já está baixada. */
  install(): boolean {
    if (this.deps.mode !== "auto" || !this.deps.auto || this.current.status !== "ready") return false;
    this.deps.log?.("info", `instalando a versão ${this.current.version}`);
    this.deps.auto.install();
    return true;
  }
}
