// Processo principal do Electron: janela, ícone na bandeja, IPC e ligação entre os serviços.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, safeStorage, shell, Tray } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { EVENTS, type NiveAtendeApi, type RpcMethod } from "../shared/ipc";
import type { NavigateTarget, QrState, StatusSnapshot, UsageSummary } from "../shared/types";
import { Store, localDay } from "./store/db";
import { SettingsService } from "./settings";
import { NiveClient } from "./nive/client";
import { EvolutionClient, type WhatsAppGateway } from "./evolution/client";
import type { EvolutionEvent } from "./evolution/parse";
import { OpenAiProvider, AiError } from "./ai/openai";
import { createFfmpegTranscoder, createOggOpusTranscoder } from "./audio/transcode";
import { BaileysService } from "./whatsapp/baileys";
import { EvolutionService } from "./whatsapp/evolution-service";
import type { WhatsAppService } from "./whatsapp/service";
import { Engine } from "./engine/engine";
import { StatusMonitor } from "./status/monitor";
import { registeredToJid, digitsOnly } from "./engine/phone";
import { initLog, log, logDir } from "./log";

const isDev = Boolean(process.env.NIVE_ATENDE_DEV_URL);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}
// o app continua atendendo em segundo plano: não deixa o Chromium reduzir os timers
app.commandLine.appendSwitch("disable-background-timer-throttling");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function resourcePath(...p: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), "resources", ...p);
}

// ------------------------------------------------------------------ serviços
mkdirSync(app.getPath("userData"), { recursive: true });
initLog(app.getPath("userData"));
log("app", "info", `Nive Atende ${app.getVersion()} iniciado (${process.platform} ${process.arch}, Electron ${process.versions.electron})`);
const store = new Store(join(app.getPath("userData"), "nive-atende.sqlite"));
const settings = new SettingsService(store, {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => new Uint8Array(safeStorage.encryptString(plain)),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data)),
});

let webhookToken = store.getKv<string>("webhookToken");
if (!webhookToken) {
  webhookToken = randomBytes(18).toString("hex");
  store.setKv("webhookToken", webhookToken);
}

const nive = new NiveClient(() => {
  const s = settings.get();
  return { baseUrl: s.nive.baseUrl, storeSlug: s.nive.storeSlug, apiKey: settings.getSecret("niveApiKey") };
});
const evolution = new EvolutionClient(() => {
  const s = settings.get();
  return { baseUrl: s.evolution.baseUrl, instanceName: s.evolution.instanceName, apiKey: settings.getSecret("evolutionApiKey") };
});
const ai = new OpenAiProvider(() => settings.getSecret("openaiApiKey"));

/** URL que a Evolution (em Docker) usa para chegar ao app. */
function webhookUrl(): string {
  const s = settings.get();
  const host = process.env.NIVE_ATENDE_WEBHOOK_HOST ?? (/localhost|127\.0\.0\.1/.test(s.evolution.baseUrl) ? "host.docker.internal" : "127.0.0.1");
  return `http://${host}:${s.evolution.webhookPort}/webhook/${webhookToken}`;
}

// WhatsApp: embutido (Baileys, padrão) ou servidor Evolution externo
const embeddedWa = new BaileysService({
  authDir: join(app.getPath("userData"), "whatsapp"),
  toOggOpus: createOggOpusTranscoder(),
  appVersion: app.getVersion(),
});
const evolutionWa = new EvolutionService({
  client: evolution,
  token: webhookToken,
  port: () => settings.get().evolution.webhookPort,
  webhookUrl,
  hasApiKey: () => settings.get().evolution.hasApiKey,
});
let activeMode = settings.get().evolution.mode;
function wa(): WhatsAppService {
  return activeMode === "evolution" ? evolutionWa : embeddedWa;
}
/** O motor envia sempre pelo serviço ativo. */
const gateway: WhatsAppGateway = {
  sendText: (...a) => wa().sendText(...a),
  sendMedia: (...a) => wa().sendMedia(...a),
  sendAudio: (...a) => wa().sendAudio(...a),
  sendSticker: (...a) => wa().sendSticker(...a),
  sendPresence: (...a) => wa().sendPresence(...a),
  getMediaBase64: (...a) => wa().getMediaBase64(...a),
};

