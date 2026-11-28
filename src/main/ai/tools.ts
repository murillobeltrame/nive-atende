// Ferramentas que a IA pode chamar. Cada uma é executada pelo código, com as regras de segurança aqui.
import type { AppSettings, Reservation } from "../../shared/types";
import type { NiveApi, NiveProduct, NivePromotion } from "../nive/client";
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
      "Use termos curtos e amplos (ex.: 'perfume', 'colônia', 'body splash', uma marca) e faça mais de uma busca quando o pedido for amplo, para conhecer as opções antes de recomendar. " +
      "Quando o cliente der uma faixa de preço, mande preco_max/preco_min: a busca já devolve só o que cabe, do mais barato ao mais caro.",
    parameters: {
      type: "object",
      properties: {
        termo: { type: "string", description: "Palavra-chave do produto, ex.: 'perfume', 'tênis runner', 'bolsa couro'" },
        preco_max: { type: "number", description: "Opcional. Preço máximo em reais quando o cliente der um limite ('até 100 reais' → 100)." },
        preco_min: { type: "number", description: "Opcional. Preço mínimo em reais ('acima de 50' → 50)." },
      },
      required: ["termo"],
      additionalProperties: false,
    },
  },
  ver_promocoes: {
    name: "ver_promocoes",
    description:
      "Varre as promoções que estão valendo agora na loja: preço promocional (de/por), leve X pague Y, X por R$ Z, desconto a partir de X unidades, brinde acima de um valor e preço de atacado. " +
      "Use SEMPRE que o cliente falar em promoção, oferta, desconto do dia, 'o que tá barato', combo ou 'tem alguma promo de X'. " +
      "Mande termo com o produto, marca ou categoria que o cliente citou ('vodka', 'red bull', 'cerveja'); se não citou nada, deixe vazio para ver todas.",
    parameters: {
      type: "object",
      properties: {
        termo: { type: "string", description: "Produto, marca ou categoria ('vodka', 'energético', 'bebidas'). Vazio para todas as promoções." },
      },
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
  calcular_total: {
    name: "calcular_total",
    description:
      "Calcula o total de uma compra com quantidades (ex.: 2 cervejas + 1 gelo). Use sempre que for dizer um total ou o valor de mais de uma unidade: nunca faça a conta de cabeça.",
    parameters: {
      type: "object",
      properties: {
        itens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              produto_id: { type: "string", description: "produto_id devolvido por buscar_produto" },
              quantidade: { type: "integer", minimum: 1 },
            },
            required: ["produto_id", "quantidade"],
            additionalProperties: false,
          },
        },
      },
      required: ["itens"],
      additionalProperties: false,
    },
  },
  resolvido_sem_equipe: {
    name: "resolvido_sem_equipe",
    description:
      "Use só quando a conversa estava encaminhada para a equipe e você mesmo resolveu esse assunto com a nova mensagem do cliente (ele explicou melhor, mudou de ideia, era dúvida que você responde). Tira a conversa das pendências da equipe.",
    parameters: {
      type: "object",
      properties: { resumo: { type: "string", description: "Como foi resolvido, curto, ex.: 'cliente só queria saber o preço'" } },
      required: ["resumo"],
      additionalProperties: false,
    },
  },
  cancelar_reserva: {
    name: "cancelar_reserva",
    description:
      "Cancela uma reserva deste cliente quando ele desistir da compra ('não quero mais', 'pode cancelar', 'desisti'). Se a loja já tinha aprovado, o rascunho é cancelado no sistema e o produto volta ao estoque. " +
      "Sem reserva_id, mostra as reservas ativas desta conversa; reserva_id 'todas' cancela todas de uma vez. Use só quando a desistência estiver clara; se tiver dúvida, pergunte antes.",
    parameters: {
      type: "object",
      properties: {
        reserva_id: { type: "string", description: "reserva_id devolvido por esta ferramenta, 'todas' para cancelar todas, ou vazio para listar as reservas ativas." },
      },
      required: ["reserva_id"],
      additionalProperties: false,
    },
  },
  mensagens_automaticas: {
    name: "mensagens_automaticas",
    description:
      "Liga ou desliga as mensagens automáticas da loja para este cliente (lembrete de reserva, aviso de chegada, retomada de conversa). " +
      "Use receber=false quando ele pedir para parar de receber mensagens/avisos/lembretes; receber=true quando pedir para voltar a receber.",
    parameters: {
      type: "object",
      properties: { receber: { type: "boolean", description: "false = não mandar mais; true = voltar a mandar" } },
      required: ["receber"],
      additionalProperties: false,
    },
  },
  enviar_localizacao: {
    name: "enviar_localizacao",
    description: "Envia ao cliente o pino com a localização da loja no WhatsApp (ele abre no mapa do celular). Use quando perguntar onde fica, o endereço ou como chegar.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  ver_formas_pagamento: {
    name: "ver_formas_pagamento",
    description: "Lista as formas de pagamento aceitas pela loja, direto do sistema. Use sempre que o cliente perguntar como pode pagar (pix, cartão, dinheiro…).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  transferir_para_humano: {
    name: "transferir_para_humano",
    description:
      "Passa a conversa para uma pessoa da loja. Nunca use para pergunta de produto, preço, estoque ou promoção (consulte as ferramentas). Use só para desconto, troca, devolução, reclamação, defeito, pedido de humano, assunto pessoal ou quando a informação pedida não está nestas instruções nem nas ferramentas. Pergunta simples de produto, preço, estoque, horário ou da loja você mesmo responde.",
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
  ver_promocoes: "Conferindo as promoções da loja…",
  calcular_total: "Calculando o total…",
  ver_catalogo: "Conferindo o catálogo da loja…",
  aprender_apelido: "Anotando o apelido do produto…",
  mostrar_foto_produto: "Separando a foto do produto…",
  reservar_produto: "Reservando o produto no sistema…",
  identificar_cliente: "Conferindo o cadastro do cliente…",
  confirmar_data_nascimento: "Conferindo o cadastro do cliente…",
  consultar_contas: "Consultando as contas do cliente…",
  transferir_para_humano: "Chamando alguém da loja…",
  resolvido_sem_equipe: "Resolvendo a pendência…",
  ver_formas_pagamento: "Conferindo as formas de pagamento…",
  cancelar_reserva: "Cancelando a reserva…",
  mensagens_automaticas: "Atualizando os avisos do cliente…",
  enviar_localizacao: "Separando a localização da loja…",
  anotar_preferencia: "Anotando a preferência do cliente…",
  avisar_quando_chegar: "Registrando o aviso de chegada…",
};

