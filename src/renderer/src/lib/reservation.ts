// Textos sobre o vínculo da reserva com o cadastro de clientes.
import type { Reservation } from "../../../shared/types";

export function customerInfo(r: Reservation): { text: string; tone: "ok" | "warn" | "muted" } | null {
  switch (r.customerStatus) {
    case "identified":
      return { text: "Cliente identificado na conversa", tone: "ok" };
    case "found_by_name":
      return { text: "Cliente encontrado no cadastro pelo nome", tone: "ok" };
    case "new":
      return { text: "Cliente novo: será cadastrado (nome e telefone) ao aprovar", tone: "warn" };
    case "confirm":
      return { text: "Há cadastros com nome parecido: confirme quem é antes de aprovar", tone: "warn" };
    case "created_new":
      return { text: "Cliente cadastrado pelo Nive Atende", tone: "ok" };
    case "ambiguous":
      return { text: "Há mais de um cliente com esse nome: o rascunho sai sem cliente vinculado", tone: "warn" };
    default:
      return null;
  }
}

export function approveLabel(r: Reservation): string {
  if (r.status === "failed") return "Tentar de novo";
  if (r.customerStatus === "confirm") return "Confirmar cliente e lançar rascunho";
  return r.customerStatus === "new" ? "Aprovar, cadastrar cliente e lançar rascunho" : "Aprovar e lançar rascunho";
}
