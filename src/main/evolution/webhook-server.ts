// Servidor HTTP local que recebe os eventos da Evolution. Escuta só em 127.0.0.1 e exige um token no caminho.
import { createServer, type Server } from "node:http";
import { parseWebhook, type EvolutionEvent } from "./parse";

const MAX_BODY = 30 * 1024 * 1024; // mídia em base64 pode ser grande

export class WebhookServer {
  private server: Server | null = null;
  private port = 0;

  constructor(
    private readonly token: string,
    private readonly onEvents: (events: EvolutionEvent[]) => void,
  ) {}

  get listeningPort(): number {
    return this.port;
  }

  async start(port: number, host = "127.0.0.1"): Promise<void> {
    await this.stop();
    const expected = `/webhook/${this.token}`;
    this.server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (req.method !== "POST" || !(path === expected || path.startsWith(expected + "/"))) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const events = parseWebhook(body);
          if (events.length) this.onEvents(events);
        } catch {
          // corpo inválido: ignorado
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
