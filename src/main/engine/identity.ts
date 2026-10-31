// Identificação do cliente. Regra de ouro: quem decide de qual cliente os dados são lidos é este código,
// nunca a IA. A IA só pede "identificar" e "consultar"; o cliente usado é sempre o da sessão desta conversa.
import { createHash } from "node:crypto";
import type { Store } from "../store/db";
import type { NiveApi, NiveCustomer } from "../nive/client";
import type { SecondFactor } from "../../shared/types";
import { isValidCpf, sameBirthDate } from "./guard";
import { samePhone } from "./phone";

export const CPF_SESSION_TTL_MS = 30 * 60 * 1000;
export const PHONE_LOOKUP_TTL_MS = 10 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 3;
export const MAX_CPF_LOOKUPS = 3;
export const BLOCK_MS = 24 * 60 * 60 * 1000;
const SUMMARY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface IdentitySession {
  customerId: string | null;
  customerName: string | null;
  verifiedBy: "phone" | "cpf" | null;
  verifiedAt: number | null;
  /** Candidatos quando o número aparece em mais de um cadastro. */
  phoneCandidates: string[];
  phoneLookupAt: number | null;
  /** Cliente encontrado pelo CPF aguardando o segundo fator. */
  pending: { customerId: string | null; name: string; birthDate: string | null; phone: string | null; cpfHash: string } | null;
  /** Momentos em que um CPF foi consultado a partir de um número diferente do cadastro. */
  cpfLookups: number[];
  failedAttempts: number;
  firstFailAt: number | null;
  blockedUntil: number | null;
  /** Últimos valores sensíveis digitados (nunca vão para a IA). */
  lastCpf: string | null;
  lastDate: string | null;
  lastActivityAt: number;
}

export function emptySession(now: number): IdentitySession {
  return {
    customerId: null,
    customerName: null,
    verifiedBy: null,
    verifiedAt: null,
    phoneCandidates: [],
    phoneLookupAt: null,
    pending: null,
    failedAttempts: 0,
    firstFailAt: null,
    blockedUntil: null,
    cpfLookups: [],
    lastCpf: null,
    lastDate: null,
    lastActivityAt: now,
  };
}

/** Resultado entregue à IA. Os códigos são estáveis; a IA recebe também uma instrução do que dizer. */
export type IdentifyOutcome =
  | { resultado: "IDENTIFICADO"; nome: string; instrucao: string }
  | { resultado: "PEDIR_DATA_NASCIMENTO"; instrucao: string }
  | { resultado: "NAO_CONFIRMADO"; instrucao: string }
  | { resultado: "CPF_NAO_INFORMADO"; instrucao: string }
  | { resultado: "CPF_INVALIDO"; instrucao: string }
  | { resultado: "BLOQUEADO"; instrucao: string }
  | { resultado: "RESUMO_ENVIADO_AO_CADASTRO"; instrucao: string };

const GENERIC_FAIL =
  "Diga com gentileza que não foi possível confirmar o cadastro por aqui e que vai chamar alguém da loja. Não diga se o CPF existe ou não.";

