// Contrato comum para as duas formas de conectar o WhatsApp:
//  - "embedded": motor Baileys dentro do próprio app (padrão, sem Docker)
//  - "evolution": servidor Evolution API externo (opção avançada)
import type { WhatsAppGateway, ConnectionState } from "../evolution/client";
import type { EvolutionEvent } from "../evolution/parse";
import type { TestResult } from "../../shared/types";

export type WhatsAppMode = "embedded" | "evolution";

export interface EngineHealth {
  /** O motor/servidor do WhatsApp está disponível? */
  ok: boolean;
  message: string;
}

export interface WhatsAppService extends WhatsAppGateway {
  readonly mode: WhatsAppMode;
  /** Liga o serviço (embutido: reconecta se já houver sessão; Evolution: abre o webhook local). */
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<EngineHealth>;
  connectionState(): Promise<ConnectionState>;
  /** Inicia a conexão e devolve o QR Code (data URL) quando ainda não conectado. */
  connect(): Promise<{ state: ConnectionState; qrBase64: string | null; pairingCode: string | null }>;
  /** Código de 8 caracteres para "Conectar com número de telefone" no celular. */
  pairingCode(phone: string): Promise<string>;
  logout(): Promise<void>;
  restart(): Promise<void>;
  test(): Promise<TestResult>;
  onEvents(cb: (events: EvolutionEvent[]) => void): void;
}
