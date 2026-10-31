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
import { EvolutionClient } from "./evolution/client";
import { WebhookServer } from "./evolution/webhook-server";
import { OpenAiProvider, AiError } from "./ai/openai";
import { createFfmpegTranscoder } from "./audio/transcode";
import { Engine } from "./engine/engine";
import { StatusMonitor } from "./status/monitor";
import { registeredToJid, digitsOnly } from "./engine/phone";

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

const monitor = new StatusMonitor({
  store,
  settings: () => settings.get(),
  evolution,
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
  wa: evolution,
  transcode: createFfmpegTranscoder(),
  blockedReason: () => monitor.blockedReason(),
});

const webhook = new WebhookServer(webhookToken, (events) => {
  for (const ev of events) {
    if (ev.type === "message") void engine.handleInbound(ev).catch((e) => console.error("[webhook]", e));
    else if (ev.type === "connection") {
      monitor.setWhatsappState(ev.state);
      if (ev.state === "open") emitQr({ state: "open", qrBase64: null, pairingCode: null, message: "WhatsApp conectado" });
    } else if (ev.type === "qr") emitQr({ state: "connecting", qrBase64: ev.qrBase64, pairingCode: ev.pairingCode, message: null });
    else if (ev.type === "ack") engine.handleAck(ev.waMessageId, ev.status);
  }
});

/** URL que a Evolution (em Docker) usa para chegar ao app. */
function webhookUrl(): string {
  const s = settings.get();
  const host = process.env.NIVE_ATENDE_WEBHOOK_HOST ?? (/localhost|127\.0\.0\.1/.test(s.evolution.baseUrl) ? "host.docker.internal" : "127.0.0.1");
  return `http://${host}:${s.evolution.webhookPort}/webhook/${webhookToken}`;
}

async function startWebhook(): Promise<void> {
  const port = settings.get().evolution.webhookPort;
  try {
    await webhook.start(port);
  } catch (e) {
    console.error("[webhook] não foi possível abrir a porta", port, e);
  }
}

async function registerWebhook(): Promise<void> {
  if (!settings.get().evolution.hasApiKey) return;
  try {
    if (await evolution.instanceExists()) await evolution.setWebhook(webhookUrl());
  } catch (e) {
    console.error("[evolution] falha ao registrar webhook", e);
  }
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
    void evolution.sendText(jid, `Nive Atende: ${snap.headline}. Abra o programa no computador da loja para resolver.`).catch(() => undefined);
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
  try {
    if (!(await evolution.instanceExists())) await evolution.createInstance();
    await evolution.setWebhook(webhookUrl());
    const state = await evolution.connectionState();
    if (state === "open") {
      monitor.setWhatsappState("open");
      return { state: "open", qrBase64: null, pairingCode: null, message: "WhatsApp já está conectado" };
    }
    const qr = await evolution.connect();
    // acompanha até conectar (os eventos de webhook também atualizam)
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const st = await evolution.connectionState();
        if (st === "open") {
          clearInterval(poll);
          monitor.setWhatsappState("open");
          emitQr({ state: "open", qrBase64: null, pairingCode: null, message: "WhatsApp conectado" });
        } else if (tries % 15 === 0) {
          const again = await evolution.connect();
          emitQr({ state: "connecting", qrBase64: again.qrBase64, pairingCode: again.pairingCode, message: null });
        }
      } catch {
        /* tenta de novo */
      }
      if (tries > 150) clearInterval(poll);
    }, 2000);
    return { state: "connecting", qrBase64: qr.qrBase64, pairingCode: qr.pairingCode, message: "Abra o WhatsApp no celular da loja > Aparelhos conectados > Conectar aparelho" };
  } catch (e) {
    return { state: "close", qrBase64: null, pairingCode: null, message: `Não foi possível falar com o serviço do WhatsApp: ${(e as Error).message}` };
  }
}

const handlers: { [K in RpcMethod]: (...args: Parameters<NiveAtendeApi[K]>) => ReturnType<NiveAtendeApi[K]> | Awaited<ReturnType<NiveAtendeApi[K]>> } = {
  getSettings: () => settings.get(),
  saveSettings: (patch) => {
    const prevPort = settings.get().evolution.webhookPort;
    const s = settings.save(patch);
    if (s.evolution.webhookPort !== prevPort) void startWebhook().then(registerWebhook);
    if (patch.app?.launchAtLogin !== undefined) applyLoginItem();
    monitor.publish();
    return s;
  },
  setSecret: (key, value) => {
    const s = settings.setSecret(key, value);
    if (key === "evolutionApiKey") void registerWebhook();
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
  testEvolution: async () => {
    try {
      const version = await evolution.ping();
      const exists = await evolution.instanceExists();
      return { ok: true, message: `Serviço do WhatsApp no ar${version ? ` (versão ${version})` : ""}. ${exists ? "Instância encontrada." : "A instância será criada ao conectar."}` };
    } catch (e) {
      return { ok: false, message: `Não foi possível falar com a Evolution: ${(e as Error).message}` };
    }
  },
  getStatus: () => monitor.snapshot(),
  refreshStatus: () => monitor.runAll(true),
  setAutoEnabled: (enabled) => {
    settings.save({ attendance: { autoEnabled: enabled } });
    return monitor.publish();
  },
  restartEvolution: async () => {
    try {
      await evolution.restart();
      void monitor.runAll(true);
      return { ok: true, message: "Serviço reiniciado." };
    } catch (e) {
      return { ok: false, message: `Não foi possível reiniciar: ${(e as Error).message}. Confira se o Docker está aberto.` };
    }
  },
  whatsappConnect: () => connectWhatsapp(),
  whatsappLogout: async () => {
    try {
      await evolution.logout();
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
      const fetched = await evolution.getMediaBase64(m.waMessageId, m.conversationId, m.origin !== "consumidor").catch(() => null);
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
  await startWebhook();
  await registerWebhook();
  monitor.start();
  // pausas expiradas e retomada periódica
  setInterval(() => engine.sweepExpiredPauses(), 60_000);
  // impede que o sistema suspenda o app (não o PC) enquanto ele está aberto
  powerSaveBlocker.start("prevent-app-suspension");
});

app.on("will-quit", () => {
  monitor.stop();
  void webhook.stop();
  store.close();
});