export function toolsFor(settings: AppSettings, readOnly = false, triage = false, hasLocation = false): AiToolDef[] {
  const names = ["buscar_produto", "ver_promocoes", "ver_catalogo", "calcular_total"];
  if (!readOnly) names.push("mostrar_foto_produto", "reservar_produto", "cancelar_reserva", "mensagens_automaticas");
  if (settings.accounts.enabled) {
    names.push("consultar_contas");
    if (!readOnly) names.push("identificar_cliente", "confirmar_data_nascimento");
  }
  if (!readOnly && settings.attendance.backInStock !== false) names.push("avisar_quando_chegar");
  names.push("ver_formas_pagamento");
  if (!readOnly) names.push("anotar_preferencia", "aprender_apelido", "transferir_para_humano");
  if (!readOnly && triage) names.push("resolvido_sem_equipe");
  if (!readOnly && hasLocation) names.push("enviar_localizacao");
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
  /** Reservas ainda ativas desta conversa (aguardando aprovação, separadas ou com falha). */
  activeReservations?: () => Reservation[];
  /** Cancela a reserva porque o cliente desistiu (rascunho aprovado é cancelado no ERP e o estoque volta). */
  cancelReservation?: (id: string) => Promise<Reservation>;
  /** Liga/desliga lembretes e avisos automáticos para este cliente. */
  setAutoMessages?: (on: boolean) => unknown;
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
  /** Preço de campanha valendo agora, por produto (calcular_total usa no lugar do preço normal). */
  promoPrices: Map<string, number>;
  /** A IA já consultou produtos ou promoções nesta rodada. */
  searched: boolean;
  /** Já recusou uma passagem para humano por pergunta que a IA mesma responde. */
  handoffRefused: boolean;
  /** A IA resolveu sozinha o assunto que estava com a equipe (resumo). */
  triageResolved?: string | null;
  /** Enviar o pino da localização da loja depois da resposta. */
  sendLocation?: boolean;
}

