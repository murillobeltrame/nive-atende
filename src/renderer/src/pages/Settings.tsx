import { useEffect, useState, type ReactNode } from "react";
import type { AppSettings, SecretKey, TestResult } from "../../../shared/types";
import { IconCheck, IconExternal, IconEye, IconEyeOff, IconX } from "../components/Icons";
import { api } from "../lib/api";

export type SettingsSection =
  | "conexoes"
  | "ia"
  | "atendimento"
  | "reserva"
  | "contas"
  | "personalidade"
  | "audio"
  | "app";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "conexoes", label: "Conexões" },
  { id: "ia", label: "Inteligência artificial" },
  { id: "atendimento", label: "Atendimento" },
  { id: "reserva", label: "Reserva" },
  { id: "contas", label: "Contas dos clientes" },
  { id: "personalidade", label: "Personalidade" },
  { id: "audio", label: "Áudio" },
  { id: "app", label: "Programa" },
];

interface Props {
  settings: AppSettings;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onSettings: (s: AppSettings) => void;
  onConnectWhatsapp: () => void;
}

// ---------------------------------------------------------------- pequenos componentes

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button className="ext-link" onClick={() => void api.openExternal(href)}>
      {children}
      <IconExternal size={12} />
      <span className="sr-only"> (abre no navegador)</span>
    </button>
  );
}

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="inline-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && (
          <>
            <br />
            <small style={{ color: "var(--muted)" }}>{hint}</small>
          </>
        )}
      </span>
    </label>
  );
}

const CONTEXT_PLACEHOLDER = `Somos uma loja de perfumes e cosméticos no centro da cidade, atendendo há 15 anos.
Fale de forma carinhosa e chame a cliente pelo nome quando souber.
Nossos campeões de venda são os perfumes importados; para presente, sugira os kits.
Entregamos na cidade de segunda a sábado. Aceitamos Pix, cartão e crediário.`;