const monitor = new StatusMonitor({
  store,
  settings: () => settings.get(),
  whatsapp: () => wa(),
  nive,
  testOpenAi: async (deep) => {
    if (deep) await ai.chat(settings.get().openai.model, [{ role: "user", content: "Responda apenas: ok" }], []);
    else await ai.listModels();
  },
});

const engine = new Engine({
  store,
  settings: () => settings.get(),
  nive,
  ai,
  wa: gateway,
  transcode: createFfmpegTranscoder(),
  blockedReason: () => monitor.blockedReason(),
});

function handleWaEvents(source: WhatsAppService, events: EvolutionEvent[]): void {
  if (source !== wa()) return; // eventos do modo inativo são ignorados
  for (const ev of events) {
    if (ev.type === "message") void engine.handleInbound(ev).catch((e) => console.error("[whatsapp]", e));
    else if (ev.type === "connection") {
      monitor.setWhatsappState(ev.state);
      if (ev.state === "open") emitQr({ state: "open", qrBase64: null, pairingCode: null, message: "WhatsApp conectado" });
      else if (ev.state === "close")
        emitQr({ state: "close", qrBase64: null, pairingCode: null, message: "A conexão caiu antes de concluir. Clique em Gerar novo código." });
    } else if (ev.type === "qr") {
      emitQr(
        ev.qrBase64
          ? { state: "connecting", qrBase64: ev.qrBase64, pairingCode: ev.pairingCode, message: null }
          : { state: "close", qrBase64: null, pairingCode: null, message: "O código expirou. Clique em Gerar novo código." },
      );
    }
    else if (ev.type === "ack") engine.handleAck(ev.waMessageId, ev.status);
  }
}
embeddedWa.onEvents((e) => handleWaEvents(embeddedWa, e));
evolutionWa.onEvents((e) => handleWaEvents(evolutionWa, e));

/** Troca entre WhatsApp embutido e Evolution quando o lojista muda nos Ajustes. */
async function applyWhatsappMode(): Promise<void> {
  const mode = settings.get().evolution.mode;
  if (mode === activeMode) return;
  await wa().stop();
  activeMode = mode;
  await wa().start();
  void monitor.runAll(true);
}

// ------------------------------------------------------------------ envio para a interface
function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function emitQr(q: QrState): void {
  send(EVENTS.qr, q);
}

function navigate(t: NavigateTarget): void {
  showWindow();
  send(EVENTS.navigate, t);
}

engine.on("message", (m) => send(EVENTS.message, m));
engine.on("conversation", (c) => {
  send(EVENTS.conversation, c);
  refreshTray();
});
engine.on("reservation", (r) => {
  send(EVENTS.reservation, r);
  refreshTray();
});
engine.on("aiError", (e: AiError) => monitor.reportAiError(e));
engine.on("notify", (n) => {
  const s = settings.get();
  if (s.app.notify === "nenhuma" || !Notification.isSupported()) return;
  if (s.app.notify === "humano" && n.kind === "message" && win?.isFocused()) return;
  const notif = new Notification({ title: n.title, body: n.body, silent: !s.app.sound });
  notif.on("click", () => navigate(n.conversationId ? { page: "conversas", conversationId: n.conversationId } : { page: "pendencias" }));
  notif.show();
});

let ownerAlertSentFor: number | null = null;
monitor.on("status", (snap) => {
  send(EVENTS.status, snap);
  refreshTray(snap);
});
monitor.on("down", (snap) => {
  const s = settings.get();
  if (Notification.isSupported() && s.app.notify !== "nenhuma") {
    const n = new Notification({ title: snap.headline, body: "As mensagens ficam aguardando; nada é enviado ao cliente até voltar.", silent: !s.app.sound });
    n.on("click", () => navigate({ page: "status" }));
    n.show();
  }
  // Avisa no celular do lojista quando o problema não é o próprio WhatsApp.
  const owner = digitsOnly(s.app.ownerAlertNumber);
  const whatsappOk = snap.checks.whatsapp.state === "ok" && snap.checks.evolution.state === "ok";
  const ownerJid = registeredToJid(owner);
  if (ownerJid && whatsappOk && ownerAlertSentFor !== snap.downSince) {
    ownerAlertSentFor = snap.downSince;
    const jid = ownerJid;
    void wa().sendText(jid, `Nive Atende: ${snap.headline}. Abra o programa no computador da loja para resolver.`).catch(() => undefined);
  }
});
monitor.on("recovered", () => {
  void engine.resumeWaiting();
});