export function newRunState(): ToolRunState {
  return {
    money: new Set(),
    photos: [],
    actions: [],
    handoffReason: null,
    products: new Map(),
    sideEffect: false,
    promoPrices: new Map(),
    searched: false,
    handoffRefused: false,
  };
}

// ---------------------------------------------------------------- promoções
const PROMO_TTL_MS = 60_000;
const promoCache = new WeakMap<object, { at: number; items: NivePromotion[] | null }>();

/** Todas as promoções valendo agora (guardadas por 1 minuto). null = ERP sem a consulta. */
export async function activePromotions(ctx: Pick<ToolContext, "nive" | "now">): Promise<NivePromotion[] | null> {
  if (!ctx.nive.listActivePromotions) return null;
  const hit = promoCache.get(ctx.nive);
  if (hit && ctx.now() - hit.at < PROMO_TTL_MS) return hit.items;
  const items = await ctx.nive.listActivePromotions("");
  promoCache.set(ctx.nive, { at: ctx.now(), items });
  return items;
}

function normWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/** Palavras de categoria ampla que o cliente usa e que não aparecem no nome do produto. */
const BROAD_TERMS = new Set(["bebida", "bebidas", "promocao", "promocoes", "promo", "promos", "oferta", "ofertas", "produto", "produtos", "coisa", "coisas", "loja", "tudo", "geral"]);

/** Explica a promoção para a IA, já com os valores no formato da loja. */
function promoView(p: NivePromotion, state: ToolRunState, onlyIds?: Set<string>) {
  const products = onlyIds ? p.products.filter((x) => onlyIds.has(x.id)) : p.products;
  for (const x of products) {
    addMoney(state, x.priceCash);
    if (x.promoPrice != null) {
      addMoney(state, x.promoPrice);
      if (p.kind === "campaign") state.promoPrices.set(x.id, x.promoPrice);
    }
  }
  for (const m of p.description.matchAll(/R\$\s*([\d.]+,\d{2})/g)) addMoney(state, Number(m[1]!.replace(/\./g, "").replace(",", ".")));
  const fim = p.endsAt ? dateBR(p.endsAt, true) : null;
  return {
    promocao: p.name,
    regra: p.description,
    ...(fim ? { valida_ate: fim } : {}),
    produtos: products.slice(0, 12).map((x) => ({
      produto_id: x.id,
      nome: prettyName(x.description),
      ...(x.promoPrice != null && x.promoPrice < x.priceCash - 0.009
        ? { de: formatBRL(x.priceCash), por: formatBRL(x.promoPrice) }
        : { preco: formatBRL(x.priceCash) }),
    })),
    ...(products.length > 12 || p.productCount > products.length ? { outros_produtos: Math.max(products.length, p.productCount) - Math.min(12, products.length) } : {}),
  };
}

/** Pedido de humano que é, na verdade, pergunta de produto/preço/promoção (a IA mesma responde). */
export function isAnswerableHandoff(motivo: string): boolean {
  const t = motivo.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  // esses continuam indo para a equipe
  if (/(credi|fiado|carne|caderneta|desconto|negoci|troca|devolu|reclama|defeito|estrag|humano|pessoa|atendente|gerente|dono|robo|cancel|pagamento pendente|pix errado|cobranca|divida|conta|parcela|falha ao reservar|reserva recusada|pessoal|ofens|xing)/.test(t)) return false;
  return /(forma de pagamento|formas de pagamento|aceita|pix|cartao|dinheiro|horario|promo|oferta|preco|valor|quanto|produto|estoque|disponib|bebida|cardapio|catalogo|tem |marca|sabor|tamanho|combo|kit|opcao|opcoes|vodka|cerveja|refri|energetico|whisk|gin|vinho|cigarro|perfume)/.test(t);
}

function addMoney(state: ToolRunState, ...values: number[]): void {
  for (const v of values) if (Number.isFinite(v)) state.money.add(Math.round(v * 100) / 100);
}

/** Forma de pagamento que a loja usa por dentro e não faz sentido oferecer a quem compra pelo WhatsApp. */
export function isInternalPaymentMethod(name: string): boolean {
  return /permuta|vale[\s-]*troca|\btroca\b|bonifica|cortesia|consumo\s+(interno|pr[oó]prio)|uso\s+interno|brinde|devolu/i.test(name);
}