function Text({
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Num({
  label,
  value,
  onChange,
  min = 0,
  max,
  hint,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  hint?: string;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Feedback({ r }: { r: TestResult | null }) {
  if (!r) return null;
  return (
    <span className={`feedback ${r.ok ? "ok" : "fail"}`} role="status">
      {r.ok ? <IconCheck size={14} /> : <IconX size={14} />}
      {r.message}
    </span>
  );
}

// Chave digitada e ainda não salva: os botões "Testar" esperam este salvamento antes de testar.
let pendingSecretSave: Promise<void> | null = null;
export async function flushPendingSecret(): Promise<void> {
  if (pendingSecretSave) await pendingSecretSave.catch(() => undefined);
}

function SecretField({
  label,
  configured,
  ending,
  secretKey,
  placeholder,
  onSettings,
  hint,
}: {
  label: string;
  configured: boolean;
  /** Últimos caracteres da chave salva, para conferir sem expor a chave inteira. */
  ending?: string | null;
  secretKey: SecretKey;
  placeholder: string;
  onSettings: (s: AppSettings) => void;
  hint?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (raw = value) => {
    const v = raw.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    const p = (async () => {
      try {
        onSettings(await api.setSecret(secretKey, v));
        setValue("");
        setVisible(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
    pendingSecretSave = p;
    await p;
    if (pendingSecretSave === p) pendingSecretSave = null;
  };
  return (
    <div className="field">
      <span className="field-label">
        {label}{" "}
        <span className={`key-state ${configured ? "on" : "off"}`}>
          {configured ? (
            <>
              <IconCheck size={12} /> configurada{ending ? ` · termina em ${ending}` : ""}
            </>
          ) : (
            "não configurada"
          )}
        </span>
      </span>
      <div className="btn-row" style={{ flexWrap: "nowrap" }}>
        <label className="sr-only" htmlFor={`secret-${secretKey}`}>
          {label}
        </label>
        <div className="secret-input">
          <input
            id={`secret-${secretKey}`}
            className="input"
            type={visible ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder={configured ? "•••••••• (cole uma nova para trocar)" : placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
            // salva sozinho ao colar ou ao sair do campo: ninguém precisa lembrar de clicar em Salvar
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text");
              if (pasted.trim()) {
                e.preventDefault();
                setValue(pasted);
                void save(pasted);
              }
            }}
            onBlur={() => value.trim() && void save()}
          />
          <button
            type="button"
            className="secret-eye"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Esconder a chave" : "Mostrar a chave"}
            aria-pressed={visible}
            disabled={!value}
            title={value ? (visible ? "Esconder" : "Mostrar") : "Mostra o que você digitar ou colar"}
          >
            {visible ? <IconEyeOff size={18} /> : <IconEye size={18} />}
          </button>
        </div>
        <button className="btn" onClick={() => void save()} disabled={busy || !value.trim()}>
          {busy ? "Salvando…" : "Salvar chave"}
        </button>
        {configured && (
          <button
            className="btn danger"
            onClick={async () => onSettings(await api.clearSecret(secretKey))}
            aria-label={`Remover ${label}`}
          >
            Remover
          </button>
        )}
      </div>
      {error ? <small style={{ color: "var(--danger-ink, #8A2A12)" }}>{error}</small> : hint && <small>{hint}</small>}
    </div>
  );
}

function useDraft<T>(initial: T) {
  const [draft, setDraft] = useState<T>(initial);
  const key = JSON.stringify(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(initial), [key]);
  return [draft, setDraft] as const;
}

function SaveBar({
  onSave,
  dirty,
}: {
  onSave: () => Promise<void>;
  dirty: boolean;
}) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState("");
  return (
    <div className="section-save">
      <button
        className="btn primary"
        disabled={!dirty || state === "saving"}
        onClick={async () => {
          setState("saving");
          try {
            await onSave();
            setState("saved");
            setTimeout(() => setState("idle"), 2500);
          } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
            setState("error");
          }
        }}
      >
        {state === "saving" ? "Salvando…" : "Salvar"}
      </button>
      {state === "saved" && (
        <span className="feedback ok" role="status">
          <IconCheck size={14} /> Configurações salvas
        </span>
      )}
      {state === "error" && (
        <span className="feedback fail" role="alert">
          {msg}
        </span>
      )}
      {dirty && state === "idle" && <span className="feedback" style={{ color: "var(--muted)" }}>Alterações não salvas</span>}
    </div>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- seções

function ConnectionsSection({ settings, onSettings, onConnectWhatsapp }: Omit<Props, "section" | "onSection">) {
  const initial = { nive: settings.nive, evolution: settings.evolution };
  const [d, setD] = useDraft(initial);
  const [niveTest, setNiveTest] = useState<TestResult | null>(null);
  const [evoTest, setEvoTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const embedded = settings.evolution.mode !== "evolution";
  // o modo vale na hora (o botão Conectar usa o modo escolhido)
  const setMode = async (mode: "embedded" | "evolution") => {
    setEvoTest(null);
    const s = await api.saveSettings({ evolution: { mode } });
    onSettings(s);
    setD({ ...d, evolution: { ...d.evolution, mode } });
  };

  const test = async (which: "nive" | "evo") => {
    setTesting(which);
    try {
      await flushPendingSecret();
      // testa com o que está na tela: salva antes o endereço/slug digitados
      if (!same(d, initial)) onSettings(await api.saveSettings(d));
      if (which === "nive") setNiveTest(await api.testNive());
      else setEvoTest(await api.testEvolution());
    } catch (e) {
      const r = { ok: false, message: e instanceof Error ? e.message : String(e) };
      if (which === "nive") setNiveTest(r);
      else setEvoTest(r);
    } finally {
      setTesting(null);
    }
  };

  return (
    <>
      <div className="card">
        <h2 className="card-title">Sistema Nive</h2>
        <p className="card-sub">
          O Nive Atende consulta produtos, estoque, clientes e contas pela API da Nive. Gere a chave no ERP em{" "}
          <b>Integração via API</b> (escopo “Vendas, estoque e cadastros”) e cole aqui.
        </p>
        <div className="stack">
          <div className="grid-2">
            <Text
              label="Endereço da API"
              value={d.nive.baseUrl}
              onChange={(v) => setD({ ...d, nive: { ...d.nive, baseUrl: v } })}
            />
            <Text
              label="Identificador da loja (slug)"
              value={d.nive.storeSlug}
              placeholder="ex.: minha-loja"
              hint="É o nome da loja usado no endereço do ERP."
              onChange={(v) => setD({ ...d, nive: { ...d.nive, storeSlug: v } })}
            />
          </div>
          <SecretField
            label="Chave de API da Nive"
            secretKey="niveApiKey"
            configured={settings.nive.hasApiKey}
            ending={settings.nive.apiKeyEnd}
            placeholder="sl_live_..."
            onSettings={onSettings}
            hint="A chave fica criptografada neste computador."
          />
          <div className="btn-row">
            <button className="btn" onClick={() => test("nive")} disabled={testing === "nive"}>
              {testing === "nive" ? "Testando…" : "Testar conexão"}
            </button>
            <Feedback r={niveTest} />
          </div>
        </div>
      </div>
      <div className="card">
        <h2 className="card-title">WhatsApp</h2>
        <p className="card-sub">Escolha como o Nive Atende se conecta ao WhatsApp da loja e depois leia o QR Code com o celular.</p>
        <div className="stack">
          <div className="radio-group" role="radiogroup" aria-label="Como conectar o WhatsApp">
            <label>
              <input type="radio" name="waMode" checked={embedded} onChange={() => void setMode("embedded")} />
              <span>
                <b>Dentro do programa</b> (recomendado)
                <br />
                <small style={{ color: "var(--muted)" }}>Não precisa instalar mais nada. É só conectar e ler o QR Code.</small>
              </span>
            </label>
            <label>
              <input type="radio" name="waMode" checked={!embedded} onChange={() => void setMode("evolution")} />
              <span>
                <b>Servidor Evolution externo</b> (avançado)
                <br />
                <small style={{ color: "var(--muted)" }}>Para quem já tem uma Evolution API rodando (por exemplo no Docker).</small>
              </span>
            </label>
          </div>
          {!embedded && (
            <>
              <div className="grid-3">
                <Text
                  label="Endereço do servidor"
                  value={d.evolution.baseUrl}
                  onChange={(v) => setD({ ...d, evolution: { ...d.evolution, baseUrl: v } })}
                />
                <Text
                  label="Nome da instância"
                  value={d.evolution.instanceName}
                  onChange={(v) => setD({ ...d, evolution: { ...d.evolution, instanceName: v } })}
                />
                <Num
                  label="Porta para receber mensagens"
                  value={d.evolution.webhookPort}
                  min={1024}
                  max={65535}
                  onChange={(v) => setD({ ...d, evolution: { ...d.evolution, webhookPort: v } })}
                />
              </div>
              <SecretField
                label="Chave do servidor (apikey)"
                secretKey="evolutionApiKey"
                configured={settings.evolution.hasApiKey}
                ending={settings.evolution.apiKeyEnd}
                placeholder="a mesma AUTHENTICATION_API_KEY da Evolution"
                onSettings={onSettings}
              />
            </>
          )}
          <div className="btn-row">
            <button className="btn" onClick={() => test("evo")} disabled={testing === "evo"}>
              {testing === "evo" ? "Testando…" : "Testar"}
            </button>
            <button className="btn primary" onClick={onConnectWhatsapp}>
              Conectar WhatsApp
            </button>
            <button className="btn danger" onClick={() => void api.whatsappLogout()}>
              Desconectar
            </button>
            <Feedback r={evoTest} />
          </div>
        </div>
      </div>
      <SaveBar dirty={!same(d, initial)} onSave={async () => onSettings(await api.saveSettings(d))} />
    </>
  );
}

function AiSection({ settings, onSettings }: Pick<Props, "settings" | "onSettings">) {
  const initial = settings.openai;
  const [d, setD] = useDraft(initial);
  const [r, setR] = useState<TestResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const aiInit = settings.ai;
  const [ai, setAi] = useDraft(aiInit);

  const test = async () => {
    setTesting(true);
    try {
      await flushPendingSecret();
      const res = await api.testOpenAI();
      setR(res);
      if (res.models?.length) setModels(res.models);
    } catch (e) {
      setR({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const modelOptions = Array.from(new Set([d.model, ...models].filter(Boolean)));

  return (
    <>
      <div className="card">
        <h2 className="card-title">Como criar sua chave da OpenAI e colocar créditos</h2>
        <p className="card-sub">
          A IA é da OpenAI (a mesma empresa do ChatGPT). Você paga direto para ela, só o que usar. Leva uns 5 minutos.
        </p>
        <ol className="guide">
          <li>
            <div>
              <b>Crie uma conta</b> em <Ext href="https://platform.openai.com">platform.openai.com</Ext>. Pode usar o
              mesmo login do ChatGPT.
              <div className="callout" style={{ marginTop: 8 }}>
                Atenção: a assinatura do <b>ChatGPT Plus não inclui créditos para programas</b>. São cobranças
                separadas.
              </div>
            </div>
          </li>
          <li>
            <div>
              <b>Cadastre um cartão.</b> Abra{" "}
              <Ext href="https://platform.openai.com/settings/organization/billing/overview">
                Settings › Billing (Configurações › Cobrança)
              </Ext>{" "}
              e clique em <b>Add payment details</b>.
            </div>
          </li>
          <li>
            <div>
              <b>Coloque créditos.</b> Na mesma página, clique em <b>Add to credit balance</b> e escolha o valor (o
              mínimo costuma ser US$ 5). Recomendamos o modo <b>pré-pago</b> e <b>desligar a recarga automática</b>:
              assim você só gasta o que colocou.
            </div>
          </li>
          <li>
            <div>
              <b>Crie a chave.</b> Abra <Ext href="https://platform.openai.com/api-keys">API keys</Ext>, clique em{" "}
              <b>Create new secret key</b> e dê o nome <b>Nive Atende</b>.
            </div>
          </li>
          <li>
            <div>
              <b>Copie a chave</b> (começa com <code>sk-</code>). Ela <b>só aparece uma vez</b>. Se perder, é só criar
              outra.
            </div>
          </li>
          <li>
            <div>
              <b>Cole a chave abaixo</b> e clique em <b>Testar</b>. Se der erro de saldo, confira se o crédito foi
              adicionado.
            </div>
          </li>
          <li>
            <div>
              <b>Acompanhe o gasto</b> em <Ext href="https://platform.openai.com/settings/organization/usage">Usage</Ext>{" "}
              no site da OpenAI, ou na tela <b>Consumo</b> deste programa.
            </div>
          </li>
        </ol>
        <p className="card-sub" style={{ marginTop: 14, marginBottom: 0 }}>
          Os nomes dos menus no site da OpenAI podem mudar com o tempo. Se não encontrar algum, procure por “Billing” e
          “API keys”.
        </p>
      </div>
      <div className="card">
        <h2 className="card-title">Chave e modelo</h2>
        <div className="stack">
          <SecretField
            label="Chave da OpenAI"
            secretKey="openaiApiKey"
            configured={settings.openai.hasApiKey}
            ending={settings.openai.apiKeyEnd}
            placeholder="sk-..."
            onSettings={onSettings}
            hint="A chave fica criptografada neste computador e nunca é enviada para a Nive."
          />
          <div className="btn-row">
            <button className="btn" onClick={test} disabled={testing}>
              {testing ? "Testando…" : "Testar"}
            </button>
            <Feedback r={r} />
          </div>
          <div className="grid-2">
            <label className="field">
              <span>Modelo das respostas</span>
              <input
                className="input"
                list="model-options"
                value={d.model}
                onChange={(e) => setD({ ...d, model: e.target.value })}
              />
              <datalist id="model-options">
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <small>Os modelos “mini” são os mais baratos e respondem bem. Clique em Testar para listar os disponíveis.</small>
            </label>
            <Text
              label="Modelo de transcrição de áudio"
              value={d.transcribeModel}
              onChange={(v) => setD({ ...d, transcribeModel: v })}
              hint="Usado para entender os áudios dos clientes."
            />
          </div>
          <div className="grid-2">
            <Num
              label="Alerta de gasto mensal (US$)"
              value={ai.monthlyAlertUsd}
              step={1}
              onChange={(v) => setAi({ ...ai, monthlyAlertUsd: v })}
              hint="Avisamos quando o gasto estimado do mês passar deste valor."
            />
            <Num
              label="Máximo de respostas da IA por conversa por dia"
              value={ai.maxAiRepliesPerConversationPerDay}
              min={1}
              onChange={(v) => setAi({ ...ai, maxAiRepliesPerConversationPerDay: v })}
              hint="Depois disso, a conversa passa para você."
            />
            <Num
              label="Mensagens anteriores que a IA lê"
              value={ai.historyMessages ?? 40}
              min={6}
              max={100}
              onChange={(v) => setAi({ ...ai, historyMessages: v })}
              hint="Quanto mais, melhor ela lembra da conversa (e um pouco maior o custo). Padrão: 40."
            />
          </div>
        </div>
      </div>
      <SaveBar
        dirty={!same(d, initial) || !same(ai, aiInit)}
        onSave={async () =>
          onSettings(
            await api.saveSettings({
              openai: { model: d.model.trim(), transcribeModel: d.transcribeModel.trim() },
              ai,
            }),
          )
        }
      />
    </>
  );
}

const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function AttendanceSection({ settings, onSettings }: Pick<Props, "settings" | "onSettings">) {
  const initial = settings.attendance;
  const [d, setD] = useDraft(initial);
  const [ignoredText, setIgnoredText] = useState(initial.ignoredNumbers.join("\n"));
  const ignoredKey = initial.ignoredNumbers.join("\n");
  useEffect(() => setIgnoredText(ignoredKey), [ignoredKey]);
  const ignored = ignoredText
    .split(/\n|,/)
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
  const draft = { ...d, ignoredNumbers: ignored };
  const bh = d.businessHours;
  return (
    <>
      <div className="card">
        <h2 className="card-title">Atendimento automático</h2>
        <div className="stack">
          <Check
            label="Responder automaticamente os clientes"
            checked={d.autoEnabled}
            onChange={(v) => setD({ ...d, autoEnabled: v })}
            hint="Desligado, o programa só mostra as conversas; ninguém recebe resposta automática."
          />
          <Check
            label="Responder só assuntos da loja"
            checked={d.onlyStoreTopics ?? true}
            onChange={(v) => setD({ ...d, onlyStoreTopics: v })}
            hint="Antes de responder, a IA confere se a mensagem é sobre a loja. Conversa pessoal (família, amigos, fornecedores) fica sem resposta automática, para você responder."
          />
          <Check
            label="Respeitar horário de funcionamento"
            checked={bh.enabled}
            onChange={(v) => setD({ ...d, businessHours: { ...bh, enabled: v } })}
          />
          {bh.enabled && (
            <>
              <div className="field">
                <span className="field-label">Dias de funcionamento</span>
                <div className="days" role="group" aria-label="Dias de funcionamento">
                  {DAY_NAMES.map((name, i) => (
                    <button
                      key={name}
                      className="day-toggle"
                      aria-pressed={bh.days.includes(i)}
                      onClick={() =>
                        setD({
                          ...d,
                          businessHours: {
                            ...bh,
                            days: bh.days.includes(i) ? bh.days.filter((x) => x !== i) : [...bh.days, i].sort(),
                          },
                        })
                      }
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid-3">
                <Text label="Abre às" type="time" value={bh.start} onChange={(v) => setD({ ...d, businessHours: { ...bh, start: v } })} />
                <Text label="Fecha às" type="time" value={bh.end} onChange={(v) => setD({ ...d, businessHours: { ...bh, end: v } })} />
              </div>
              <label className="field">
                <span>Mensagem fora do horário</span>
                <textarea
                  className="textarea"
                  value={d.outOfHoursMessage}
                  onChange={(e) => setD({ ...d, outOfHoursMessage: e.target.value })}
                />
                <small>Enviada uma vez por conversa quando alguém chama fora do horário.</small>
              </label>
            </>
          )}
        </div>
      </div>
      <div className="card">
        <h2 className="card-title">Ritmo e pausas</h2>
        <div className="stack">
          <div className="grid-3">
            <Num label="Espera mínima antes de responder (s)" value={d.replyDelayMinSec} onChange={(v) => setD({ ...d, replyDelayMinSec: v })} />
            <Num label="Espera máxima (s)" value={d.replyDelayMaxSec} onChange={(v) => setD({ ...d, replyDelayMaxSec: v })} />
            <Num
              label="Pausar a IA quando você responder (min)"
              value={d.pauseOnHumanMinutes}
              onChange={(v) => setD({ ...d, pauseOnHumanMinutes: v })}
            />
          </div>
          <small style={{ color: "var(--muted)" }}>
            A espera deixa a conversa mais natural e junta mensagens que o cliente manda em sequência.
          </small>
          <Num
            label="Responder mensagens recebidas com o programa fechado até (min)"
            value={d.catchUpWindowMinutes}
            onChange={(v) => setD({ ...d, catchUpWindowMinutes: v })}
            hint="Ao abrir o programa, mensagens mais antigas que isso ficam para você responder."
          />
          <label className="field">
            <span>Números ignorados (um por linha)</span>
            <textarea
              className="textarea"
              value={ignoredText}
              placeholder={"5548999990000\n5547988887777"}
              onChange={(e) => setIgnoredText(e.target.value)}
            />
            <small>Fornecedores, família, equipe: a IA nunca responde esses números.</small>
          </label>
        </div>
      </div>
      <SaveBar dirty={!same(draft, initial)} onSave={async () => onSettings(await api.saveSettings({ attendance: draft }))} />
    </>
  );
}

function ReservationSection({ settings, onSettings }: Pick<Props, "settings" | "onSettings">) {
  const initial = settings.reservation;
  const [d, setD] = useDraft(initial);
  return (
    <>
      <div className="card">
        <h2 className="card-title">Reserva de produtos</h2>
        <p className="card-sub">
          Quando o cliente pede para separar um produto, a reserva entra no sistema Nive como uma <b>venda em
          rascunho</b>.
        </p>
        <div className="stack">
          <Check
            label="Reserva automática"
            checked={d.autoEnabled}
            onChange={(v) => setD({ ...d, autoEnabled: v })}
            hint={
              d.autoEnabled
                ? "Ligada: o produto já fica reservado e o rascunho é criado na hora."
                : "Desligada: o sistema responde “vou pedir pra separarem” e a reserva espera sua aprovação em Pendências."
            }
          />
          <div className="grid-3">
            <Num label="Validade da reserva (horas)" value={d.validityHours} min={1} onChange={(v) => setD({ ...d, validityHours: v })} />
            <Num label="Máximo de unidades por pedido" value={d.maxQtyPerOrder} min={1} onChange={(v) => setD({ ...d, maxQtyPerOrder: v })} />
          </div>
          <Check
            label="Exigir cliente cadastrado para reservar"
            checked={d.requireCustomer}
            onChange={(v) => setD({ ...d, requireCustomer: v })}
            hint="Se o número não estiver no cadastro, a reserva fica para você aprovar."
          />
          <Check
            label="Cancelar o rascunho quando a reserva vencer"
            checked={d.cancelExpiredDrafts ?? true}
            onChange={(v) => setD({ ...d, cancelExpiredDrafts: v })}
            hint="Se a venda não for finalizada até o fim da validade, o rascunho é cancelado no sistema Nive e as peças voltam ao estoque. Venda já finalizada nunca é mexida."
          />
          <p className="card-sub" style={{ margin: 0 }}>
            Quando o cliente não está identificado, a IA pergunta em nome de quem fica a reserva. O sistema procura esse
            nome no cadastro e, se não encontrar, cadastra o cliente novo (nome e telefone) ao lançar o rascunho.
          </p>
        </div>
      </div>
      <SaveBar dirty={!same(d, initial)} onSave={async () => onSettings(await api.saveSettings({ reservation: d }))} />
    </>
  );
}

function AccountsSection({ settings, onSettings }: Pick<Props, "settings" | "onSettings">) {
  const initial = settings.accounts;
  const [d, setD] = useDraft(initial);
  return (
    <>
      <div className="card">
        <h2 className="card-title">Contas dos clientes</h2>
        <p className="card-sub">
          Cada cliente só consulta o que é dele. Quem chama do telefone que está no cadastro é identificado na hora.
        </p>
        <div className="stack">
          <Check
            label="Responder quanto o cliente tem para pagar, parcelas e itens"
            checked={d.enabled}
            onChange={(v) => setD({ ...d, enabled: v })}
          />
          <div className="field">
            <span className="field-label">Quando o cliente chama de um número que não está no cadastro</span>
            <div className="radio-group" role="radiogroup">
              <label>
                <input
                  type="radio"
                  name="secondFactor"
                  checked={d.secondFactor === "birthdate"}
                  onChange={() => setD({ ...d, secondFactor: "birthdate" })}
                />
                <span>
                  Pedir o CPF <b>e a data de nascimento</b> antes de mostrar valores
                  <br />
                  <small style={{ color: "var(--muted)" }}>Recomendado. Só o CPF não basta: ele aparece em notas e cadastros.</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="secondFactor"
                  checked={d.secondFactor === "restricted"}
                  onChange={() => setD({ ...d, secondFactor: "restricted" })}
                />
                <span>
                  Modo restrito: só dizer que há valores em aberto e oferecer enviar o detalhe para o número do cadastro
                </span>
              </label>
            </div>
          </div>
          <Check label="Mostrar juros e multa calculados" checked={d.showCharges} onChange={(v) => setD({ ...d, showCharges: v })} />
          <div className="callout info">
            O sistema nunca confirma se um CPF está cadastrado, nunca mostra dados de outra pessoa e bloqueia o número
            depois de 3 tentativas erradas. Toda consulta fica registrada em Consumo.
          </div>
        </div>
      </div>
      <SaveBar dirty={!same(d, initial)} onSave={async () => onSettings(await api.saveSettings({ accounts: d }))} />
    </>
  );
}

function PersonalitySection({ settings, onSettings }: Pick<Props, "settings" | "onSettings">) {
  const initial = settings.personality;
  const [d, setD] = useDraft(initial);
  return (
    <>
      <div className="card">
        <h2 className="card-title">Como a loja fala</h2>
        <div className="stack">
          <div className="grid-2">
            <Text label="Nome da loja" value={d.storeName} onChange={(v) => setD({ ...d, storeName: v })} />
            <label className="field">
              <span>Tom de voz</span>
              <select className="select" value={d.tone} onChange={(e) => setD({ ...d, tone: e.target.value as typeof d.tone })}>
                <option value="formal">Formal</option>
                <option value="proximo">Próximo</option>
                <option value="descontraido">Descontraído</option>
              </select>
            </label>
          </div>
          <Check label="Usar emojis nas respostas" checked={d.emojis} onChange={(v) => setD({ ...d, emojis: v })} />
          <Text
            label="Assinatura (opcional)"
            value={d.signature}
            placeholder="ex.: Equipe Loja Exemplo"
            onChange={(v) => setD({ ...d, signature: v })}
          />
          <Check
            label="Apresentar-se como assistente virtual da loja"
            checked={d.presentAsAssistant}
            onChange={(v) => setD({ ...d, presentAsAssistant: v })}
            hint="Mesmo desligado, se o cliente perguntar se é robô, o sistema não nega e oferece chamar uma pessoa."
          />
        </div>
      </div>
      <div className="card">
        <h2 className="card-title">Contexto e personalidade da IA</h2>
        <label className="field">
          <span>Escreva como você quer que a IA atenda e o que ela precisa saber da loja</span>
          <textarea
            className="textarea"
            rows={9}
            maxLength={3000}
            value={d.context ?? ""}
            placeholder={CONTEXT_PLACEHOLDER}
            onChange={(e) => setD({ ...d, context: e.target.value })}
          />
          <small>
            Ex.: quem é o público, o que a loja vende mais, marcas que você destaca, horário, se entrega, formas de pagamento,
            jeito de falar. As regras de segurança (contas, preços e descontos) continuam valendo. {(d.context ?? "").length}/3000
          </small>
        </label>
      </div>
      <SaveBar dirty={!same(d, initial)} onSave={async () => onSettings(await api.saveSettings({ personality: d }))} />
    </>
  );
}

function AudioSection({ settings, onSettings }: Pick<Props, "settings" | "onSettings">) {
  const initial = settings.audio;
  const [d, setD] = useDraft(initial);
  return (
    <>
      <div className="card">
        <h2 className="card-title">Mensagens de áudio</h2>
        <div className="stack">
          <Check
            label="Transcrever áudios recebidos e responder com IA"
            checked={d.transcribe}
            onChange={(v) => setD({ ...d, transcribe: v })}
            hint="A transcrição aparece embaixo do áudio para você conferir. O custo sai da mesma chave da OpenAI."
          />
          <div className="grid-3">
            <Num
              label="Duração máxima para resposta automática (s)"
              value={d.maxSeconds}
              min={5}
              onChange={(v) => setD({ ...d, maxSeconds: v })}
              hint="Áudios mais longos passam para você."
            />
          </div>
        </div>
      </div>
      <SaveBar dirty={!same(d, initial)} onSave={async () => onSettings(await api.saveSettings({ audio: d }))} />
    </>
  );
}

function AppSection({ settings, onSettings }: Pick<Props, "settings" | "onSettings">) {
  const initial = settings.app;
  const [d, setD] = useDraft(initial);
  const [version, setVersion] = useState("");
  useEffect(() => {
    void api.getAppInfo().then((i) => setVersion(i.version));
  }, []);
  return (
    <>
      <div className="card">
        <h2 className="card-title">Programa</h2>
        <div className="stack">
          <Check
            label="Iniciar junto com o computador"
            checked={d.launchAtLogin}
            onChange={(v) => setD({ ...d, launchAtLogin: v })}
            hint="O programa abre minimizado ao lado do relógio e já começa a atender."
          />
          <div className="grid-2">
            <label className="field">
              <span>Notificações</span>
              <select
                className="select"
                value={d.notify}
                onChange={(e) => setD({ ...d, notify: e.target.value as typeof d.notify })}
              >
                <option value="humano">Só conversas que precisam de mim</option>
                <option value="todas">Todas as mensagens</option>
                <option value="nenhuma">Nenhuma</option>
              </select>
            </label>
            <Text
              label="Seu nome (aparece nas respostas pelo app)"
              value={d.operatorName}
              onChange={(v) => setD({ ...d, operatorName: v })}
            />
          </div>
          <Check label="Tocar som nas notificações" checked={d.sound} onChange={(v) => setD({ ...d, sound: v })} />
          <Text
            label="Seu celular pessoal para alertas (opcional)"
            value={d.ownerAlertNumber}
            placeholder="5548999990000"
            hint="Se o atendimento parar por um motivo que não seja o WhatsApp (ex.: IA sem crédito), avisamos neste número."
            onChange={(v) => setD({ ...d, ownerAlertNumber: v.replace(/[^\d]/g, "") })}
          />
        </div>
      </div>
      <SaveBar dirty={!same(d, initial)} onSave={async () => onSettings(await api.saveSettings({ app: d }))} />
      <div className="btn-row" style={{ marginTop: 20 }}>
        {version && <span className="card-sub" style={{ margin: 0 }}>Nive Atende versão {version}</span>}
        <button className="btn" onClick={() => void api.openLogs()}>
          Abrir registros (para suporte)
        </button>
      </div>
    </>
  );
}

export function SettingsPage(props: Props) {
  const { section, onSection, settings, onSettings, onConnectWhatsapp } = props;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Seções de ajustes">
        <h2>Ajustes</h2>
        {SECTIONS.map((s) => (
          <button key={s.id} aria-current={section === s.id ? "true" : undefined} onClick={() => onSection(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="page">
        <div className="page-pad" style={{ maxWidth: 900 }}>
          {section === "conexoes" && (
            <ConnectionsSection settings={settings} onSettings={onSettings} onConnectWhatsapp={onConnectWhatsapp} />
          )}
          {section === "ia" && <AiSection settings={settings} onSettings={onSettings} />}
          {section === "atendimento" && <AttendanceSection settings={settings} onSettings={onSettings} />}
          {section === "reserva" && <ReservationSection settings={settings} onSettings={onSettings} />}
          {section === "contas" && <AccountsSection settings={settings} onSettings={onSettings} />}
          {section === "personalidade" && <PersonalitySection settings={settings} onSettings={onSettings} />}
          {section === "audio" && <AudioSection settings={settings} onSettings={onSettings} />}
          {section === "app" && <AppSection settings={settings} onSettings={onSettings} />}
        </div>
      </div>
    </div>
  );
}

