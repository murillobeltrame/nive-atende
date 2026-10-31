// Integração HTTP real: servidor de webhook e clientes da Nive/Evolution contra servidores falsos locais.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebhookServer } from "../src/main/evolution/webhook-server";
import { NiveClient } from "../src/main/nive/client";
import { EvolutionClient } from "../src/main/evolution/client";
import type { EvolutionEvent } from "../src/main/evolution/parse";

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

async function fakeServer(handler: (req: IncomingMessage, body: string) => { status?: number; json: unknown }): Promise<{ url: string; requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> }> {
  const requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const server: Server = createServer(async (req, res) => {
    const b = await body(req);
    requests.push({ method: req.method!, url: req.url!, headers: req.headers, body: b });
    const out = handler(req, b);
    res.writeHead(out.status ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(out.json));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push({ close: () => server.close() });
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, requests };
}

describe("servidor de webhook", () => {
  it("aceita só o caminho com o token e entrega os eventos", async () => {
    const got: EvolutionEvent[] = [];
    const wh = new WebhookServer("tok123", (evs) => got.push(...evs));
    await wh.start(0);
    servers.push({ close: () => void wh.stop() });
    const base = `http://127.0.0.1:${wh.listeningPort}`;
    const payload = { event: "messages.upsert", data: { key: { remoteJid: "5548999992210@s.whatsapp.net", id: "X1" }, message: { conversation: "oi" } } };

    const wrong = await fetch(`${base}/webhook/errado`, { method: "POST", body: JSON.stringify(payload) });
    expect(wrong.status).toBe(404);
    const ok = await fetch(`${base}/webhook/tok123/messages-upsert`, { method: "POST", body: JSON.stringify(payload) });
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "message", text: "oi" });
  });
});

describe("cliente da API Nive", () => {
  it("envia chave e slug, busca cliente pelo telefone e confere o número", async () => {
    const srv = await fakeServer((req) => {
      if (req.url!.startsWith("/customers?q=")) {
        return {
          json: [
            { id: "c1", name: "Ana", phone: "48999992210", taxId: "52998224725", birthDate: "1990-03-10T00:00:00.000Z" },
            { id: "c2", name: "Outro", phone: "11999992210", taxId: null }, // mesmos 8 dígitos, outro DDD
          ],
        };
      }
      return { status: 404, json: { error: "não" } };
    });
    const nive = new NiveClient(() => ({ baseUrl: srv.url, storeSlug: "loja-x", apiKey: "sl_live_abc" }));
    const found = await nive.findCustomersByPhone("5548999992210");
    expect(found.map((c) => c.id)).toEqual(["c1"]);
    const req = srv.requests[0]!;
    expect(req.headers.authorization).toBe("Bearer sl_live_abc");
    expect(req.headers["x-store-slug"]).toBe("loja-x");
    expect(req.url).toBe("/customers?q=99992210");
  });

  it("monta o extrato só com parcelas e compras em aberto", async () => {
    const srv = await fakeServer(() => ({
      json: {
        customer: { id: "c1", name: "Ana" },
        summary: { openBalance: 340, overdueBalance: 170 },
        details: { orders: [{ orderNumber: 7, balance: 340, originalAmount: 340, items: [{ description: "Vestido", variantLabel: "M", quantity: 1, unitPrice: 340, lineTotal: 340 }] }, { orderNumber: 6, balance: 0, items: [] }] },
        receivables: [
          { status: "OPEN", sale: { orderNumber: 7 }, installments: [{ sequence: 1, amount: 170, balance: 170, dueDate: "2026-10-10", status: "OPEN" }, { sequence: 2, amount: 170, balance: 170, dueDate: "2026-11-10", status: "OPEN" }] },
          { status: "PAID", sale: { orderNumber: 6 }, installments: [{ sequence: 1, amount: 50, balance: 0 }] },
        ],
      },
    }));
    const nive = new NiveClient(() => ({ baseUrl: srv.url, storeSlug: "loja", apiKey: "k" }));
    const st = await nive.getStatement("c1");
    expect(srv.requests[0]!.url).toBe("/receivables/customers/c1/statement");
    expect(st.openBalance).toBe(340);
    expect(st.orders).toHaveLength(1);
    expect(st.installments.map((i) => i.sequence)).toEqual([1, 2]);
  });

  it("cria rascunho com item e observação", async () => {
    const srv = await fakeServer((req) => (req.url === "/sales" ? { status: 201, json: { id: "s1", orderNumber: 77, status: "DRAFT" } } : { json: {} }));
    const nive = new NiveClient(() => ({ baseUrl: srv.url, storeSlug: "loja", apiKey: "k" }));
    const sale = await nive.createDraftSale({ customerId: "c1", variantId: "v1", quantity: 2, notes: "Reserva" });
    expect(sale).toEqual({ id: "s1", orderNumber: 77 });
    expect(srv.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /sales", "POST /sales/s1/items", "PATCH /sales/s1"]);
    expect(JSON.parse(srv.requests[1]!.body)).toEqual({ variantId: "v1", quantity: 2 });
  });

  it("erro 401 vira NiveApiError com status", async () => {
    const srv = await fakeServer(() => ({ status: 401, json: { error: "Chave inválida" } }));
    const nive = new NiveClient(() => ({ baseUrl: srv.url, storeSlug: "loja", apiKey: "k" }));
    await expect(nive.testConnection()).rejects.toMatchObject({ status: 401, message: "Chave inválida" });
  });
});

describe("cliente da Evolution", () => {
  it("envia texto com apikey e devolve o id da mensagem", async () => {
    const srv = await fakeServer(() => ({ status: 201, json: { key: { id: "WAID1", remoteJid: "x", fromMe: true } } }));
    const evo = new EvolutionClient(() => ({ baseUrl: srv.url, instanceName: "nive atende", apiKey: "evo-key" }));
    const r = await evo.sendText("5548999992210@s.whatsapp.net", "oi");
    expect(r.waMessageId).toBe("WAID1");
    expect(srv.requests[0]!.url).toBe("/message/sendText/nive%20atende");
    expect(srv.requests[0]!.headers.apikey).toBe("evo-key");
  });

  it("lê o estado da conexão", async () => {
    const srv = await fakeServer(() => ({ json: { instance: { instanceName: "nive-atende", state: "open" } } }));
    const evo = new EvolutionClient(() => ({ baseUrl: srv.url, instanceName: "nive-atende", apiKey: "k" }));
    expect(await evo.connectionState()).toBe("open");
  });
});