/**
 * Data no formato da loja. Com `endOfPeriod` (fim de promoção), usa o horário de Brasília: data com hora vem em UTC do ERP: 30/11 23:59 em
 * Brasília é 01/12 em UTC, e o cliente ouvia "vale até 01/12". Fim à meia-noite em ponto conta como o dia anterior.
 */
export function dateBR(iso: string | null, endOfPeriod = false): string | null {
  if (!iso) return null;
  if (!endOfPeriod || !/T\d{2}:\d{2}/.test(iso)) {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return y && m && d ? `${d}/${m}/${y}` : null;
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = (ms: number) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, x.value]),
    ) as Record<string, string>;
  let p = parts(t);
  if (p.hour === "00" && p.minute === "00" && p.second === "00") p = parts(t - 1000);
  return `${p.day}/${p.month}/${p.year}`;
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
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
      const precoMax = num(args.preco_max);
      const precoMin = num(args.preco_min);
      const priced = precoMax !== null || precoMin !== null;
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
      add(await ctx.nive.searchProducts(termo, priced ? 60 : 20));
      // 3) poucos resultados: busca tolerante a erro de digitação no índice do catálogo
      if (found.size < 3) {
        const extra = fuzzySearch(catalogIndex(ctx.store), termo, 5).filter((e) => !found.has(e.id));
        for (const e of extra) add([await ctx.nive.getProduct(e.id).catch(() => null)]);
      }
      const products = [...found.values()];
      const view = products.map((p) => {
        const variacoes = p.variants.map((v) => {
          // o pedido pendente do próprio cliente não esgota o produto para ele (antes: "a última acabou agora")
          const reserved = ctx.store.reservedQuantity(v.id, ctx.now(), ctx.conversationId);
          const disponivel = p.tracksStock ? Math.max(0, Math.floor(v.stockQty - reserved)) : null;
          const jaPedido = ctx.store.pendingQuantityFor(ctx.conversationId, v.id, ctx.now());
          return { v, disponivel, jaPedido };
        });
        const total = variacoes.some((x) => x.disponivel === null) ? Infinity : variacoes.reduce((n, x) => n + (x.disponivel ?? 0), 0);
        return { p, variacoes, total };
      });
      state.searched = true;
      const promos = await activePromotions(ctx).catch(() => null);
      const promoOf = (id: string) => (promos ?? []).filter((pr) => pr.products.some((x) => x.id === id));
      const allInStock = view.filter((x) => x.total > 0);
      const fits = (price: number) => (precoMax === null || price <= precoMax + 0.009) && (precoMin === null || price >= precoMin - 0.009);
      const inStock = priced ? allInStock.filter((x) => fits(x.p.priceCash)).sort((a, b) => a.p.priceCash - b.p.priceCash) : allInStock;
      const soldOut = view.filter((x) => x.total <= 0);
      const faixa = priced
        ? `${precoMin !== null ? ` de ${formatBRL(precoMin)}` : ""}${precoMax !== null ? ` até ${formatBRL(precoMax)}` : ""}`
        : "";
      state.actions.push({ label: `Buscou “${termo}”${faixa} → ${inStock.length} com estoque${soldOut.length ? `, ${soldOut.length} esgotado(s)` : ""}`, kind: "info" });
      if (priced) addMoney(state, ...[precoMax, precoMin].filter((v): v is number => v !== null));
      if (priced && !inStock.length && allInStock.length) {
        // nada na faixa: mostra os mais próximos para a IA oferecer com naturalidade
        const nearest = [...allInStock].sort((a, b) => a.p.priceCash - b.p.priceCash).slice(0, 3);
        for (const { p } of nearest) {
          state.products.set(p.id, p);
          addMoney(state, p.priceCash, p.priceCredit);
        }
        return {
          resultado: "NADA_NA_FAIXA_DE_PRECO",
          mais_baratos_com_estoque: nearest.map(({ p }) => ({ produto_id: p.id, nome: prettyName(p.description), preco: formatBRL(p.priceCash) })),
          instrucao: "Diga com naturalidade que nessa faixa não tem agora e mostre as opções mais em conta que tem.",
        };
      }
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
            ...(promoOf(p.id).length
              ? { em_promocao: promoOf(p.id).map((pr) => promoView(pr, state, new Set([p.id]))).map(({ promocao, regra, produtos, ...rest }) => ({ promocao, regra, ...(produtos[0] && "por" in produtos[0] ? { por: produtos[0].por } : {}), ...rest })) }
              : {}),
            ...(ctx.offered?.has(p.id) ? { ja_mostrado: true } : {}),
            variacoes: variacoes
              .filter((x) => x.disponivel === null || x.disponivel > 0)
              .map((x) => ({
                variacao_id: x.v.id,
                nome: x.v.label,
                disponivel: x.disponivel === null ? "sob consulta" : x.disponivel,
                ...(x.jaPedido > 0 ? { ja_pedido_por_este_cliente: x.jaPedido, obs: "Já está no pedido dele aguardando a loja; não diga que acabou." } : {}),
              })),
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

    case "ver_promocoes": {
      state.searched = true;
      const termo = str(args.termo).slice(0, 80).trim();
      const all = await activePromotions(ctx);
      if (all === null) {
        state.actions.push({ label: "Promoções: o sistema da loja ainda não informa as promoções", kind: "info" });
        return {
          resultado: "PROMOCOES_INDISPONIVEIS",
          instrucao:
            "O sistema não informou promoções agora. Não passe para outra pessoa por isso: busque os produtos que o cliente citou (buscar_produto) e mostre as opções com o preço, sem chamar de promoção.",
        };
      }
      const words = normWords(termo).filter((w) => !BROAD_TERMS.has(w));
      const hits = (pr: NivePromotion) =>
        pr.products.filter((x) => {
          const hay = normWords(`${x.description}`).join(" ");
          return words.some((w) => hay.includes(w));
        });
      const nameHit = (pr: NivePromotion) => words.some((w) => normWords(`${pr.name} ${pr.description}`).join(" ").includes(w));
      const filtered = words.length
        ? all.filter((pr) => nameHit(pr) || hits(pr).length).map((pr) => ({ pr, only: nameHit(pr) ? undefined : new Set(hits(pr).map((x) => x.id)) }))
        : all.map((pr) => ({ pr, only: undefined }));
      // poucas promoções no total: mostra todas mesmo sem casar com o termo (varredura completa)
      const fallback = words.length > 0 && !filtered.length;
      const list = fallback ? all.map((pr) => ({ pr, only: undefined })) : filtered;
      state.actions.push({
        label: `Conferiu promoções${termo ? ` de “${termo}”` : ""} → ${filtered.length}${fallback ? ` (mostrando todas: ${all.length})` : ""}`,
        kind: "info",
      });
      if (!all.length)
        return {
          resultado: "NENHUMA_PROMOCAO_AGORA",
          instrucao:
            "Não há promoção cadastrada valendo agora. Diga isso com naturalidade e já ofereça o que o cliente citou com o preço normal (use buscar_produto), sem passar para outra pessoa.",
        };
      // não mostra promoção de produto sem estoque (o ERP não manda estoque aqui: confere os que vão aparecer)
      return {
        ...(fallback
          ? { obs: `Nenhuma promoção de "${termo}" agora. Estas são todas as promoções valendo; diga que de ${termo} não tem promoção agora e ofereça as que combinam, ou o produto com o preço normal (buscar_produto).` }
          : {}),
        total: list.length,
        promocoes: list.slice(0, 15).map(({ pr, only }) => promoView(pr, state, only)),
        instrucao:
          "Apresente as promoções com a regra e os preços exatamente como vieram ('de R$ X por R$ Y', 'leve 3 pague 2'). Antes de prometer estoque de um item, confira com buscar_produto. " +
          "Na promoção por quantidade, explique a regra; o desconto entra sozinho no caixa. Nunca passe para outra pessoa por causa de promoção.",
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

    case "calcular_total": {
      const itens = Array.isArray(args.itens) ? (args.itens as Array<Record<string, unknown>>).slice(0, 30) : [];
      if (!itens.length) return { erro: "Informe os itens" };
      const linhas: Array<{ produto: string; quantidade: number; unitario: string; preco_promocional?: boolean; subtotal: string }> = [];
      let total = 0;
      for (const it of itens) {
        const id = str(it.produto_id);
        const qty = Math.floor(Number(it.quantidade));
        if (!Number.isFinite(qty) || qty < 1 || qty > 999) return { erro: `Quantidade inválida para ${id}` };
        // preço sempre relido do ERP (ou da busca desta rodada), nunca vindo da IA
        const p = state.products.get(id) ?? (await ctx.nive.getProduct(id).catch(() => null));
        if (!p || !p.active) return { resultado: "PRODUTO_NAO_ENCONTRADO", produto_id: id, instrucao: "Busque o produto (buscar_produto) e use o produto_id devolvido." };
        state.products.set(p.id, p);
        const promo = state.promoPrices.get(p.id);
        const unit = promo != null && promo < p.priceCash ? promo : p.priceCash;
        const sub = Math.round(unit * qty * 100) / 100;
        total += sub;
        addMoney(state, unit, sub);
        if (p.priceCredit > 0) addMoney(state, p.priceCredit, Math.round(p.priceCredit * qty * 100) / 100);
        linhas.push({
          produto: prettyName(p.description),
          quantidade: qty,
          unitario: formatBRL(unit),
          ...(unit !== p.priceCash ? { preco_promocional: true } : {}),
          subtotal: formatBRL(sub),
        });
      }
      total = Math.round(total * 100) / 100;
      addMoney(state, total);
      state.actions.push({ label: `Calculou o total → ${formatBRL(total)}`, kind: "info" });
      return { itens: linhas, total: formatBRL(total), instrucao: "Informe o total (e os subtotais se ajudar). Valores à vista." };
    }

    case "resolvido_sem_equipe": {
      const resumo = guardText(str(args.resumo)).safeText.replace(/\s+/g, " ").trim().slice(0, 120) || "assunto resolvido";
      state.triageResolved = resumo;
      return { resultado: "PENDENCIA_ENCERRADA", instrucao: "Continue a conversa normalmente, sem comentar isso com o cliente." };
    }

    case "enviar_localizacao": {
      state.sendLocation = true;
      state.actions.push({ label: "Enviou a localização da loja", kind: "info" });
      return { resultado: "LOCALIZACAO_SERA_ENVIADA", instrucao: "O pino vai logo depois da sua mensagem. Escreva o endereço numa frase curta (se tiver) sem dizer 'segue a localização abaixo'." };
    }

    case "cancelar_reserva": {
      const ativas = ctx.activeReservations?.() ?? [];
      const listar = () =>
        ativas.map((r) => ({
          reserva_id: r.id,
          produto: `${prettyName(r.productDescription)}${r.variantLabel && r.variantLabel !== "Único" ? ` (${r.variantLabel})` : ""}`,
          quantidade: r.quantity,
          situacao: r.status === "pending_approval" ? "aguardando a loja aprovar" : "separada",
        }));
      if (!ativas.length) return { resultado: "SEM_RESERVAS_ATIVAS", instrucao: "Diga que não há nada separado no nome dele agora." };
      const id = str(args.reserva_id).trim();
      const todas = /^(todas|todos|tudo|all|\*)$/i.test(id);
      const alvos = todas ? ativas : (id ? ativas.filter((r) => r.id === id) : ativas.length === 1 ? ativas : []);
      if (!alvos.length) {
        return {
          resultado: "ESCOLHA_A_RESERVA",
          reservas: listar(),
          instrucao: id
            ? "Esse reserva_id não é desta conversa. Use um da lista (ou 'todas')."
            : "Há mais de uma reserva: pergunte qual ele quer cancelar (ou se são todas) e chame de novo com o reserva_id, ou com 'todas'.",
        };
      }
      if (!ctx.cancelReservation) return { erro: "Cancelamento indisponível" };
      const canceladas: string[] = [];
      const falhas: Array<{ produto: string; finalizada: boolean }> = [];
      for (const alvo of alvos) {
        try {
          const r = await ctx.cancelReservation(alvo.id);
          state.sideEffect = true;
          canceladas.push(prettyName(r.productDescription));
          state.actions.push({ label: `Cliente desistiu: reserva de ${r.quantity}× ${prettyName(r.productDescription)} cancelada`, kind: "info" });
        } catch (e) {
          state.actions.push({ label: `Falha ao cancelar a reserva de ${prettyName(alvo.productDescription)}`, kind: "error" });
          falhas.push({ produto: prettyName(alvo.productDescription), finalizada: /finalizada/i.test((e as Error).message) });
        }
      }
      if (!falhas.length) {
        return {
          resultado: "RESERVA_CANCELADA",
          canceladas,
          instrucao: "Confirme ao cliente com naturalidade que cancelou e deixe a porta aberta, sem insistir.",
        };
      }
      const finalizada = falhas.some((f) => f.finalizada);
      return {
        resultado: finalizada ? "VENDA_JA_FINALIZADA" : "FALHA_AO_CANCELAR",
        canceladas,
        nao_canceladas: falhas.map((f) => f.produto),
        instrucao:
          (canceladas.length ? "Confirme o que foi cancelado. " : "") +
          "Do que não deu para cancelar, diga que a equipe vai ver com ele e use transferir_para_humano com o motivo 'cliente desistiu, cancelar " +
          (finalizada ? "venda já finalizada" : "reserva") +
          "'.",
      };
    }

    case "mensagens_automaticas": {
      const receber = args.receber === true || args.receber === "true";
      if (!ctx.setAutoMessages) return { erro: "Indisponível" };
      ctx.setAutoMessages(receber);
      state.sideEffect = true;
      state.actions.push({ label: receber ? "Cliente reativou as mensagens automáticas" : "Cliente pediu para não receber mensagens automáticas", kind: "info" });
      return {
        resultado: receber ? "AVISOS_LIGADOS" : "AVISOS_DESLIGADOS",
        instrucao: receber
          ? "Confirme numa frase que ele volta a receber os lembretes e avisos."
          : "Confirme numa frase que não vai mais mandar lembretes nem avisos automáticos, e que ele pode chamar quando quiser. Não insista.",
      };
    }

    case "ver_formas_pagamento": {
      const methods = ctx.nive.listPaymentMethods ? await ctx.nive.listPaymentMethods() : null;
      if (methods === null) {
        state.actions.push({ label: "Formas de pagamento: sem acesso no sistema", kind: "error" });
        return { resultado: "INDISPONIVEL", instrucao: "Se o texto 'SOBRE A LOJA' disser as formas de pagamento, use-o. Senão, diga que vai confirmar e use transferir_para_humano." };
      }
      // formas de uso interno (permuta, vale-troca, bonificação…) não são oferecidas ao consumidor
      const normais = methods.filter((m) => !m.storeCredit && !isInternalPaymentMethod(m.name));
      const temCrediario = methods.some((m) => m.storeCredit);
      state.actions.push({ label: `Formas de pagamento → ${normais.map((m) => m.name).join(", ") || "nenhuma"}`, kind: "info" });
      return {
        formas: normais.map((m) => m.name),
        ...(temCrediario
          ? {
              crediario:
                "A loja tem crediário, mas quem decide é sempre a equipe. Não ofereça por conta própria e nunca aprove, negue ou explique condições. Se o cliente pedir crediário, fiado ou marcar na conta, diga que a equipe vê com ele e use transferir_para_humano com o motivo 'cliente quer crediário'.",
            }
          : {}),
        instrucao:
          "Informe as formas de pagamento com naturalidade, numa frase. Não fale de taxas, juros ou parcelas. " +
          "Se o texto 'SOBRE A LOJA' restringir alguma forma (ex.: não parcelar, só PIX em promoção), ele vale acima desta lista: não ofereça o que a loja proibiu.",
      };
    }

    case "transferir_para_humano": {
      const motivo = str(args.motivo).slice(0, 120) || "pedido do cliente";
      // pergunta de produto/preço/promoção é trabalho da IA: recusa uma vez e manda consultar
      if (!state.handoffRefused && isAnswerableHandoff(motivo)) {
        state.handoffRefused = true;
        state.actions.push({ label: `Não passou para humano (“${motivo}”): consultou o sistema`, kind: "info" });
        return {
          resultado: "NAO_TRANSFERIDO",
          instrucao:
            "Isso é pergunta de produto, preço, promoção ou pagamento: você mesmo responde. Use ver_formas_pagamento (como pagar), ver_promocoes (promoções/ofertas) e buscar_produto (produtos e preços), " +
            "varrendo com termos amplos e sinônimos, e responda ao cliente com o que achou. Se não houver promoção, diga que agora não tem e mostre as opções com o preço normal. " +
            "Não diga que vai chamar alguém.",
        };
      }
      state.handoffReason = motivo;
      state.sideEffect = true;
      state.actions.push({ label: `Passou para humano: ${motivo}`, kind: "handoff" });
      return { resultado: "TRANSFERIDO", instrucao: "Avise o cliente que alguém da loja vai continuar o atendimento em instantes." };
    }

    default:
      return { erro: `Ferramenta desconhecida: ${name}` };
  }
}
