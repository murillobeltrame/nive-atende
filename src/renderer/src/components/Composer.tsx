import { useEffect, useRef, useState } from "react";
import type { Conversation } from "../../../shared/types";
import { api } from "../lib/api";
import { fileToBase64, hhmm } from "../lib/format";
import { IconClip, IconMic, IconSend, IconX } from "./Icons";

const MAX_FILE_BYTES = 16 * 1024 * 1024;

function pickAudioMime(): string {
  const options = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];
  for (const o of options) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(o)) return o;
  }
  return "audio/webm";
}

export function Composer({ conversation }: { conversation: Conversation }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; cancel: boolean; stream: MediaStream } | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setText("");
    setError(null);
  }, [conversation.id]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      recRef.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const paused = conversation.aiPausedUntil && conversation.aiPausedUntil > Date.now();

  const run = async (fn: () => Promise<unknown>) => {
    setSending(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const sendText = () => {
    const value = text.trim();
    if (!value || sending) return;
    void run(async () => {
      await api.sendText(conversation.id, value);
      setText("");
      inputRef.current?.focus();
    });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError("Arquivo muito grande (máximo 16 MB).");
      return;
    }
    const caption = text.trim();
    await run(async () => {
      const base64 = await fileToBase64(file);
      await api.sendMedia(conversation.id, {
        fileName: file.name,
        mime: file.type || "application/octet-stream",
        base64,
        caption: caption || undefined,
      });
      setText("");
    });
    if (fileRef.current) fileRef.current.value = "";
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickAudioMime();
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const state = { rec, chunks: [] as Blob[], cancel: false, stream };
      rec.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) window.clearInterval(timerRef.current);
        setRecording(false);
        if (state.cancel || state.chunks.length === 0) return;
        const blob = new Blob(state.chunks, { type: mime });
        await run(async () => {
          const base64 = await fileToBase64(blob);
          await api.sendAudio(conversation.id, base64, mime.split(";")[0] ?? "audio/webm");
        });
      };
      recRef.current = state;
      rec.start();
      setRecSeconds(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch {
      setError("Não foi possível acessar o microfone. Verifique a permissão do sistema.");
    }
  };

  const stopRecording = (cancel: boolean) => {
    const r = recRef.current;
    if (!r) return;
    r.cancel = cancel;
    if (r.rec.state !== "inactive") r.rec.stop();
    recRef.current = null;
  };

  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const s = await api.suggestReply(conversation.id);
      setText(s);
      inputRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível gerar a sugestão.");
    } finally {
      setSuggesting(false);
    }
  };

  const ignored = conversation.state === "ignorado";

  return (
    <div className="composer">
      <div className={`composer-note ${paused ? "" : "ia"}`}>
        <span>
          <span className="dot" aria-hidden="true" />
          {ignored
            ? "Número ignorado: a IA não responde nesta conversa."
            : paused
              ? `Você está respondendo. A IA não envia nada nesta conversa até ${hhmm(conversation.aiPausedUntil ?? 0)}.`
              : "A IA está atendendo. Se você responder, ela pausa nesta conversa."}
        </span>
        <button className="link-btn" onClick={suggest} disabled={suggesting}>
          {suggesting ? "Gerando sugestão…" : "Sugestão da IA"}
        </button>
      </div>
      <div className="composer-row">
        {recording ? (
          <>
            <button className="icon-btn" onClick={() => stopRecording(true)} aria-label="Cancelar gravação">
              <IconX size={20} />
            </button>
            <div className="recording" role="status">
              <span className="rec-dot" aria-hidden="true" />
              Gravando áudio · {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, "0")}
            </div>
            <button className="send-btn" onClick={() => stopRecording(false)} aria-label="Enviar áudio">
              <IconSend size={18} />
            </button>
          </>
        ) : (
          <>
            <button
              className="icon-btn"
              onClick={() => fileRef.current?.click()}
              aria-label="Anexar imagem, vídeo ou documento"
              disabled={sending}
            >
              <IconClip size={21} />
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <label className="sr-only" htmlFor="composer-input">
              Mensagem
            </label>
            <textarea
              id="composer-input"
              ref={inputRef}
              className="composer-input"
              rows={1}
              placeholder="Digite uma mensagem"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendText();
                }
              }}
            />
            {text.trim() ? (
              <button className="send-btn" onClick={sendText} disabled={sending} aria-label="Enviar mensagem">
                <IconSend size={18} />
              </button>
            ) : (
              <button className="send-btn" onClick={startRecording} disabled={sending} aria-label="Gravar áudio">
                <IconMic size={20} />
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <div className="composer-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
