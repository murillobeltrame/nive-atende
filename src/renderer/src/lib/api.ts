// Acesso ao processo principal. Fora do Electron (navegador / testes de layout) usa o mock em memória.
import type { NiveAtendeApi } from "../../../shared/ipc";
import { createMockApi } from "./mock";

export const isMock = typeof window === "undefined" || !window.niveAtende;

export const api: NiveAtendeApi = window.niveAtende ?? createMockApi();