// ------------------------------------------------------------------ bandeja
function trayIcon(level: StatusSnapshot["level"], badge: boolean): Electron.NativeImage {
  const name = `${level}${badge ? "-badge" : ""}`;
  const img = nativeImage.createFromPath(resourcePath("tray", `${name}.png`));
  if (process.platform === "darwin") img.setTemplateImage(false);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

let lastSnap: StatusSnapshot | null = null;
function refreshTray(snap?: StatusSnapshot): void {
  if (snap) lastSnap = snap;
  if (!tray) return;
  const s = lastSnap ?? monitor.snapshot();
  const needs = store.countByState("precisa_humano") + store.countPendingReservations();
  tray.setImage(trayIcon(s.level, needs > 0));
  tray.setToolTip(`Nive Atende — ${s.headline}${needs ? ` · ${needs} precisa${needs > 1 ? "m" : ""} de você` : ""}`);
  if (process.platform === "darwin") tray.setTitle(needs ? String(needs) : "");
  const auto = settings.get().attendance.autoEnabled;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s.headline, enabled: false },
      { type: "separator" },
      { label: "Abrir Nive Atende", click: () => showWindow() },
      { label: needs ? `Precisam de você (${needs})` : "Precisam de você", click: () => navigate({ page: "pendencias" }) },
      {
        label: auto ? "Pausar atendimento automático" : "Retomar atendimento automático",
        click: () => {
          settings.save({ attendance: { autoEnabled: !auto } });
          monitor.publish();
        },
      },
      { label: "Ver status detalhado", click: () => navigate({ page: "status" }) },
      { type: "separator" },
      {
        label: "Sair (para o atendimento)",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  if (win && process.platform === "win32") {
    win.setOverlayIcon(needs ? trayIcon("warn", true) : null, needs ? `${needs} precisam de você` : "");
  }
}

// ------------------------------------------------------------------ janela
function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: "Nive Atende",
    icon: resourcePath("icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // microfone para gravar áudio no campo de resposta (só esta janela)
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc === win?.webContents && (permission === "media" || permission === "notifications"));
  });
  win.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) win?.show();
  });
  win.on("close", (e) => {
    // Fechar no X manda para a bandeja; o atendimento continua.
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isDev || !url.startsWith(process.env.NIVE_ATENDE_DEV_URL!)) e.preventDefault();
  });
  if (isDev) void win.loadURL(process.env.NIVE_ATENDE_DEV_URL!);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
}

