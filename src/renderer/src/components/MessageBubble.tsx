import { useEffect, useRef, useState } from "react";
import { MapPreview } from "./MapPreview";
import type { ChatMessage } from "../../../shared/types";
import { api } from "../lib/api";
import { hhmm } from "../lib/format";
import {
  IconAlert,
  IconBan,
  IconCheckCheck,
  IconClock,
  IconFile,
  IconImage,
  IconMapPin,
  IconPause,
  IconPhone,
  IconPlay,
  IconRepeat,
  IconSpark,
  IconTrash,
  IconUser,
  IconX,
} from "./Icons";
import { ImageViewer } from "./ImageViewer";
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
          {playing ? <IconPause size={20} /> : <IconPlay size={20} />}
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
  const [open, setOpen] = useState(false);
  if (url) {
    const alt = m.kind === "image" ? "Imagem enviada na conversa" : "Vídeo";
    if (m.kind !== "image") return <img className="media-img" src={url} alt={alt} />;
    return (
      <>
        <button className="media-zoom" onClick={() => setOpen(true)} aria-label="Ampliar foto" title="Clique para ampliar">
          <img className="media-img" src={url} alt={alt} />
        </button>
        {open && <ImageViewer src={url} alt={alt} onClose={() => setOpen(false)} />}
      </>
    );
  }
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
          <span className="doc-icon">
            <IconFile size={20} />
          </span>
          <div className="doc-text">
            <div className="doc-name">{m.fileName ?? "Documento"}</div>
            <div className="doc-sub">{m.mediaMime ?? "arquivo"}</div>
          </div>
        </div>
      )}
      {m.kind === "location" &&
        (m.geo ? (
          <MapPreview lat={m.geo.lat} lng={m.geo.lng} label={m.text ?? undefined} />
        ) : (
          <div className="doc">
            <span className="doc-icon">
              <IconMapPin size={20} />
            </span>
            <span className="doc-name">Localização compartilhada</span>
          </div>
        ))}
      {m.kind === "contact" && (
        <div className="doc">
          <span className="doc-icon">
            <IconUser size={20} />
          </span>
          <span className="doc-name">Contato compartilhado</span>
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
      <span className="deleted-label">
        <IconBan size={15} />
        Mensagem apagada
      </span>
      {original && (
        <button className="link-btn" onClick={() => setShow(!show)}>
          {show ? "ocultar" : "ver original"}
        </button>
      )}
      {show && original && <div className="deleted-original">{original}</div>}
    </div>
  );
}

/** "Apagar para todos": lixeira que aparece ao passar o mouse, com confirmação ao lado da bolha. */
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
    <span className={`del-ctl${step !== "idle" || error ? " open" : ""}`}>
      {step === "idle" && (
        <button className="icon-btn sm" onClick={() => setStep("confirm")} aria-label="Apagar para todos" title="Apagar para todos">
          <IconTrash size={15} />
        </button>
      )}
      {step === "confirm" && (
        <span className="del-confirm">
          <button className="link-btn del strong" onClick={() => void run()}>
            <IconTrash size={13} />
            Apagar para todos?
          </button>
          <button className="icon-btn sm" onClick={() => setStep("idle")} aria-label="Cancelar" title="Cancelar">
            <IconX size={13} />
          </button>
        </span>
      )}
      {step === "busy" && <span className="del-confirm">apagando…</span>}
      {error && <span className="del-confirm del-err">{error}</span>}
    </span>
  );
}

/**
 * Chave de agrupamento: mensagens seguidas de quem é a mesma pessoa ficam coladas, como no WhatsApp,
 * e só a primeira ganha a ponta da bolha e o nome de quem respondeu.
 */
export function groupKey(m: ChatMessage): string {
  if (m.origin === "sistema") return "sys";
  if (m.origin === "consumidor") return "in";
  return `out|${m.origin}|${m.author ?? ""}`;
}

/** Quem respondeu (IA, pessoa pelo app ou pelo celular), no topo da primeira bolha do grupo. */
function Sender({ m }: { m: ChatMessage }) {
  if (m.origin === "ia")
    return (
      <span className="bubble-sender ia">
        <IconSpark size={12} />
        IA
      </span>
    );
  if (m.origin === "humano_celular")
    return (
      <span className="bubble-sender human">
        <IconPhone size={12} />
        Pelo celular
      </span>
    );
  return (
    <span className="bubble-sender human">
      <IconUser size={12} />
      {m.author || "Você"}
    </span>
  );
}

/** Hora e situação do envio, no canto de baixo da bolha. */
function Meta({ m, out }: { m: ChatMessage; out?: boolean }) {
  const failed = m.status === "failed";
  return (
    <span className={`bubble-meta${failed ? " fail" : ""}`}>
      {failed && (
        <>
          <IconAlert size={12} />
          Falhou ao enviar ·
        </>
      )}
      {m.status === "deleted" && out && "apagada para todos · "}
      {m.status === "pending" ? "enviando…" : hhmm(m.createdAt)}
      {out && m.status === "pending" && <IconClock size={13} />}
      {out && m.status === "sent" && <IconCheckCheck size={15} className="ticks" />}
    </span>
  );
}

export function MessageBubble({
  m,
  first = true,
  onResendSticker,
}: {
  m: ChatMessage;
  /** primeira mensagem de um grupo (ganha a ponta e o nome de quem respondeu) */
  first?: boolean;
  onResendSticker?: (messageId: string) => void;
}) {
  if (m.origin === "sistema") {
    return (
      <div className={`sys ${m.eventType ?? ""}`}>
        {m.text} · {hhmm(m.createdAt)}
      </div>
    );
  }
  const out = m.origin !== "consumidor";
  const deleted = m.status === "deleted";
  const bare = m.kind === "sticker" && !deleted;
  const tone = !out ? "cli" : m.origin === "ia" ? "ia" : "human";
  const media = !deleted && m.hasMedia && (m.kind === "image" || m.kind === "video");
  return (
    <div className={`msg ${out ? "out" : "in"}${first ? " first" : ""}`}>
      {out && !deleted && <DeleteControl m={m} />}
      {bare ? (
        <div className="bare">
          {out && first && <Sender m={m} />}
          <Body m={m} onResendSticker={!out && onResendSticker ? () => onResendSticker(m.id) : undefined} />
          <Meta m={m} out={out} />
        </div>
      ) : (
        <div className={`bubble ${tone}${first ? " tail" : ""}${media ? " has-media" : ""}`}>
          {out && first && <Sender m={m} />}
          {deleted ? <Deleted m={m} /> : <Body m={m} />}
          <Meta m={m} out={out} />
        </div>
      )}
    </div>
  );
}
