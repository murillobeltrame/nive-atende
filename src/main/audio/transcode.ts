// Converte o áudio do WhatsApp (OGG/Opus, que a transcrição da OpenAI não aceita) para MP3, na própria máquina.
import { spawn } from "node:child_process";

export type Transcoder = (input: Uint8Array) => Promise<Uint8Array>;

function resolveFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require("ffmpeg-static") as string | null;
    if (!p) return null;
    // Dentro do instalador, o binário fica fora do .asar
    return p.replace("app.asar", "app.asar.unpacked");
  } catch {
    return null;
  }
}

export function createFfmpegTranscoder(ffmpegPath: string | null = resolveFfmpeg()): Transcoder {
  return (input) =>
    new Promise((resolve, reject) => {
      if (!ffmpegPath) {
        reject(new Error("ffmpeg não encontrado"));
        return;
      }
      const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "pipe:1"]);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("conversão de áudio demorou demais"));
      }, 60_000);
      proc.stdout.on("data", (c: Buffer) => out.push(c));
      proc.stderr.on("data", (c: Buffer) => err.push(c));
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(new Uint8Array(Buffer.concat(out)));
        else reject(new Error(`ffmpeg saiu com código ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
      });
      proc.stdin.on("error", () => undefined);
      proc.stdin.end(Buffer.from(input));
    });
}
