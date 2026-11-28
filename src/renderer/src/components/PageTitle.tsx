import type { ReactNode } from "react";

/** Título de tela com o ícone da seção, igual em todas as telas. */
export function PageTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h1 className="page-title">
      <span className="page-title-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </h1>
  );
}

/** Título de seção dentro da tela, com ícone e contagem opcional. */
export function SectionTitle({ icon, children, count }: { icon: ReactNode; children: ReactNode; count?: number }) {
  return (
    <h2 className="section-h">
      {icon}
      {children}
      {count !== undefined && <span className="section-count">{count}</span>}
    </h2>
  );
}

/** Estado vazio com ícone, título e explicação. */
export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="card empty">
      <span className="empty-icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}
