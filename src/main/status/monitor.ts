// Verifica periodicamente WhatsApp, Evolution, API Nive, OpenAI e internet, e resume em verde/amarelo/vermelho.
import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { AppSettings, CheckResult, StatusSnapshot } from "../../shared/types";
import type { ConnectionState } from "../evolution/client";
import type { WhatsAppService } from "../whatsapp/service";
import type { NiveApi } from "../nive/client";
import type { AiError } from "../ai/openai";
import { activeProvider, aiConfigured, PROVIDERS } from "../../shared/ai-catalog";
import type { Store } from "../store/db";
import { localDay } from "../store/db";

export interface MonitorDeps {
  store: Store;
  settings: () => AppSettings;
  whatsapp: () => WhatsAppService;
  nive: NiveApi;
  /** deep = faz uma chamada mínima de chat (detecta falta de crédito, que a listagem de modelos não detecta). */
  testOpenAi: (deep: boolean) => Promise<void>;
  now?: () => number;
  dnsCheck?: () => Promise<void>;
}

type CheckName = keyof StatusSnapshot["checks"];

const unknown = (at: number): CheckResult => ({ state: "unknown", message: "Verificando…", at });

export class StatusMonitor extends EventEmitter<{ status: [StatusSnapshot]; recovered: []; down: [StatusSnapshot] }> {
  private checks: StatusSnapshot["checks"];
  private lastCheckAt = 0;
  private downSince: number | null = null;
  private timers: NodeJS.Timeout[] = [];
  private lastNiveCheck = 0;
  private lastOpenAiCheck = 0;
  private whatsappState: ConnectionState = "unknown";
  private evolutionFailures = 0;
  private readonly now: () => number;
  private lastLevel: StatusSnapshot["level"] | null = null;

  constructor(private readonly deps: MonitorDeps) {
    super();
    this.now = deps.now ?? Date.now;
    const t = this.now();
    this.checks = { internet: unknown(t), evolution: unknown(t), whatsapp: unknown(t), nive: unknown(t), openai: unknown(t) };
  }

