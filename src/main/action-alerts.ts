/**
 * Avisos "aguardando ação" no Nive ERP.
 *
 * Cada conversa em "precisa de você" e cada reserva lançada como rascunho viram um aviso no ERP:
 * janela que toca na tela, sino e push no Nive Mobile. Quando o assunto se resolve aqui (alguém
 * respondeu, a reserva foi finalizada/cancelada), o aviso é encerrado lá.
 *
 * Se em LOCAL_ALARM_AFTER_MS nenhuma tela do ERP mostrou o aviso (ninguém com o ERP aberto) ou o ERP
 * não respondeu, o próprio Nive Atende avisa na tela dele, tocando até alguém clicar.
 */
import type { NiveApi } from "./nive/client";
import type { Store } from "./store/db";
import type { ActionAlarm } from "../shared/types";
import { prettyName } from "../shared/format";

export const ACTION_ALERT_SOURCE = "nive_atende";
/** Tempo que o ERP tem para mostrar o aviso antes de o Nive Atende tocar por conta própria. */
export const LOCAL_ALARM_AFTER_MS = 60_000;

type Wanted = ActionAlarm & { saleId: string | null; linkUrl?: string | null };

type Sent = { title: string; message: string; since: number };

const KV_SENT = "actionAlerts:sent";
const KV_DISMISSED = "actionAlerts:dismissed";

export interface ActionAlertDeps {
  store: Store;
  nive: Pick<NiveApi, "upsertActionAlert" | "resolveActionAlert" | "getActionAlerts">;
  now(): number;
  log(level: "info" | "warn", msg: string, err?: unknown): void;
  /** Lista do que tocar na tela do Nive Atende (vazia = parar). */
  onAlarm(alarms: ActionAlarm[]): void;
}

export class ActionAlertSync {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: ActionAlertDeps) {}

  /** O que precisa de ação agora, pelo banco local. */
  wanted(): Wanted[] {
    const { store } = this.deps;
    const out: Wanted[] = [];
    for (const c of store.listConversations("precisa")) {
      const name = c.customerName ?? c.savedName ?? c.pushName ?? c.displayName;
      out.push({
        ref: `conv:${c.id}`,
        kind: "handoff",
        conversationId: c.id,
        title: "Cliente aguardando alguém da loja",
        message: `${name}${c.handoffReason ? ` · ${c.handoffReason}` : ""}`.slice(0, 600),
        // abre a conversa na tela "Conversas do WhatsApp" do ERP (buscada aqui, no computador da loja)
        linkUrl: `/nive-atende?c=${encodeURIComponent(c.id)}`,
        saleId: null,
      });
    }
    for (const r of store.listReservations(300)) {
      if (r.status !== "created" || !r.saleId) continue;
      const variant = r.variantLabel && r.variantLabel !== "Único" ? ` (${r.variantLabel})` : "";
      out.push({
        ref: `res:${r.id}`,
        kind: "reservation",
        conversationId: r.conversationId,
        title: "Reserva pelo WhatsApp para aceitar",
        message: `${r.customerName} · ${r.quantity}× ${prettyName(r.productDescription)}${variant}${r.orderNumber ? ` · rascunho #${r.orderNumber}` : ""}. Finalize na retirada ou exclua o rascunho.`,
        saleId: r.saleId,
      });
    }
    return out;
  }

  /** Confere e manda ao ERP; várias chamadas seguidas viram uma passada só. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass().catch((e) => this.deps.log("warn", "falha ao atualizar os avisos no Nive ERP", e));
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Alguém viu o aviso na tela do Nive Atende: para de tocar (o aviso segue aberto no ERP). */
  dismiss(refs: string[]): void {
    const dismissed = new Set(this.deps.store.getKv<string[]>(KV_DISMISSED) ?? []);
    for (const r of refs) dismissed.add(r);
    this.deps.store.setKv(KV_DISMISSED, [...dismissed]);
    void this.sync();
  }

  private async pass(): Promise<void> {
    const { store, nive, now } = this.deps;
    const wanted = this.wanted();
    const sent = store.getKv<Record<string, Sent>>(KV_SENT) ?? {};
    const wantedRefs = new Set(wanted.map((w) => w.ref));
    let erpOk = Boolean(nive.upsertActionAlert && nive.resolveActionAlert);

    // encerra no ERP o que já se resolveu aqui
    for (const ref of Object.keys(sent)) {
      if (wantedRefs.has(ref)) continue;
      try {
        if (nive.resolveActionAlert) await nive.resolveActionAlert(ACTION_ALERT_SOURCE, ref);
        delete sent[ref];
      } catch (e) {
        erpOk = false;
        this.deps.log("warn", `não foi possível encerrar o aviso ${ref} no Nive ERP`, e);
      }
    }
    // abre (ou atualiza o texto) do que precisa de ação
    for (const w of wanted) {
      const prev = sent[w.ref];
      if (prev && prev.title === w.title && prev.message === w.message) continue;
      try {
        const ok = nive.upsertActionAlert
          ? await nive.upsertActionAlert({ source: ACTION_ALERT_SOURCE, externalRef: w.ref, kind: w.kind, title: w.title, message: w.message, saleId: w.saleId, linkUrl: w.linkUrl ?? null })
          : false;
        if (!ok) erpOk = false;
        sent[w.ref] = { title: w.title, message: w.message, since: prev?.since ?? now() };
      } catch (e) {
        erpOk = false;
        sent[w.ref] = { title: w.title, message: w.message, since: prev?.since ?? now() };
        this.deps.log("warn", `não foi possível abrir o aviso ${w.ref} no Nive ERP`, e);
      }
    }
    store.setKv(KV_SENT, sent);

    // limpa "já visto aqui" de assuntos encerrados
    const dismissed = (store.getKv<string[]>(KV_DISMISSED) ?? []).filter((r) => wantedRefs.has(r));
    store.setKv(KV_DISMISSED, dismissed);

    // situação no ERP: alguma tela mostrou? alguém abriu?
    let seenInErp = new Set<string>();
    if (erpOk && wanted.length && nive.getActionAlerts) {
      try {
        const items = await nive.getActionAlerts(ACTION_ALERT_SOURCE, wanted.map((w) => w.ref));
        if (items === null) erpOk = false;
        else seenInErp = new Set(items.filter((i) => i.status !== "open" || i.shownAt || i.acknowledgedAt).map((i) => i.externalRef));
      } catch {
        erpOk = false;
      }
    }
    const alarms = wanted
      .filter((w) => !dismissed.includes(w.ref))
      .filter((w) => !seenInErp.has(w.ref))
      .filter((w) => now() - (sent[w.ref]?.since ?? now()) >= LOCAL_ALARM_AFTER_MS)
      .map(({ saleId: _saleId, linkUrl: _linkUrl, ...a }) => ({ ...a, erpOffline: !erpOk }));
    this.deps.onAlarm(alarms);
  }
}
