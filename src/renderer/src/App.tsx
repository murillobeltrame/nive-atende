import { useCallback, useEffect, useState } from "react";
import type { AppSettings, ConversationFilter, NavigateTarget, StatusActionKind, StatusSnapshot } from "../../shared/types";
import { QrModal } from "./components/QrModal";
import { type Page, Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TermsModal } from "./components/TermsModal";
import { api, isMock } from "./lib/api";
import { ConversationsPage } from "./pages/Conversations";
import { PendingPage } from "./pages/Pending";
import { ReservationsPage } from "./pages/Reservations";
import { type SettingsSection, SettingsPage } from "./pages/Settings";
import { UsagePage } from "./pages/Usage";
import { SimulatorPage } from "./pages/Simulator";

const SECTION_IDS: SettingsSection[] = ["conexoes", "ia", "atendimento", "reserva", "contas", "personalidade", "audio", "app"];

function readInitialRoute(): { page: Page; section: SettingsSection; conversationId: string | null } {
  const p = new URLSearchParams(location.search);
  const page = (p.get("page") as Page | null) ?? "conversas";
  const section = (p.get("section") as SettingsSection | null) ?? "conexoes";
  return {
    page: ["conversas", "pendencias", "reservas", "simulador", "consumo", "ajustes"].includes(page) ? page : "conversas",
    section: SECTION_IDS.includes(section) ? section : "conexoes",
    conversationId: p.get("conversation"),
  };
}

export function App() {
  const initial = readInitialRoute();
  const [page, setPage] = useState<Page>(initial.page);
  const [filter, setFilter] = useState<ConversationFilter>("todas");
  const [conversationId, setConversationId] = useState<string | null>(initial.conversationId);
  const [section, setSection] = useState<SettingsSection>(initial.section);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [pendingReservations, setPendingReservations] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const countReservations = useCallback(async () => {
    const list = await api.listReservations();
    setPendingReservations(list.filter((r) => r.status === "pending_approval").length);
  }, []);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setSettings(s);
      if (s.termsAcceptedAt == null) setTermsOpen(true);
    });
    void api.getStatus().then(setStatus);
    void countReservations();
    const offs = [
      api.onStatus(setStatus),
      api.onReservation(() => void countReservations()),
      api.onNavigate((t: NavigateTarget) => navigate(t)),
    ];
    return () => offs.forEach((o) => o());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = (t: NavigateTarget) => {
    if (t.page === "conversas") {
      setPage("conversas");
      if (t.filter) setFilter(t.filter);
      if (t.conversationId) setConversationId(t.conversationId);
    } else if (t.page === "ajustes") {
      setPage("ajustes");
      if (t.section && SECTION_IDS.includes(t.section as SettingsSection)) setSection(t.section as SettingsSection);
    } else if (t.page === "pendencias") {
      setPage("pendencias");
    } else {
      setPage("conversas");
    }
  };

  const openSettings = (s: string) => navigate({ page: "ajustes", section: s });

  const openConversation = (id: string) => {
    setFilter("todas");
    setConversationId(id);
    setPage("conversas");
  };

  const onAction = async (kind: StatusActionKind) => {
    switch (kind) {
      case "reconnect":
        setQrOpen(true);
        return;
      case "open_settings_nive":
      case "open_settings_evolution":
        openSettings("conexoes");
        return;
      case "open_settings_openai":
      case "open_ai_guide":
        openSettings("ia");
        return;
      case "accept_terms":
        setTermsOpen(true);
        return;
      case "restart_evolution": {
        setBusyAction(true);
        try {
          const r = await api.restartEvolution();
          showToast(r.message);
        } finally {
          setBusyAction(false);
        }
        return;
      }
      case "retry":
        setBusyAction(true);
        try {
          setStatus(await api.refreshStatus());
        } finally {
          setBusyAction(false);
        }
    }
  };

  const toggleAuto = async (enabled: boolean) => {
    setStatus(await api.setAutoEnabled(enabled));
    setSettings(await api.getSettings());
    showToast(enabled ? "Atendimento automático ligado" : "Atendimento automático desligado");
  };

  const whatsappOk = status?.checks.whatsapp.state === "ok";
  const needsHuman = status?.needsHumanCount ?? 0;

  return (
    <div className="app">
      {isMock && <div className="mock-banner">Modo de demonstração: dados de exemplo, nada é enviado.</div>}
      <StatusBar status={status} onAction={onAction} onToggleAuto={toggleAuto} busy={busyAction} />
      <div className="app-body">
        <Sidebar
          page={page}
          onNavigate={(p) => setPage(p)}
          pendingCount={needsHuman + pendingReservations}
        />
        <main className="page" style={{ display: "flex", overflow: "hidden" }}>
          {page === "conversas" && (
            <ConversationsPage
              filter={filter}
              onFilter={setFilter}
              selectedId={conversationId}
              onSelect={setConversationId}
              settings={settings}
              onOpenSettings={openSettings}
              onConnectWhatsapp={() => setQrOpen(true)}
              needsHumanCount={needsHuman}
              whatsappOk={whatsappOk}
            />
          )}
          {page === "pendencias" && <PendingPage onOpenConversation={openConversation} />}
          {page === "reservas" && <ReservationsPage onOpenConversation={openConversation} />}
          {page === "simulador" && <SimulatorPage onOpenSettings={openSettings} />}
          {page === "consumo" && <UsagePage onOpenGuide={() => openSettings("ia")} />}
          {page === "ajustes" && settings && (
            <SettingsPage
              settings={settings}
              section={section}
              onSection={setSection}
              onSettings={setSettings}
              onConnectWhatsapp={() => setQrOpen(true)}
            />
          )}
        </main>
      </div>
      {qrOpen && <QrModal onClose={() => setQrOpen(false)} />}
      {termsOpen && (
        <TermsModal
          onAccept={async () => {
            setSettings(await api.acceptTerms());
            setTermsOpen(false);
            setStatus(await api.refreshStatus());
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
