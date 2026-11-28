// Conversas vistas e respondidas pelo Nive ERP: o ERP pede, o Nive Atende atende com o banco local.
import { describe, expect, it, vi } from "vitest";
import { ErpBridge, handleBridgeRequest, MAX_MEDIA_CHARS, MAX_MESSAGES, type ErpBridgeDeps } from "../src/main/erp-bridge";
import type { ChatMessage, Conversation } from "../src/shared/types";

function deps(over: Partial<ErpBridgeDeps> = {}): ErpBridgeDeps & { responses: unknown[] } {
  const responses: unknown[] = [];
  const msgs = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}` }) as ChatMessage);
  return {
    responses,
    next: vi.fn(async () => ({ requests: [], pollMs: 8000 })),
    respond: vi.fn(async (id, body) => void responses.push({ id, ...body })),
    version: "0.3.23",
    enabled: () => true,
    listConversations: vi.fn(() => [{ id: "c1" } as Conversation]),
    getConversation: vi.fn(() => ({ id: "c1" }) as Conversation),
    getMessages: vi.fn(() => msgs),
    getMedia: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
    markRead: vi.fn(),
    sendText: vi.fn(async (id, text, author) => ({ id: "out", conversationId: id, text, author }) as unknown as ChatMessage),
    takeOver: vi.fn((id) => ({ id, state: "humano" }) as Conversation),
    returnToAi: vi.fn((id) => ({ id, state: "ia" }) as Conversation),
    log: vi.fn(),
    ...over,
  };
}

describe("ponte com o Nive ERP", () => {
  it("só as últimas 150 mensagens e mídia que cabe no limite", async () => {
    const d = deps();
    expect(((await handleBridgeRequest(d, { id: "1", method: "getMessages", args: ["c1"] })) as unknown[]).length).toBe(MAX_MESSAGES);
    expect(await handleBridgeRequest(d, { id: "2", method: "getMedia", args: ["m1"] })).toBe("data:image/jpeg;base64,AAAA");
    const big = deps({ getMedia: async () => "x".repeat(MAX_MEDIA_CHARS + 1) });
    expect(await handleBridgeRequest(big, { id: "3", method: "getMedia", args: ["m1"] })).toBeNull();
  });

  it("resposta e Assumir saem com o nome de quem fez no ERP", async () => {
    const d = deps();
    await handleBridgeRequest(d, { id: "1", method: "sendText", args: ["c1", " Entregamos sim! ", "Ana"] });
    expect(d.sendText).toHaveBeenCalledWith("c1", "Entregamos sim!", "Ana (ERP)");
    await handleBridgeRequest(d, { id: "2", method: "takeOver", args: ["c1", "Ana"] });
    expect(d.takeOver).toHaveBeenCalledWith("c1", "Ana (ERP)");
  });

  it("recusa pedido fora da lista e filtro estranho vira Todas", async () => {
    const d = deps();
    await expect(handleBridgeRequest(d, { id: "1", method: "deleteConversation", args: ["c1"] })).rejects.toThrow(/não suportado/);
    await handleBridgeRequest(d, { id: "2", method: "listConversations", args: ["qualquer"] });
    expect(d.listConversations).toHaveBeenCalledWith("todas", undefined);
  });

  it("atende os pedidos, devolve erro como resposta e segue o ritmo do ERP", async () => {
    const d = deps({
      next: vi.fn(async () => ({
        requests: [
          { id: "r1", method: "getConversation", args: ["c1"] },
          { id: "r2", method: "sendText", args: ["c1", ""] },
        ],
        pollMs: 1000,
      })),
    });
    const bridge = new ErpBridge(d);
    const wait = await bridge.tick();
    bridge.stop();
    expect(wait).toBe(1000);
    expect(d.responses).toEqual([
      { id: "r1", ok: true, data: { id: "c1" } },
      { id: "r2", ok: false, error: "Mensagem vazia" },
    ]);
  });

  it("ERP sem a ponte: tenta de novo bem depois", async () => {
    const bridge = new ErpBridge(deps({ next: vi.fn(async () => null) }));
    const wait = await bridge.tick();
    bridge.stop();
    expect(wait).toBe(600_000);
  });
});