  start(): void {
    this.stop();
    void this.runAll(true);
    this.timers.push(setInterval(() => void this.runFast(), 30_000));
    this.timers.push(setInterval(() => void this.runAll(false), 5 * 60_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private set(name: CheckName, state: CheckResult["state"], message: string): void {
    this.checks[name] = { state, message, at: this.now() };
  }

  private async checkInternet(): Promise<void> {
    try {
      await (this.deps.dnsCheck ?? (() => lookup("api.nivesistemas.com.br").then(() => undefined)))();
      this.set("internet", "ok", "Conectado à internet");
    } catch {
      this.set("internet", "error", "Sem internet");
    }
  }

  private async checkEvolution(): Promise<void> {
    const wa = this.deps.whatsapp();
    const h = await wa.health();
    if (!h.ok) {
      this.evolutionFailures++;
      this.set("evolution", "error", h.message);
      this.set("whatsapp", "error", wa.mode === "embedded" ? "WhatsApp indisponível" : "Sem conexão com o servidor do WhatsApp");
      return;
    }
    this.evolutionFailures = 0;
    this.set("evolution", "ok", h.message);
    this.whatsappState = await wa.connectionState();
    this.applyWhatsappState();
  }

  private applyWhatsappState(): void {
    if (this.whatsappState === "open") this.set("whatsapp", "ok", "WhatsApp conectado");
    else if (this.whatsappState === "connecting") this.set("whatsapp", "warn", "WhatsApp conectando…");
    else this.set("whatsapp", "error", "WhatsApp desconectado");
  }

  /** Chamado pelos eventos connection.update da Evolution (mais rápido que o polling). */
  setWhatsappState(state: ConnectionState): void {
    this.whatsappState = state;
    if (this.checks.evolution.state !== "ok") this.set("evolution", "ok", "Serviço do WhatsApp no ar");
    this.applyWhatsappState();
    this.publish();
  }

  private async checkNive(): Promise<void> {
    const s = this.deps.settings();
    if (!s.nive.hasApiKey || !s.nive.storeSlug) {
      this.set("nive", "error", "Chave da API Nive ou slug da loja não configurados");
      return;
    }
    try {
      await this.deps.nive.testConnection();
      this.set("nive", "ok", "API Nive ok");
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) this.set("nive", "error", "Chave da API Nive inválida ou sem permissão");
      else if (status === 400) this.set("nive", "error", "Slug da loja inválido");
      else this.set("nive", "warn", "API Nive lenta ou indisponível");
    }
    this.lastNiveCheck = this.now();
  }

  private async checkOpenAi(): Promise<void> {
    const s = this.deps.settings();
    if (!aiConfigured(s)) {
      this.set("openai", "error", `Chave da ${PROVIDERS[activeProvider(s)].company} não configurada`);
      return;
    }
    try {
      await this.deps.testOpenAi(this.checks.openai.state === "error");
      this.setUsageWarning();
    } catch (e) {
      this.reportAiError(e as AiError, false);
    }
    this.lastOpenAiCheck = this.now();
  }

  private setUsageWarning(): void {
    const s = this.deps.settings();
    const now = new Date(this.now());
    const first = localDay(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
    const cost = this.deps.store.usageBetween(first, localDay(this.now())).reduce((a, r) => a + r.costUsd, 0);
    if (s.ai.monthlyAlertUsd > 0 && cost >= s.ai.monthlyAlertUsd) {
      this.set("openai", "warn", `Gasto estimado do mês passou do alerta de US$ ${s.ai.monthlyAlertUsd.toFixed(2)}`);
    } else {
      this.set("openai", "ok", "IA ok");
    }
  }

  /** Erros da IA vistos durante o atendimento atualizam o status na hora. */
  reportAiError(e: AiError, publish = true): void {
    const company = PROVIDERS[activeProvider(this.deps.settings())].company;
    if (e.kind === "no_credit") this.set("openai", "error", `Seus créditos da ${company} acabaram`);
    else if (e.kind === "invalid_key") this.set("openai", "error", `Chave da ${company} inválida`);
    else if (e.kind === "rate_limit") this.set("openai", "warn", `Limite de uso da ${company} atingido; tentando de novo`);
    else this.set("openai", "warn", e.message);
    if (publish) this.publish();
  }

  async runFast(): Promise<void> {
    await this.checkInternet();
    await this.checkEvolution();
    if (this.checks.openai.state === "error" && this.now() - this.lastOpenAiCheck > 60_000) await this.checkOpenAi();
    if (this.checks.nive.state !== "ok" && this.now() - this.lastNiveCheck > 60_000) await this.checkNive();
    this.publish();
  }

  async runAll(force: boolean): Promise<StatusSnapshot> {
    void force;
    await this.checkInternet();
    await Promise.all([this.checkEvolution(), this.checkNive(), this.checkOpenAi()]);
    return this.publish();
  }

  /** Motivo do bloqueio do atendimento automático, ou null quando pode responder. */
  blockedReason(): string | null {
    const c = this.checks;
    if (c.internet.state === "error") return c.internet.message;
    if (c.evolution.state === "error") return c.evolution.message;
    if (c.whatsapp.state === "error") return c.whatsapp.message;
    if (c.openai.state === "error") return c.openai.message;
    if (c.nive.state === "error") return c.nive.message;
    return null;
  }

  snapshot(): StatusSnapshot {
    const s = this.deps.settings();
    const c = this.checks;
    const store = this.deps.store;
    const waitingCount = store.countUnprocessed();
    const needsHumanCount = store.countByState("precisa_humano");
    let level: StatusSnapshot["level"] = "ok";
    let headline = "Conectado e funcionando";
    let detail = "WhatsApp ok · API Nive ok · IA ok";
    let action: StatusSnapshot["action"] = null;

    const order: CheckName[] = ["internet", "evolution", "whatsapp", "openai", "nive"];
    const err = order.find((n) => c[n].state === "error");
    const warn = order.find((n) => c[n].state === "warn");

    if (s.termsAcceptedAt == null) {
      level = "warn";
      headline = "Aceite o termo de uso para começar";
      detail = "Leia e aceite as condições de uso do atendimento automático";
      action = { label: "Ler o termo", kind: "accept_terms" };
    } else if (err) {
      level = "error";
      headline = `Atendimento parado: ${c[err].message.charAt(0).toLowerCase()}${c[err].message.slice(1)}`;
      detail = `${this.downSince ? `Caiu às ${new Date(this.downSince).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · ` : ""}${waitingCount} mensage${waitingCount === 1 ? "m" : "ns"} aguardando · nada é enviado ao cliente até voltar`;
      action =
        err === "whatsapp"
          ? { label: "Reconectar (mostrar QR Code)", kind: "reconnect" }
          : err === "evolution"
            ? s.evolution.mode === "embedded" || s.evolution.hasApiKey
              ? { label: "Reiniciar serviço", kind: "restart_evolution" }
              : { label: "Configurar WhatsApp", kind: "open_settings_evolution" }
            : err === "openai"
              ? c.openai.message.includes("créditos")
                ? { label: "Como adicionar créditos", kind: "open_ai_guide" }
                : { label: "Configurar a IA", kind: "open_settings_openai" }
              : err === "nive"
                ? { label: "Abrir configuração da Nive", kind: "open_settings_nive" }
                : { label: "Tentar de novo", kind: "retry" };
    } else if (warn) {
      level = "warn";
      headline = `Funcionando, mas atenção: ${c[warn].message.charAt(0).toLowerCase()}${c[warn].message.slice(1)}`;
      detail = order.map((n) => `${labelOf(n)} ${c[n].state === "ok" ? "ok" : c[n].state === "warn" ? "atenção" : "—"}`).join(" · ");
      action = warn === "openai" ? { label: "Como adicionar créditos", kind: "open_ai_guide" } : { label: "Verificar de novo", kind: "retry" };
    } else if (!s.attendance.autoEnabled) {
      level = "warn";
      headline = "Conectado, com o atendimento automático pausado";
      detail = "As mensagens chegam normalmente; a IA não responde até você ligar o atendimento automático";
    } else {
      const at = new Date(this.now()).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      detail = `WhatsApp ok · API Nive ok · IA ok · verificado às ${at}`;
    }

    return {
      level,
      headline,
      detail,
      action,
      checks: { ...c },
      autoEnabled: s.attendance.autoEnabled,
      waitingCount,
      needsHumanCount,
      lastCheckAt: this.lastCheckAt,
      downSince: this.downSince,
    };
  }

  publish(): StatusSnapshot {
    this.lastCheckAt = this.now();
    const blocked = this.blockedReason();
    const wasDown = this.downSince !== null;
    if (blocked && !wasDown) this.downSince = this.now();
    if (!blocked && wasDown) this.downSince = null;
    const snap = this.snapshot();
    this.emit("status", snap);
    if (blocked && !wasDown) this.emit("down", snap);
    if (!blocked && wasDown) this.emit("recovered");
    if (!blocked && this.lastLevel === null) this.emit("recovered");
    this.lastLevel = snap.level;
    return snap;
  }
}

function labelOf(n: CheckName): string {
  return { internet: "Internet", evolution: "Serviço", whatsapp: "WhatsApp", nive: "API Nive", openai: "IA" }[n];
}