// ------------------------------------------------------------------ consumo
function usageSummary(): UsageSummary {
  const now = new Date();
  const first = localDay(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  const today = localDay(now.getTime());
  const rows = store.usageBetween(first, today);
  const empty = { aiReplies: 0, humanReplies: 0, inputTokens: 0, outputTokens: 0, transcriptionSeconds: 0, costUsd: 0 };
  const month = rows.reduce(
    (a, r) => ({
      aiReplies: a.aiReplies + r.aiReplies,
      humanReplies: a.humanReplies + r.humanReplies,
      inputTokens: a.inputTokens + r.inputTokens,
      outputTokens: a.outputTokens + r.outputTokens,
      transcriptionSeconds: a.transcriptionSeconds + r.transcriptionSeconds,
      costUsd: a.costUsd + r.costUsd,
    }),
    { ...empty },
  );
  const t = rows.find((r) => r.day === today);
  return {
    today: t ? { aiReplies: t.aiReplies, humanReplies: t.humanReplies, inputTokens: t.inputTokens, outputTokens: t.outputTokens, transcriptionSeconds: t.transcriptionSeconds, costUsd: t.costUsd } : { ...empty },
    month,
    byDay: rows.map((r) => ({ day: r.day, aiReplies: r.aiReplies, humanReplies: r.humanReplies, costUsd: r.costUsd })),
    monthlyAlertUsd: settings.get().ai.monthlyAlertUsd,
  };
}

// ------------------------------------------------------------------ IPC
async function connectWhatsapp(): Promise<QrState> {
  const service = wa();
  try {
    const r = await service.connect();
    if (r.state === "open") {
      monitor.setWhatsappState("open");
      return { state: "open", qrBase64: null, pairingCode: null, message: "WhatsApp já está conectado" };
    }
    if (service.mode === "evolution") {
      // a Evolution também avisa pelo webhook; o polling cobre quando o webhook não chega
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        try {
          const st = await service.connectionState();
          if (st === "open") {
            clearInterval(poll);
            monitor.setWhatsappState("open");
            emitQr({ state: "open", qrBase64: null, pairingCode: null, message: "WhatsApp conectado" });
          } else if (tries % 15 === 0) {
            const again = await service.connect();
            emitQr({ state: "connecting", qrBase64: again.qrBase64, pairingCode: again.pairingCode, message: null });
          }
        } catch {
          /* tenta de novo */
        }
        if (tries > 150) clearInterval(poll);
      }, 2000);
    }
    return {
      state: "connecting",
      qrBase64: r.qrBase64,
      pairingCode: r.pairingCode,
      message: r.qrBase64
        ? "Abra o WhatsApp no celular da loja > Aparelhos conectados > Conectar aparelho e leia o código"
        : "Gerando o QR Code… se não aparecer em alguns segundos, confira a internet e tente de novo.",
    };
  } catch (e) {
    const msg = (e as Error).message;
    return {
      state: "close",
      qrBase64: null,
      pairingCode: null,
      message:
        service.mode === "evolution" && /fetch failed|ECONNREFUSED/i.test(msg)
          ? "Nenhum servidor Evolution respondendo. Ligue o servidor ou volte para o WhatsApp embutido nos Ajustes."
          : `Não foi possível conectar o WhatsApp: ${msg}`,
    };
  }
}

