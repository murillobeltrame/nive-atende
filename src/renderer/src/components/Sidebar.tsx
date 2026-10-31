import type { ReactNode } from "react";
import { IconBag, IconChart, IconChat, IconGear, IconInbox } from "./Icons";

export type Page = "conversas" | "pendencias" | "reservas" | "consumo" | "ajustes";

interface Props {
  page: Page;
  onNavigate: (p: Page) => void;
  pendingCount: number;
}

export function Sidebar({ page, onNavigate, pendingCount }: Props) {
  const item = (p: Page, label: string, icon: ReactNode, badge?: number) => (
    <button
      className="nav-btn"
      aria-current={page === p ? "page" : undefined}
      onClick={() => onNavigate(p)}
      aria-label={badge ? `${label}, ${badge} pendentes` : label}
    >
      {icon}
      <span aria-hidden="true">{label}</span>
      {badge ? (
        <span className="nav-badge" aria-hidden="true">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
  return (
    <nav className="sidebar" aria-label="Menu principal">
      {item("conversas", "Conversas", <IconChat />)}
      {item("pendencias", "Pendências", <IconInbox />, pendingCount)}
      {item("reservas", "Reservas", <IconBag />)}
      {item("consumo", "Consumo", <IconChart />)}
      <div className="sidebar-spacer" />
      {item("ajustes", "Ajustes", <IconGear />)}
    </nav>
  );
}
