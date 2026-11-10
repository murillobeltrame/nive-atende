// Ponte segura entre a interface e o processo principal: só expõe a API tipada.
import { contextBridge, ipcRenderer } from "electron";
import { EVENTS, RPC_METHODS, type NiveAtendeApi } from "../shared/ipc";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const rpc = Object.fromEntries(
  RPC_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`rpc:${m}`, ...args)]),
);

const api = {
  ...rpc,
  onStatus: (cb) => subscribe(EVENTS.status, cb),
  onConversation: (cb) => subscribe(EVENTS.conversation, cb),
  onMessage: (cb) => subscribe(EVENTS.message, cb),
  onQr: (cb) => subscribe(EVENTS.qr, cb),
  onReservation: (cb) => subscribe(EVENTS.reservation, cb),
  onNavigate: (cb) => subscribe(EVENTS.navigate, cb),
  onActivity: (cb) => subscribe(EVENTS.activity, cb),
  onSim: (cb) => subscribe(EVENTS.sim, cb),
  onTyping: (cb) => subscribe(EVENTS.typing, cb),
  onConversationDeleted: (cb) => subscribe(EVENTS.conversationDeleted, cb),
  onUpdate: (cb) => subscribe(EVENTS.update, cb),
} as NiveAtendeApi;

contextBridge.exposeInMainWorld("niveAtende", api);
