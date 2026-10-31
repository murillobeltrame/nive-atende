import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../shared/types";
import { api } from "../lib/api";
import { hhmm } from "../lib/format";
import { IconFile, IconImage, IconMapPin, IconPause, IconPlay, IconRepeat } from "./Icons";
import { HumanTag, IaTag } from "./Tag";
import { WaText } from "./WaText";

const mediaCache = new Map<string, string | null>();

function useMedia(messageId: string, auto: boolean) {
  const [url, setUrl] = useState<string | null | undefined>(mediaCache.get(messageId));
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (mediaCache.has(messageId)) {
      const cached = mediaCache.get(messageId) ?? null;
      setUrl(cached);
      return cached;
    }
    setLoading(true);
    try {
      const u = await api.getMedia(messageId);
      mediaCache.set(messageId, u);
      setUrl(u);
      return u;
    } catch {
      setUrl(null);
      return null;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (auto && url === undefined) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, auto]);
  return { url, loading, load };
}

const WAVE = [8, 16, 22, 12, 18, 9, 20, 14, 24, 10, 16, 7, 13, 19, 8, 15, 11, 6, 17, 12, 9, 21];

function fmtDur(s: number | null): string {
  if (!s || !Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function AudioPlayer({ m }: { m: ChatMessage }) {
  const { load, loading } = useMedia(m.id, false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(false);

  const toggle = async () => {
    if (playing && audioRef.current) {
      audioRef.current.pause();
      return;
    }
    let a = audioRef.current;
    if (!a) {
      const src = await load();
      if (!src) {
        setError(true);
        return;
      }
      a = new Audio(src);
      a.addEventListener("timeupdate", () => a && setProgress(a.duration ? a.currentTime / a.duration : 0));
      a.addEventListener("play", () => setPlaying(true));
      a.addEventListener("pause", () => setPlaying(false));
      a.addEventListener("ended", () => {
        setPlaying(false);
        setProgress(0);
      });
      audioRef.current = a;
    }
    try {
      await a.play();
    } catch {
      setError(true);
    }
  };
  useEffect(() => () => audioRef.current?.pause(), []);

  const on = Math.round(progress * WAVE.length);
  return (
    <div>
      <div className="audio">
        <button
          className="audio-play"
          onClick={toggle}
          disabled={loading}
          aria-label={playing ? "Pausar áudio" : "Ouvir áudio"}
        >
          {playing ? <IconPause size={14} /> : <IconPlay size={13} />}
        </button>
        <div className="wave" aria-hidden="true">
          {WAVE.map((h, i) => (
            <span key={i} className={i < on ? "on" : ""} style={{ height: h }} />
          ))}
        </div>
        <span className="audio-dur">{fmtDur(m.durationSec)}</span>
      </div>
      {error && <div className="composer-error">Não foi possível carregar o áudio.</div>}
    </div>
  );
}

function ImageMedia({ m }: { m: ChatMessage }) {
  const { url, loading, load } = useMedia(m.id, true);
  if (url)
    return (
      <img className="media-img" src={url} alt={m.kind === "image" ? "Imagem enviada na conversa" : "Vídeo"} />
    );
  return (
    <button className="media-placeholder" onClick={() => void load()} disabled={loading}>
      <IconImage size={26} />
      {loading ? "Carregando imagem…" : url === null ? "Imagem indisponível · tentar de novo" : "Carregar imagem"}
    </button>
  );
}

function Sticker({ m, onResend }: { m: ChatMessage; onResend?: () => void }) {
  const { url } = useMedia(m.id, true);
  return (
    <div className="sticker-wrap">
      {url ? (
        <img className="sticker" src={url} alt="Figurinha" />
      ) : (
        <div className="sticker" role="img" aria-label="Figurinha" style={{ background: "#fff6d9", borderRadius: 14 }} />
      )}
      {onResend && (
        <button className="icon-btn sm" onClick={onResend} aria-label="Reenviar esta figurinha" title="Reenviar figurinha">
          <IconRepeat size={15} />
        </button>
      )}
    </div>
  );
}

function Body({ m, onResendSticker }: { m: ChatMessage; onResendSticker?: () => void }) {
  return (
    <>
      {m.kind === "audio" && <AudioPlayer m={m} />}
      {(m.kind === "image" || m.kind === "video") && m.hasMedia && <ImageMedia m={m} />}
      {m.kind === "document" && (
        <div className="doc">
          <IconFile size={22} />
          <div>
            <div className="doc-name">{m.fileName ?? "Documento"}</div>
            <div className="sub" style={{ fontSize: 11.5, color: "var(--muted)" }}>
              {m.mediaMime ?? "arquivo"}
            </div>
          </div>
        </div>
      )}
      {m.kind === "location" && (
        <div className="doc">
          <IconMapPin size={20} />
          <span>Localização compartilhada</span>
        </div>
      )}
      {m.kind === "contact" && (
        <div className="doc">
          <IconFile size={20} />
          <span>Contato compartilhado</span>
        </div>
      )}
      {m.kind === "sticker" && <Sticker m={m} onResend={onResendSticker} />}
      {m.text && m.kind !== "sticker" && <WaText text={m.text} />}
      {!m.text && m.kind === "image" && m.origin === "ia" && m.fileName && <span className="media-caption">{m.fileName}</span>}
      {m.kind === "unknown" && !m.text && <i>Mensagem sem pré-visualização</i>}
      {m.transcript && (
        <div className="transcript">
          <b>Transcrição: </b>
          {m.transcript}
        </div>
      )}
    </>
  );
}

function Deleted({ m }: { m: ChatMessage }) {
  const [show, setShow] = useState(false);
  const original = m.transcript ?? m.text;
  return (
    <div className="deleted">
      <i>🚫 Mensagem apagada</i>
      {original && (
        <button className="link-btn" onClick={() => setShow(!show)}>
          {show ? "ocultar" : "ver original"}
        </button>
      )}
      {show && original && <div className="deleted-original">{original}</div>}
    </div>
  );
}

function DeleteControl({ m }: { m: ChatMessage }) {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (step !== "confirm") return;
    const t = setTimeout(() => setStep("idle"), 6000);
    return () => clearTimeout(t);
  }, [step]);
  if (m.status !== "sent" || !m.waMessageId) return null;
  const run = async () => {
    setStep("busy");
    setError(null);
    try {
      await api.deleteMessage(m.id);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Não foi possível apagar.");
      setStep("idle");
    }
  };
  return (
    <span className="del-ctl">
      {step === "idle" && (
        <button className="link-btn del" onClick={() => setStep("confirm")} title="Apagar para todos">
          Apagar
        </button>
      )}
      {step === "confirm" && (
        <>
          <button className="link-btn del strong" onClick={() => void run()}>
            Apagar para todos?
          </button>
          <button className="link-btn" onClick={() => setStep("idle")}>
            cancelar
          </button>
        </>
      )}
      {step === "busy" && <span>apagando…</span>}
      {error && <span className="del-err">{error}</span>}
    </span>
  );
}

function statusLabel(m: ChatMessage): string {
  if (m.status === "pending") return " · enviando…";
  return " · " + hhmm(m.createdAt) + (m.status === "sent" ? " ✓✓" : "");
}

export function MessageBubble({
  m,
  onResendSticker,
}: {
  m: ChatMessage;
  onResendSticker?: (messageId: string) => void;
}) {
  if (m.origin === "sistema") {
    return <div className={`sys ${m.eventType ?? ""}`}>{m.text} · {hhmm(m.createdAt)}</div>;
  }
  if (m.origin === "consumidor" && m.status === "deleted") {
    return (
      <div className="msg in">
        <div className="bubble cli">
          <Deleted m={m} />
          <span className="bubble-time">{hhmm(m.createdAt)}</span>
        </div>
      </div>
    );
  }
  if (m.origin === "consumidor") {
    const bare = m.kind === "sticker";
    return (
      <div className="msg in">
        {bare ? (
          <Body m={m} onResendSticker={onResendSticker ? () => onResendSticker(m.id) : undefined} />
        ) : (
          <div className="bubble cli">
            <Body m={m} />
            <span className="bubble-time">{hhmm(m.createdAt)}</span>
          </div>
        )}
        {bare && <span className="audio-dur">{hhmm(m.createdAt)}</span>}
      </div>
    );
  }
  const isIa = m.origin === "ia";
  const failed = m.status === "failed";
  const deleted = m.status === "deleted";
  return (
    <div className="msg out">
      {deleted ? (
        <div className={`bubble ${isIa ? "ia" : "human"}`}>
          <Deleted m={m} />
        </div>
      ) : m.kind === "sticker" ? (
        <Body m={m} />
      ) : (
        <div className={`bubble ${isIa ? "ia" : "human"}`}>
          <Body m={m} />
        </div>
      )}
      <div className={`msg-tagline ${failed ? "fail" : isIa ? "ia" : "human"}`}>
        {isIa ? <IaTag /> : <HumanTag phone={m.origin === "humano_celular"} />}
        {deleted ? (
          <span>apagada para todos · {hhmm(m.createdAt)}</span>
        ) : failed ? (
          <span>Falhou ao enviar · {hhmm(m.createdAt)}</span>
        ) : isIa ? (
          <span>resposta automática{statusLabel(m)}</span>
        ) : m.origin === "humano_celular" ? (
          <span>pelo celular{statusLabel(m)}</span>
        ) : (
          <span>
            {m.author ? `${m.author} · ` : ""}pelo app{statusLabel(m)}
          </span>
        )}
        {!deleted && <DeleteControl m={m} />}
      </div>
    </div>
  );
}