const handlers: { [K in RpcMethod]: (...args: Parameters<NiveAtendeApi[K]>) => ReturnType<NiveAtendeApi[K]> | Awaited<ReturnType<NiveAtendeApi[K]>> } = {
  getSettings: () => settings.get(),
  saveSettings: (patch) => {
    const prevPort = settings.get().evolution.webhookPort;
    const s = settings.save(patch);
    if (s.evolution.mode !== activeMode) void applyWhatsappMode();
    else if (activeMode === "evolution" && s.evolution.webhookPort !== prevPort) void evolutionWa.stop().then(() => evolutionWa.start());
    if (patch.app?.launchAtLogin !== undefined) applyLoginItem();
    monitor.publish();
    return s;
  },
  setSecret: (key, value) => {
    const s = settings.setSecret(key, value);
    if (key === "evolutionApiKey") void evolutionWa.registerWebhook();
    void monitor.runAll(true);
    return s;
  },
  clearSecret: (key) => {
    const s = settings.clearSecret(key);
    void monitor.runAll(true);
    return s;
  },
  acceptTerms: () => {
    const s = settings.acceptTerms();
    monitor.publish();
    return s;
  },
  testNive: async () => {
    try {
      await nive.testConnection();
      return { ok: true, message: "Conexão com a API Nive funcionando." };
    } catch (e) {
      const st = (e as { status?: number }).status;
      return {
        ok: false,
        message:
          st === 401 ? "Chave inválida ou revogada." : st === 403 ? "A chave não tem permissão (confira o escopo e o plano com acesso à API)." : st === 400 ? "Slug da loja inválido." : (e as Error).message,
      };
    }
  },
  testOpenAI: async () => {
    try {
      const models = await ai.listModels();
      await ai.chat(settings.get().openai.model, [{ role: "user", content: "Responda apenas: ok" }], []);
      return { ok: true, message: "Chave da OpenAI funcionando e com crédito.", models };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
  testEvolution: () => wa().test(),
  getStatus: () => monitor.snapshot(),
  refreshStatus: () => monitor.runAll(true),
  setAutoEnabled: (enabled) => {
    settings.save({ attendance: { autoEnabled: enabled } });
    return monitor.publish();
  },
  restartEvolution: async () => {
    try {
      await wa().restart();
      void monitor.runAll(true);
      return { ok: true, message: "Serviço reiniciado." };
    } catch (e) {
      return { ok: false, message: `Não foi possível reiniciar: ${(e as Error).message}.` };
    }
  },
  whatsappConnect: () => connectWhatsapp(),
  whatsappLogout: async () => {
    try {
      await wa().logout();
    } catch {
      /* já desconectado */
    }
    monitor.setWhatsappState("close");
    return { state: "close", qrBase64: null, pairingCode: null, message: "WhatsApp desconectado" };
  },
  listConversations: (filter, q) => store.listConversations(filter, q),
  getConversation: (id) => store.getConversation(id),
  getMessages: (id) => store.listMessages(id),
  getMedia: async (messageId) => {
    let media = store.getMedia(messageId);
    if (!media) {
      const m = store.getMessage(messageId);
      if (!m?.waMessageId || !m.hasMedia) return null;
      const fetched = await wa().getMediaBase64(m.waMessageId, m.conversationId, m.origin !== "consumidor").catch(() => null);
      if (!fetched) return null;
      store.saveMedia(m.id, fetched.mimetype, Buffer.from(fetched.base64, "base64"));
      media = store.getMedia(messageId);
    }
    if (!media) return null;
    const mime = media.mime.split(";")[0] ?? "application/octet-stream";
    return `data:${mime};base64,${Buffer.from(media.data).toString("base64")}`;
  },
  markRead: (id) => {
    const c = store.updateConversation(id, { unread: 0 });
    send(EVENTS.conversation, c);
  },
  sendText: (id, text) => engine.sendHumanText(id, text, settings.get().app.operatorName),
  sendMedia: (id, media) => engine.sendHumanMedia(id, media, settings.get().app.operatorName),
  sendAudio: (id, base64, mime) => engine.sendHumanAudio(id, base64, mime, settings.get().app.operatorName),
  resendSticker: (id, messageId) => engine.resendSticker(id, messageId, settings.get().app.operatorName),
  takeOver: (id) => engine.takeOver(id, settings.get().app.operatorName),
  returnToAi: (id) => engine.returnToAi(id),
  suggestReply: (id) => engine.suggestReply(id),
  listReservations: () => store.listReservations(),
  approveReservation: (id) => engine.approveReservation(id),
  rejectReservation: (id) => engine.rejectReservation(id),
  getUsage: () => usageSummary(),
  listAudit: (limit) => store.listAudit(limit ?? 200),
  openExternal: async (url) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url);
  },
  getAppInfo: () => ({ version: app.getVersion(), platform: process.platform }),
  openLogs: async () => {
    const d = logDir();
    if (d) await shell.openPath(d);
  },
};

for (const [method, fn] of Object.entries(handlers)) {
  ipcMain.handle(`rpc:${method}`, async (event, ...args: unknown[]) => {
    // só a janela do app pode chamar
    if (!win || event.sender !== win.webContents) throw new Error("origem não autorizada");
    return (fn as (...a: unknown[]) => unknown)(...args);
  });
}

function applyLoginItem(): void {
  if (process.platform === "linux" || isDev) return;
  app.setLoginItemSettings({ openAtLogin: settings.get().app.launchAtLogin, args: ["--hidden"] });
}

// ------------------------------------------------------------------ ciclo de vida
app.on("second-instance", () => showWindow());
app.on("before-quit", () => {
  quitting = true;
});
app.on("window-all-closed", () => {
  /* continua na bandeja */
});
app.on("activate", () => showWindow());

void app.whenReady().then(async () => {
  app.setAppUserModelId("br.com.nivesistemas.atende");
  Menu.setApplicationMenu(null);
  createWindow();
  tray = new Tray(trayIcon("warn", false));
  tray.on("click", () => showWindow());
  refreshTray();
  applyLoginItem();
  await wa().start().catch((e) => console.error("[whatsapp] falha ao iniciar", e));
  monitor.start();
  // pausas expiradas e retomada periódica
  setInterval(() => engine.sweepExpiredPauses(), 60_000);
  // impede que o sistema suspenda o app (não o PC) enquanto ele está aberto
  powerSaveBlocker.start("prevent-app-suspension");
});

app.on("will-quit", () => {
  monitor.stop();
  void wa().stop();
  store.close();
});
