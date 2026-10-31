import type { NiveAtendeApi } from "../../shared/ipc";

declare global {
  interface Window {
    niveAtende?: NiveAtendeApi;
  }
}

export {};