export interface IdentityDeps {
  store: Store;
  nive: NiveApi;
  now?: () => number;
  /** Envia o resumo da conta para o telefone do cadastro (modo restrito). */
  sendSummaryToRegisteredPhone?: (customer: { id: string; name: string; phone: string }) => Promise<boolean>;
  onBlocked?: (conversationId: string, phone: string) => void;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export class IdentityService {
  private readonly now: () => number;

  constructor(private readonly deps: IdentityDeps) {
    this.now = deps.now ?? Date.now;
  }

  load(conversationId: string): IdentitySession {
    const now = this.now();
    const s = this.deps.store.getIdentitySession<IdentitySession>(conversationId) ?? emptySession(now);
    // sessão por CPF expira por inatividade
    if (s.verifiedBy === "cpf" && now - s.lastActivityAt > CPF_SESSION_TTL_MS) {
      s.customerId = null;
      s.customerName = null;
      s.verifiedBy = null;
      s.verifiedAt = null;
    }
    if (s.pending && now - s.lastActivityAt > CPF_SESSION_TTL_MS) s.pending = null;
    if (s.blockedUntil && s.blockedUntil < now) {
      s.blockedUntil = null;
      s.failedAttempts = 0;
      s.firstFailAt = null;
      s.cpfLookups = [];
    }
    return s;
  }

  save(conversationId: string, s: IdentitySession): void {
    s.lastActivityAt = this.now();
    this.deps.store.setIdentitySession(conversationId, s);
  }

  /** Guarda o CPF/data digitados (já retirados do texto que vai para a IA). */
  rememberSensitive(conversationId: string, cpfs: string[], dates: string[]): void {
    if (!cpfs.length && !dates.length) {
      const s = this.load(conversationId);
      this.save(conversationId, s);
      return;
    }
    const s = this.load(conversationId);
    if (cpfs.length) s.lastCpf = cpfs[cpfs.length - 1]!;
    if (dates.length) s.lastDate = dates[dates.length - 1]!;
    this.save(conversationId, s);
  }

  /**
   * Identificação automática pelo número: só quando o telefone que chamou bate com exatamente um cadastro.
   */
  async autoIdentifyByPhone(conversationId: string, phone: string): Promise<IdentitySession> {
    const s = this.load(conversationId);
    const now = this.now();
    if (s.verifiedBy === "cpf" && s.customerId) return s;
    if (s.phoneLookupAt && now - s.phoneLookupAt < PHONE_LOOKUP_TTL_MS) return s;

    const matches = await this.deps.nive.findCustomersByPhone(phone);
    s.phoneLookupAt = now;
    if (matches.length === 1) {
      const c = matches[0]!;
      s.customerId = c.id;
      s.customerName = c.name;
      s.verifiedBy = "phone";
      s.verifiedAt = now;
      s.phoneCandidates = [];
      this.deps.store.audit(phone, c.id, "identificacao_telefone", "identificado");
    } else {
      if (s.verifiedBy === "phone") {
        s.customerId = null;
        s.customerName = null;
        s.verifiedBy = null;
        s.verifiedAt = null;
      }
      s.phoneCandidates = matches.map((m) => m.id);
    }
    this.save(conversationId, s);
    return s;
  }

  /** Falhas de identificação contra um mesmo CPF (em qualquer conversa) nas últimas 24 h. */
  private targetFailures(cpfHash: string): number {
    const rec = this.deps.store.getKv<{ count: number; firstAt: number }>(`idfail:${cpfHash}`);
    if (!rec || this.now() - rec.firstAt > BLOCK_MS) return 0;
    return rec.count;
  }

  private addTargetFailure(cpfHash: string): void {
    const key = `idfail:${cpfHash}`;
    const rec = this.deps.store.getKv<{ count: number; firstAt: number }>(key);
    const fresh = !rec || this.now() - rec.firstAt > BLOCK_MS;
    this.deps.store.setKv(key, fresh ? { count: 1, firstAt: this.now() } : { count: rec!.count + 1, firstAt: rec!.firstAt });
  }

  private block(conversationId: string, phone: string, s: IdentitySession, why: string): IdentifyOutcome {
    s.blockedUntil = this.now() + BLOCK_MS;
    s.pending = null;
    s.lastCpf = null;
    s.lastDate = null;
    this.save(conversationId, s);
    this.deps.store.audit(phone, null, "identificacao_bloqueada", why);
    this.deps.onBlocked?.(conversationId, phone);
    return {
      resultado: "BLOQUEADO",
      instrucao:
        "Diga que, por segurança, a consulta de contas foi pausada para este número e que alguém da loja vai continuar o atendimento. Não dê detalhes.",
    };
  }

  /** Conta uma falha. O contador NÃO zera quando alguém se identifica: só a janela de 24 h o renova. */
  private registerFailure(conversationId: string, phone: string, s: IdentitySession, reason: string): IdentifyOutcome {
    const now = this.now();
    if (!s.firstFailAt || now - s.firstFailAt > BLOCK_MS) {
      s.firstFailAt = now;
      s.failedAttempts = 0;
    }
    s.failedAttempts += 1;
    s.pending = null;
    s.lastCpf = null;
    s.lastDate = null;
    this.deps.store.audit(phone, null, "identificacao_falhou", reason);
    if (s.failedAttempts >= MAX_FAILED_ATTEMPTS) return this.block(conversationId, phone, s, `${s.failedAttempts} tentativas erradas`);
    this.save(conversationId, s);
    return { resultado: "NAO_CONFIRMADO", instrucao: GENERIC_FAIL };
  }

  /**
   * Chamado pela ferramenta identificar_cliente. Usa o CPF guardado da última mensagem do cliente.
   * Para quem chama de outro número, CPF cadastrado e CPF inexistente têm EXATAMENTE a mesma resposta
   * (assim não dá para descobrir se um CPF é cliente da loja), e cada consulta conta no limite.
   */
  async identifyByCpf(conversationId: string, phone: string, secondFactor: SecondFactor): Promise<IdentifyOutcome> {
    const s = this.load(conversationId);
    if (s.blockedUntil) {
      return {
        resultado: "BLOQUEADO",
        instrucao: "Diga que a consulta de contas está pausada para este número por segurança e que alguém da loja vai ajudar.",
      };
    }
    if (s.verifiedBy && s.customerId) {
      return { resultado: "IDENTIFICADO", nome: firstName(s.customerName ?? ""), instrucao: "O cliente já está identificado; siga com a consulta." };
    }
    const cpf = s.lastCpf;
    if (!cpf) {
      return { resultado: "CPF_NAO_INFORMADO", instrucao: "Peça para o cliente digitar o CPF (só números ou com pontos)." };
    }
    if (!isValidCpf(cpf)) {
      s.lastCpf = null;
      this.save(conversationId, s);
      return { resultado: "CPF_INVALIDO", instrucao: "Diga que o CPF parece incompleto ou com algum número trocado e peça para conferir." };
    }
    s.lastCpf = null; // usado uma vez
    const cpfHash = createHash("sha256").update(`nive-atende:${cpf}`).digest("hex");

    const customer: NiveCustomer | null = await this.deps.nive.findCustomerByCpf(cpf);

    // Mesmo número do cadastro (ou desempate de telefone compartilhado): identificado.
    if (customer && (samePhone(customer.phone, phone) || s.phoneCandidates.includes(customer.id))) {
      s.customerId = customer.id;
      s.customerName = customer.name;
      s.verifiedBy = "cpf";
      s.verifiedAt = this.now();
      s.pending = null;
      this.save(conversationId, s);
      this.deps.store.audit(phone, customer.id, "identificacao_cpf_telefone", "identificado");
      return { resultado: "IDENTIFICADO", nome: firstName(customer.name), instrucao: "Cliente confirmado; siga com a consulta pedida." };
    }

    // Outro número: cada CPF consultado conta no limite da conversa.
    const now = this.now();
    s.cpfLookups = (s.cpfLookups ?? []).filter((at) => now - at < BLOCK_MS);
    s.cpfLookups.push(now);
    if (s.cpfLookups.length > MAX_CPF_LOOKUPS) return this.block(conversationId, phone, s, `${s.cpfLookups.length} CPFs consultados`);
    this.deps.store.audit(phone, customer?.id ?? null, "identificacao_cpf_numero_diferente", customer ? "cpf_cadastrado" : "cpf_nao_cadastrado");

    if (secondFactor === "birthdate") {
      // Para CPF inexistente, CPF sem data no cadastro ou CPF já atacado, nenhuma data vai conferir —
      // mas a resposta é a mesma, para não revelar nada.
      const usable = customer && customer.birthDate && this.targetFailures(cpfHash) < MAX_FAILED_ATTEMPTS;
      s.pending = {
        customerId: usable ? customer!.id : null,
        name: usable ? customer!.name : "",
        birthDate: usable ? customer!.birthDate : null,
        phone: null,
        cpfHash,
      };
      this.save(conversationId, s);
      return {
        resultado: "PEDIR_DATA_NASCIMENTO",
        instrucao:
          "Para segurança, peça a data de nascimento do titular (dia/mês/ano). Não diga o nome nem confirme que o CPF foi encontrado.",
      };
    }

    // Modo restrito: nada é mostrado aqui; se o CPF existir, o resumo vai só para o número do cadastro.
    this.save(conversationId, s);
    if (customer?.phone && this.deps.sendSummaryToRegisteredPhone) {
      const key = `summary:${customer.id}`;
      const last = this.deps.store.getKv<number>(key) ?? 0;
      if (now - last > SUMMARY_COOLDOWN_MS) {
        const sent = await this.deps.sendSummaryToRegisteredPhone({ id: customer.id, name: customer.name, phone: customer.phone }).catch(() => false);
        if (sent) this.deps.store.setKv(key, now);
      }
    }
    return {
      resultado: "RESUMO_ENVIADO_AO_CADASTRO",
      instrucao:
        "Diga apenas: por segurança, as informações de conta só são enviadas para o número que está no cadastro do titular; se o CPF estiver cadastrado, o resumo vai para lá. Não confirme se o CPF existe.",
    };
  }

  /** Chamado pela ferramenta confirmar_data_nascimento. Usa a data guardada da última mensagem. */
  async confirmBirthDate(conversationId: string, phone: string): Promise<IdentifyOutcome> {
    const s = this.load(conversationId);
    if (s.blockedUntil) {
      return { resultado: "BLOQUEADO", instrucao: "Diga que a consulta está pausada por segurança e que alguém da loja vai ajudar." };
    }
    if (!s.pending) {
      return { resultado: "CPF_NAO_INFORMADO", instrucao: "Peça primeiro o CPF do titular." };
    }
    const informed = s.lastDate;
    if (!informed) {
      return { resultado: "PEDIR_DATA_NASCIMENTO", instrucao: "Peça a data de nascimento no formato dia/mês/ano." };
    }
    s.lastDate = null;
    const p = s.pending;
    if (!p.customerId || !sameBirthDate(informed, p.birthDate)) {
      this.addTargetFailure(p.cpfHash);
      return this.registerFailure(conversationId, phone, s, "data_nascimento_nao_confere");
    }
    s.customerId = p.customerId;
    s.customerName = p.name;
    s.verifiedBy = "cpf";
    s.verifiedAt = this.now();
    s.pending = null;
    this.save(conversationId, s);
    this.deps.store.audit(phone, p.customerId, "identificacao_cpf_nascimento", "identificado");
    return { resultado: "IDENTIFICADO", nome: firstName(p.name), instrucao: "Cliente confirmado; siga com a consulta pedida." };
  }

  /** O único caminho para saber de qual cliente ler contas: a sessão verificada desta conversa. */
  verifiedCustomerId(conversationId: string): { id: string; name: string; by: "phone" | "cpf" } | null {
    const s = this.load(conversationId);
    if (!s.customerId || !s.verifiedBy || s.blockedUntil) return null;
    return { id: s.customerId, name: s.customerName ?? "", by: s.verifiedBy };
  }
}
