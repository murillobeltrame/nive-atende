// Ferramentas que a IA pode chamar. Cada uma é executada pelo código, com as regras de segurança aqui.
import type { AppSettings, Reservation } from "../../shared/types";
import type { NiveApi, NiveProduct } from "../nive/client";
import type { IdentityService } from "../engine/identity";
import type { Store } from "../store/db";
import type { AiToolDef } from "./openai";
import { formatBRL, guardText } from "../engine/guard";
import { prettyName } from "./format";
import { catalogIndex, coreWords, filterCatalog, fuzzySearch, listNicknames, matchNicknames } from "./nicknames";

export const TOOL_DEFS: Record<string, AiToolDef> = {
  buscar_produto: {
    name: "buscar_produto",
    description:
      "Busca no catálogo da loja. Devolve os produtos COM estoque (preço, marca, variações e quantidade) e, à parte, quantos estão esgotados. " +
      "Use termos curtos e amplos (ex.: 'perfume', 'colônia', 'body splash', uma marca) e faça mais de uma busca quando o pedido for amplo, para conhecer as opções antes de recomendar.",
    parameters: {
      type: "object",
      properties: { termo: { type: "string", description: "Palavra-chave do produto, ex.: 'perfume', 'tênis runner', 'bolsa couro'" } },
      required: ["termo"],
      additionalProperties: false,
    },
  },
  ver_catalogo: {
    name: "ver_catalogo",
    description:
      "Lista os NOMES de todos os produtos com estoque de um tipo e/ou marca (sem preço). Use quando o cliente chamar um produto por apelido, " +
      "pelo jeito do frasco/embalagem ('o da abelhinha', 'o do frasco dourado'), por comparação ('parecido com o X') ou com o nome errado, e a busca direta não trouxer o produto: " +
      "leia os nomes e use o que você sabe de cada um (frasco, cor, cheiro, fama) para reconhecer qual é. Depois use buscar_produto com o nome escolhido para ver preço e estoque.",
    parameters: {
      type: "object",
      properties: {
        tipo: { type: "string", description: "Tipo de produto, ex.: 'perfume', 'body splash', 'tênis'. Vazio para todos." },
        marca: { type: "string", description: "Marca, ex.: 'Lattafa'. Vazio para todas." },
      },
      required: ["tipo", "marca"],
      additionalProperties: false,
    },
  },
  aprender_apelido: {
    name: "aprender_apelido",
    description:
      "Guarda um apelido que o cliente usou para um produto (ex.: 'abelhinha' para o Atheeri), para a loja reconhecer de primeira nas próximas conversas. " +
      "Use só quando ficou claro qual é o produto (o cliente confirmou, ou ele pediu com o apelido e você reconheceu com certeza). Não use para nomes genéricos como 'perfume' ou 'shampoo'.",
    parameters: {
      type: "object",
      properties: {
        apelido: { type: "string", description: "Como o cliente chamou, curto, ex.: 'abelhinha', 'azulzinho', 'frasco dourado'" },
        produto_id: { type: "string", description: "produto_id devolvido por buscar_produto" },
      },
      required: ["apelido", "produto_id"],
      additionalProperties: false,
    },
  },
  mostrar_foto_produto: {
    name: "mostrar_foto_produto",
    description: "Envia ao cliente a foto de um produto devolvido por buscar_produto.",
    parameters: {
      type: "object",
      properties: { produto_id: { type: "string" } },
      required: ["produto_id"],
      additionalProperties: false,
    },
  },
  reservar_produto: {
    name: "reservar_produto",
    description:
      "Reserva (separa) um produto para o cliente. Use só depois de o cliente confirmar produto, variação, quantidade e, se ele ainda não estiver identificado, o nome completo de quem vai retirar.",
    parameters: {
      type: "object",
      properties: {
        produto_id: { type: "string" },
        variacao_id: { type: "string" },
        quantidade: { type: "integer", minimum: 1 },
        nome_cliente: {
          type: "string",
          description: "Nome e sobrenome de quem vai retirar, como o cliente escreveu. Deixe vazio se o cliente já estiver identificado.",
        },
      },
      required: ["produto_id", "variacao_id", "quantidade", "nome_cliente"],
      additionalProperties: false,
    },
  },
  identificar_cliente: {
    name: "identificar_cliente",
    description: "Identifica o cliente pelo CPF que ele acabou de digitar (o sistema já guardou o número). Não recebe parâmetros.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  confirmar_data_nascimento: {
    name: "confirmar_data_nascimento",
    description: "Confere a data de nascimento que o cliente acabou de digitar (o sistema já guardou a data). Não recebe parâmetros.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  consultar_contas: {
    name: "consultar_contas",
    description: "Consulta o que o cliente identificado tem para pagar: saldo, parcelas, vencimentos e itens comprados. Não recebe parâmetros — o cliente é sempre o identificado nesta conversa.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  avisar_quando_chegar: {
    name: "avisar_quando_chegar",
    description: "Registra que o cliente quer ser avisado quando um produto esgotado voltar ao estoque. Use só depois de o cliente aceitar.",
    parameters: {
      type: "object",
      properties: { produto_id: { type: "string", description: "produto_id de um item esgotado devolvido por buscar_produto" } },
      required: ["produto_id"],
      additionalProperties: false,
    },
  },
  anotar_preferencia: {
    name: "anotar_preferencia",
    description:
      "Guarda uma preferência de compra que o cliente contou, para lembrar nas próximas conversas (ex.: 'veste M', 'calça 38', 'prefere perfumes doces', 'compra presentes para a filha'). Uma frase curta.",
    parameters: {
      type: "object",
      properties: { nota: { type: "string", description: "Preferência em até 12 palavras" } },
      required: ["nota"],
      additionalProperties: false,
    },
  },
  transferir_para_humano: {
    name: "transferir_para_humano",
    description: "Passa a conversa para uma pessoa da loja. Use para desconto, troca, reclamação, assuntos fora do escopo ou quando não souber responder.",
    parameters: {
      type: "object",
      properties: { motivo: { type: "string", description: "Motivo curto, ex.: 'pedido de desconto'" } },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
};

const ACTIVITY: Record<string, string> = {
  buscar_produto: "Buscando produtos no sistema…",
  ver_catalogo: "Conferindo o catálogo da loja…",
  aprender_apelido: "Anotando o apelido do produto…",
  mostrar_foto_produto: "Separando a foto do produto…",
  reservar_produto: "Reservando o produto no sistema…",
  identificar_cliente: "Conferindo o cadastro do cliente…",
  confirmar_data_nascimento: "Conferindo o cadastro do cliente…",
  consultar_contas: "Consultando as contas do cliente…",
  transferir_para_humano: "Chamando alguém da loja…",
  anotar_preferencia: "Anotando a preferência do cliente…",
  avisar_quando_chegar: "Registrando o aviso de chegada…",
};

export function toolsFor(settings: AppSettings, readOnly = false): AiToolDef[] {
  const names = ["buscar_produto", "ver_catalogo"];
  if (!readOnly) names.push("mostrar_foto_produto", "reservar_produto");
  if (settings.accounts.enabled) {
    names.push("consultar_contas");
    if (!readOnly) names.push("identificar_cliente", "confirmar_data_nascimento");
  }
  if (!readOnly && settings.attendance.backInStock !== false) names.push("avisar_quando_chegar");
  if (!readOnly) names.push("anotar_preferencia", "aprender_apelido", "transferir_para_humano");
  return names.map((n) => TOOL_DEFS[n]!);
}

export interface ToolContext {
  conversationId: string;
  phone: string;
  settings: AppSettings;
  store: Store;
  nive: NiveApi;
  identity: IdentityService;
  now: () => number;
  /** Produtos já mostrados ao cliente nesta conversa. */
  offered?: Set<string>;
  /** Registra "avise-me quando chegar". */
  addWaitlist?: (productId: string, description: string) => void;
  /** Guarda um apelido de produto para a loja toda (não existe no modo só leitura). */
  learnNickname?: (apelido: string, termo: string, productId: string) => boolean;
  /** Guarda uma preferência do cliente para as próximas conversas. */
  addNote?: (note: string) => void;
  /** Avisa a interface o que a IA está fazendo agora ("Buscando produtos…"). */
  activity?: (label: string) => void;
  /** Cria a reserva (rascunho no ERP ou pendente de aprovação). */
  reserve: (input: {
    product: NiveProduct;
    variantId: string;
    variantLabel: string;
    quantity: number;
    unitPrice: number;
    customer: { id: string; name: string } | null;
    /** Nome informado pelo cliente (quando não identificado). */
    customerName: string | null;
  }) => Promise<Reservation>;
}

export interface ToolRunState {
  /** Valores em R$ que apareceram nos resultados (para validar a resposta final). */
  money: Set<number>;
  photos: Array<{ url: string; caption: string }>;
  actions: Array<{ label: string; kind: "info" | "handoff" | "error" }>;
  handoffReason: string | null;
  /** Produtos vistos nesta rodada (para reservar/mostrar foto sem confiar em dados da IA). */
  products: Map<string, NiveProduct>;
  /** A rodada já mudou algo fora da conversa (reserva, transferência): a resposta não pode ser descartada. */
  sideEffect: boolean;
}

export function newRunState(): ToolRunState {
  return { money: new Set(), photos: [], actions: [], handoffReason: null, products: new Map(), sideEffect: false };
}

function addMoney(state: ToolRunState, ...values: number[]): void {
  for (const v of values) if (Number.isFinite(v)) state.money.add(Math.round(v * 100) / 100);
}

function dateBR(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : null;
}

/** Nome de pessoa informado na conversa: só letras, espaços e sinais comuns de nome. */
export function cleanPersonName(raw: string): string | null {
  const s = raw
    .replace(/[^\p{L}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (s.replace(/[^\p{L}]/gu, "").length < 3) return null;
  return s.replace(/\p{L}+/gu, (w) => (w === w.toUpperCase() || w === w.toLowerCase() ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w)).replace(/\b(D[aeo]s?|E)\b/g, (m) => m.toLowerCase());
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export async function runTool(name: string, rawArgs: string, ctx: ToolContext, state: ToolRunState): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { erro: "Argumentos inválidos" };
  }

  ctx.activity?.(ACTIVITY[name] ?? "Consultando o sistema da loja…");
  switch (name) {
    case "buscar_produto": {
      const termo = str(args.termo).slice(0, 120);
      const found = new Map<string, NiveProduct>();
      const add = (list: Array<NiveProduct | null>) => {
        for (const p of list) if (p && p.active && !found.has(p.id)) found.set(p.id, p);
      };
      // 1) apelidos conhecidos ("abelhinha" → Atheeri) vêm primeiro
      const apelidos = matchNicknames(listNicknames(ctx.store), termo).slice(0, 3);
      for (const a of apelidos) {
        if (a.produtoId) add([await ctx.nive.getProduct(a.produtoId).catch(() => null)]);
        add(await ctx.nive.searchProducts(a.termo, 5));
      }
      // 2) busca normal no ERP
      add(await ctx.nive.searchProducts(termo, 20));
      // 3) poucos resultados: busca tolerante a erro de digitação no índice do catálogo
      if (found.size < 3) {
        const extra = fuzzySearch(catalogIndex(ctx.store), termo, 5).filter((e) => !found.has(e.id));
        for (const e of extra) add([await ctx.nive.getProduct(e.id).catch(() => null)]);
      }
      const products = [...found.values()];
      const view = products.map((p) => {
        const variacoes = p.variants.map((v) => {
          const reserved = ctx.store.reservedQuantity(v.id, ctx.now());
          const disponivel = p.tracksStock ? Math.max(0, Math.floor(v.stockQty - reserved)) : null;
          return { v, disponivel };
        });
        const total = variacoes.some((x) => x.disponivel === null) ? Infinity : variacoes.reduce((n, x) => n + (x.disponivel ?? 0), 0);
        return { p, variacoes, total };
      });
      const inStock = view.filter((x) => x.total > 0);
      const soldOut = view.filter((x) => x.total <= 0);
      state.actions.push({ label: `Buscou “${termo}” → ${inStock.length} com estoque${soldOut.length ? `, ${soldOut.length} esgotado(s)` : ""}`, kind: "info" });
      if (!products.length)
        return {
          resultado: "NENHUM_PRODUTO",
          instrucao:
            "Se o cliente usou um apelido ou descreveu o produto (desenho, cor, frasco, 'parecido com'), pense no nome real e busque por ele, ou use ver_catalogo do tipo para reconhecer pelo nome. " +
            "Senão, tente outro termo mais amplo ou sinônimo. Só diga que não tem depois disso.",
        };
      return {
        ...(apelidos.length
          ? { apelido_conhecido: apelidos.map((a) => `"${a.apelido}" é como os clientes chamam: ${a.termo}`).join("; ") }
          : {}),
        total_com_estoque: inStock.length,
        produtos: inStock.slice(0, 15).map(({ p, variacoes }) => {
          state.products.set(p.id, p);
          addMoney(state, p.priceCash, p.priceCredit);
          return {
            produto_id: p.id,
            nome: prettyName(p.description),
            ...(p.brand ? { marca: p.brand } : {}),
            ...(p.category ? { categoria: p.category } : {}),
            preco: formatBRL(p.priceCash),
            ...(p.priceCredit > 0 && Math.abs(p.priceCredit - p.priceCash) > 0.009 ? { preco_a_prazo: formatBRL(p.priceCredit) } : {}),
            tem_foto: Boolean(p.imageUrl),
            ...(ctx.offered?.has(p.id) ? { ja_mostrado: true } : {}),
            variacoes: variacoes
              .filter((x) => x.disponivel === null || x.disponivel > 0)
              .map((x) => ({ variacao_id: x.v.id, nome: x.v.label, disponivel: x.disponivel === null ? "sob consulta" : x.disponivel })),
          };
        }),
        ...(soldOut.length
          ? {
              esgotados: soldOut.slice(0, 5).map(({ p }) => ({ produto_id: p.id, nome: prettyName(p.description) })),
              obs_esgotados:
                ctx.settings.attendance.backInStock !== false
                  ? "Esgotados: não ofereça. Se o cliente perguntar exatamente por um deles, diga que acabou, sugira uma alternativa com estoque e ofereça avisar quando chegar (avisar_quando_chegar)."
                  : "Esgotados: não ofereça. Só mencione se o cliente perguntar exatamente por um deles, e já sugira uma alternativa com estoque.",
            }
          : {}),
      };
    }

    case "ver_catalogo": {
      const items = catalogIndex(ctx.store);
      if (!items.length) return { resultado: "CATALOGO_INDISPONIVEL", instrucao: "Use buscar_produto com termos amplos e com os nomes reais que você imagina." };
      const list = filterCatalog(items, str(args.tipo).slice(0, 60), str(args.marca).slice(0, 60));
      state.actions.push({ label: `Conferiu o catálogo${str(args.tipo) ? ` de “${str(args.tipo)}”` : ""} → ${list.length} item(ns)`, kind: "info" });
      if (!list.length) return { resultado: "NENHUM_PRODUTO", instrucao: "Tente um tipo mais amplo (ex.: 'perfume') ou deixe o tipo vazio e filtre pela marca." };
      const MAX = 200;
      return {
        total: list.length,
        produtos: list.slice(0, MAX).map((e) => ({ produto_id: e.id, nome: e.nome, ...(e.marca ? { marca: e.marca } : {}) })),
        ...(list.length > MAX ? { obs: `Mostrando ${MAX} de ${list.length}. Filtre pela marca ou por um tipo mais específico para ver o resto.` } : {}),
        instrucao:
          "Reconheça pelo que você sabe de cada produto qual o cliente quis dizer. Achando, use buscar_produto com o nome para ver preço e estoque, " +
          "e ofereça confirmando com naturalidade (ex.: 'É o Atheeri, o do frasco com a abelhinha?'), com a foto se tiver.",
      };
    }

    case "aprender_apelido": {
      const id = str(args.produto_id);
      const apelido = str(args.apelido).slice(0, 60);
      // só produto que a IA viu de verdade nesta conversa
      const p = state.products.get(id) ?? (ctx.offered?.has(id) ? await ctx.nive.getProduct(id) : null);
      if (!p) return { resultado: "IGNORADO", instrucao: "Busque o produto antes (buscar_produto) e use o produto_id devolvido." };
      const nome = prettyName(p.description);
      // "perfume" não é apelido: precisa de alguma palavra que não esteja no nome/tipo do produto
      const own = new Set(coreWords(`${nome} ${p.brand ?? ""} ${p.category ?? ""} perfume colonia body splash produto`));
      const meaningful = coreWords(apelido).filter((w) => !own.has(w));
      if (!meaningful.length || /\d[\d\s.()-]{5,}\d/.test(apelido) || !guardText(apelido).safeText.trim()) return { resultado: "IGNORADO" };
      const ok = ctx.learnNickname?.(guardText(apelido).safeText, nome, p.id) ?? false;
      if (ok) state.actions.push({ label: `Aprendeu o apelido “${apelido}” → ${nome}`, kind: "info" });
      return { resultado: ok ? "ANOTADO" : "IGNORADO", instrucao: "Continue a conversa normalmente, sem dizer que anotou." };
    }

    case "mostrar_foto_produto": {
      const id = str(args.produto_id);
      const p = state.products.get(id) ?? (await ctx.nive.getProduct(id));
      if (!p || !p.imageUrl) return { resultado: "SEM_FOTO" };
      if (!state.photos.some((ph) => ph.url === p.imageUrl)) state.photos.push({ url: p.imageUrl, caption: p.description });
      return { resultado: "FOTO_SERA_ENVIADA", instrucao: "A foto vai junto com a sua próxima mensagem, como legenda. Escreva a mensagem normalmente (sem marcações como [imagem] e sem dizer 'enviei a foto')." };
    }

    case "reservar_produto": {
      const productId = str(args.produto_id);
      const variantId = str(args.variacao_id);
      const quantity = Math.floor(Number(args.quantidade));
      if (!Number.isFinite(quantity) || quantity < 1) return { erro: "Quantidade inválida" };
      if (quantity > ctx.settings.reservation.maxQtyPerOrder) {
        return {
          resultado: "QUANTIDADE_ACIMA_DO_LIMITE",
          limite: ctx.settings.reservation.maxQtyPerOrder,
          instrucao: "Explique que por aqui dá para separar até esse limite e que, para mais, alguém da loja confirma.",
        };
      }
      // Sempre relê o produto no ERP: não confia em preço/estoque vindos da conversa.
      const product = await ctx.nive.getProduct(productId);
      const variant = product?.variants.find((v) => v.id === variantId);
      if (!product || !product.active || !variant) return { resultado: "PRODUTO_NAO_ENCONTRADO", instrucao: "Busque o produto de novo antes de reservar." };
      if (product.tracksStock) {
        const available = Math.floor(variant.stockQty - ctx.store.reservedQuantity(variant.id, ctx.now()));
        if (available < quantity) {
          return { resultado: "SEM_ESTOQUE_SUFICIENTE", disponivel: Math.max(0, available), instrucao: "Informe a quantidade disponível e pergunte se quer reservar essa quantidade." };
        }
      }
      const verified = ctx.identity.verifiedCustomerId(ctx.conversationId);
      const givenName = verified ? null : cleanPersonName(str(args.nome_cliente));
      if (!verified && (!givenName || givenName.split(" ").length < 2)) {
        return {
          resultado: "PRECISA_NOME_COMPLETO",
          instrucao: "Antes de reservar, peça com naturalidade o nome e sobrenome de quem vai retirar (ex.: 'Me passa seu nome completo pra eu deixar separado?'). Depois chame reservar_produto de novo.",
        };
      }
      if (ctx.settings.reservation.requireCustomer && !verified) {
        return {
          resultado: "PRECISA_CADASTRO",
          instrucao: "Diga que para reservar por aqui é preciso ter cadastro na loja e que alguém vai finalizar o atendimento.",
        };
      }
      state.sideEffect = true;
      const r = await ctx.reserve({
        product,
        variantId: variant.id,
        variantLabel: variant.label,
        quantity,
        unitPrice: product.priceCash,
        customer: verified ? { id: verified.id, name: verified.name } : null,
        customerName: givenName,
      });
      addMoney(state, product.priceCash, product.priceCash * quantity);
      const validade = new Date(r.expiresAt).toLocaleString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      if (r.status === "created") {
        state.actions.push({ label: `Reservou ${quantity}× ${product.description} (${variant.label})${r.orderNumber ? ` · pedido #${r.orderNumber}` : ""}`, kind: "info" });
        return ctx.settings.reservation.showDeadline !== false
          ? { resultado: "RESERVADO", valido_ate: validade, total: formatBRL(product.priceCash * quantity), instrucao: "Confirme que separou e diga até quando fica reservado." }
          : { resultado: "RESERVADO", total: formatBRL(product.priceCash * quantity), instrucao: "Confirme que separou. Não fale em prazo ou data limite da reserva." };
      }
      if (r.status === "pending_approval") {
        state.actions.push({ label: `Pedido de reserva aguardando aprovação: ${quantity}× ${product.description}`, kind: "info" });
        return { resultado: "AGUARDANDO_CONFIRMACAO_DA_LOJA", instrucao: "Diga que vai pedir para separarem e que já confirma. Não diga que está reservado." };
      }
      state.actions.push({ label: `Falha ao reservar ${product.description}`, kind: "error" });
      return { resultado: "FALHA_AO_RESERVAR", instrucao: "Diga que vai pedir para alguém da loja separar e use transferir_para_humano com o motivo 'falha ao reservar'." };
    }

    case "identificar_cliente": {
      const out = await ctx.identity.identifyByCpf(ctx.conversationId, ctx.phone, ctx.settings.accounts.secondFactor);
      state.actions.push({ label: `Identificação por CPF: ${out.resultado.toLowerCase().replace(/_/g, " ")}`, kind: out.resultado === "IDENTIFICADO" ? "info" : "error" });
      if (out.resultado === "BLOQUEADO") state.handoffReason = state.handoffReason ?? "tentativas de identificação bloqueadas";
      return out;
    }

    case "confirmar_data_nascimento": {
      const out = await ctx.identity.confirmBirthDate(ctx.conversationId, ctx.phone);
      state.actions.push({ label: `Data de nascimento: ${out.resultado === "IDENTIFICADO" ? "confere" : "não confirmada"}`, kind: out.resultado === "IDENTIFICADO" ? "info" : "error" });
      if (out.resultado === "BLOQUEADO") state.handoffReason = state.handoffReason ?? "tentativas de identificação bloqueadas";
      return out;
    }

    case "consultar_contas": {
      if (!ctx.settings.accounts.enabled) return { resultado: "DESABILITADO" };
      // O cliente vem SEMPRE da sessão verificada desta conversa — nunca de argumentos da IA.
      const verified = ctx.identity.verifiedCustomerId(ctx.conversationId);
      if (!verified) {
        return { resultado: "NAO_IDENTIFICADO", instrucao: "Peça o CPF do titular para confirmar o cadastro." };
      }
      const st = await ctx.nive.getStatement(verified.id);
      if (st.customerId !== verified.id) {
        ctx.store.audit(ctx.phone, verified.id, "consulta_contas", "erro_cliente_divergente");
        return { erro: "Não foi possível consultar agora", instrucao: "Diga que não conseguiu consultar e use transferir_para_humano." };
      }
      ctx.store.audit(ctx.phone, verified.id, "consulta_contas", `saldo ${st.openBalance.toFixed(2)}`);
      const today = new Date(ctx.now()).toISOString().slice(0, 10);
      addMoney(state, st.openBalance, st.overdueBalance);
      const parcelas = st.installments.slice(0, 24).map((i) => {
        addMoney(state, i.balance, i.amount);
        return {
          pedido: i.orderNumber,
          parcela: i.sequence,
          valor_em_aberto: formatBRL(i.balance),
          vencimento: dateBR(i.dueDate),
          vencida: Boolean(i.dueDate && i.dueDate.slice(0, 10) < today),
        };
      });
      const compras = st.orders.slice(0, 10).map((o) => {
        addMoney(state, o.balance, o.originalAmount);
        return {
          pedido: o.orderNumber,
          saldo: formatBRL(o.balance),
          itens: o.items.slice(0, 20).map((it) => {
            addMoney(state, it.lineTotal, it.unitPrice);
            return { produto: [it.description, it.variantLabel].filter(Boolean).join(" "), quantidade: it.quantity, valor: formatBRL(it.lineTotal) };
          }),
        };
      });
      state.actions.push({ label: `Consultou contas → ${formatBRL(st.openBalance)} em aberto`, kind: "info" });
      if (st.openBalance <= 0.009) {
        return { resultado: "SEM_CONTAS_EM_ABERTO", instrucao: "Diga que não há valores em aberto no cadastro." };
      }
      return {
        total_em_aberto: formatBRL(st.openBalance),
        total_vencido: formatBRL(st.overdueBalance),
        parcelas_em_aberto: parcelas,
        compras_em_aberto: compras,
        ...(ctx.settings.accounts.showCharges
          ? {}
          : { observacao: "Não mencione juros ou multa; informe só os valores." }),
        instrucao: "Responda só o que o cliente perguntou, de forma resumida. Ofereça os detalhes (itens/parcelas) se fizer sentido.",
      };
    }

    case "avisar_quando_chegar": {
      const p = await ctx.nive.getProduct(str(args.produto_id));
      if (!p) return { resultado: "PRODUTO_NAO_ENCONTRADO" };
      ctx.addWaitlist?.(p.id, p.description);
      state.actions.push({ label: `Vai avisar quando chegar: ${prettyName(p.description)}`, kind: "info" });
      return { resultado: "REGISTRADO", instrucao: "Confirme que vai avisar assim que chegar." };
    }

    case "anotar_preferencia": {
      const raw = str(args.nota);
      const nota = guardText(raw).safeText.replace(/\s+/g, " ").trim().slice(0, 120);
      if (nota.length < 3 || /\d[\d\s.()-]{5,}\d/.test(raw) || nota.includes("[")) return { resultado: "IGNORADO" };
      ctx.addNote?.(nota);
      state.actions.push({ label: `Anotou: ${nota}`, kind: "info" });
      return { resultado: "ANOTADO", instrucao: "Continue a conversa normalmente, sem dizer que anotou." };
    }

    case "transferir_para_humano": {
      const motivo = str(args.motivo).slice(0, 120) || "pedido do cliente";
      state.handoffReason = motivo;
      state.sideEffect = true;
      state.actions.push({ label: `Passou para humano: ${motivo}`, kind: "handoff" });
      return { resultado: "TRANSFERIDO", instrucao: "Avise o cliente que alguém da loja vai continuar o atendimento em instantes." };
    }

    default:
      return { erro: `Ferramenta desconhecida: ${name}` };
  }
}
