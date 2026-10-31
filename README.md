# Nive Atende

Atendente automático de WhatsApp para lojistas Nive, instalado no computador da loja.
Responde o consumidor como se fosse o lojista, consultando o ERP da Nive pela API pública,
com IA paga pela chave OpenAI do próprio lojista. Nada roda no servidor de produção da Nive.

> **Status:** MVP funcional (v0.1.0). Testado com testes automatizados. O próximo passo é rodar
> em uma loja piloto. "Nive Atende" ainda é um nome provisório.

## O que já faz

- **Produtos:** responde disponibilidade e preço com dados do ERP, envia a foto do produto e
  pergunta se o cliente quer reservar.
- **Reserva:** cria uma venda em **rascunho** no ERP. Se a reserva automática estiver desligada
  (padrão), ela fica aguardando aprovação no app.
- **Contas do cliente:** informa quanto ele tem para pagar, as parcelas, os vencimentos e os itens
  comprados. Só mostra os dados do próprio cliente, que é identificado pelo número do cadastro ou
  por CPF + segundo fator.
- **Áudio:** transcreve o áudio do cliente (ffmpeg + OpenAI) e responde por texto.
- **Passa para humano:** desconto, troca, reclamação, valor não confirmado e tudo o que estiver
  fora do escopo.
- **Interface:**
  - barra de status verde/amarela/vermelha;
  - caixa de entrada estilo WhatsApp (texto, áudio com gravação, imagem, documento, figurinha);
  - marcação **IA × humano** em cada mensagem;
  - ícone na bandeja ao lado do relógio;
  - notificações do sistema;
  - telas de pendências, reservas, consumo e auditoria;
  - termo de uso no primeiro acesso.

## Requisitos

- Node.js 22.13 ou mais novo (para desenvolver)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (para rodar a Evolution API)
- Uma chave da API Nive (plano com acesso à API, escopo `integration`) e o slug da loja
- Uma chave da OpenAI com créditos (o app mostra o passo a passo em Ajustes > Inteligência artificial)

## Rodando em desenvolvimento

```bash
npm install
cp docker/.env.example docker/.env   # troque AUTHENTICATION_API_KEY por uma chave longa
npm run evolution:up                 # sobe Evolution + Postgres + Redis no Docker
npm run dev                          # abre o app (Vite + Electron)
```

Para ver só a interface no navegador, com dados de exemplo e sem backend:

```bash
npx vite --config vite.config.ts     # http://localhost:5199
```

Parâmetros úteis: `?status=error`, `?terms=0`, `?setup=1`, `?page=ajustes&section=ia`.

### Primeira configuração no app

1. Aceite o termo de uso.
2. Em **Ajustes > Conexões**:
   - **API Nive:** informe o slug da loja e cole a chave (criada no ERP em Integração via API), depois clique em **Testar**.
   - **WhatsApp:** use a URL `http://localhost:8080`, a instância `nive-atende` e a mesma chave do `docker/.env`, depois clique em **Testar** e em **Conectar WhatsApp**. Leia o QR Code com o celular da loja (Aparelhos conectados).
3. Em **Ajustes > Inteligência artificial**, cole a chave da OpenAI e clique em **Testar**.
4. Ligue o **Atendimento automático** na barra do topo.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | App em desenvolvimento |
| `npm test` | Testes (motor, segurança, integração HTTP) |
| `npm run typecheck` | Checagem de tipos (processo principal e interface) |
| `npm run build` | Gera `dist/` |
| `npm run dist:win` | Instalador do Windows (`release/`) |
| `npm run dist:mac` | Instalador do Mac (`release/`) |
| `npm run evolution:up` / `evolution:down` | Liga/desliga a Evolution no Docker |

## Versões e instaladores

Cada versão gera dois instaladores e os publica na página **Releases** do repositório no GitHub:
- **Mac (Apple Silicon):** arquivo `.dmg`
- **Windows:** arquivo `.exe`

Quem gera os instaladores é o GitHub Actions, nas máquinas dele (`.github/workflows/build.yml`).

Para lançar uma versão, dê dois cliques em **`Nova versão.command`** (Mac) e escolha o tipo, ou rode
`npm run release -- patch|minor|major`. O versionador:

1. sobe o número da versão no `package.json`;
2. escreve no `CHANGELOG.md` os commits desde a última versão;
3. faz o commit "Versão X.Y.Z" e cria a tag `vX.Y.Z`;
4. envia para o GitHub. A tag dispara o build, que roda os testes, confere o banco do Electron, gera os
   dois instaladores e publica a Release (leva uns 15 minutos).

Os instaladores ficam na Release e não dentro do git, porque o GitHub recusa arquivos acima de 100 MB
e cada versão incharia o repositório.

**Primeira abertura:** os instaladores não têm certificado pago da Apple nem da Microsoft.
- **Mac:** se aparecer que o app não pode ser aberto, vá em Ajustes do Sistema > Privacidade e
  Segurança > **Abrir mesmo assim**.
- **Windows:** se aparecer "O Windows protegeu o computador", clique em **Mais informações** >
  **Executar assim mesmo**.

Para tirar esses avisos, é preciso assinar com um Apple Developer ID (US$ 99/ano) e um certificado
de assinatura de código para Windows.

## Estrutura

```
src/
  shared/        tipos e contrato de IPC (interface <-> processo principal)
  preload/       ponte segura (contextBridge)
  main/
    index.ts     Electron: janela, bandeja, IPC, ligação dos serviços
    settings.ts  configurações + chaves criptografadas (safeStorage)
    store/       SQLite local (node:sqlite, sem dependência nativa)
    nive/        cliente da API Nive
    evolution/   cliente REST, servidor de webhook local e leitura dos eventos
    ai/          OpenAI (chat com ferramentas + transcrição), instruções e ferramentas
    engine/      motor de atendimento, identificação, proteção de CPF, telefones
    audio/       conversão OGG -> MP3 com ffmpeg
    status/      monitor de status (verde/amarelo/vermelho)
  renderer/      interface React (com modo de demonstração quando aberta fora do Electron)
docker/          docker-compose da Evolution API
tests/           testes (vitest)
docs/            plano técnico e esboços
```

## Segurança (resumo)

- **Quem decide de qual cliente ler é o código, não a IA.** `consultar_contas` não recebe
  parâmetros: o código usa sempre o cliente verificado na sessão daquela conversa.
- **Identificação:**
  - o número que chamou bate com **exatamente um** cadastro;
  - ou o cliente informa o CPF e o telefone também bate com o cadastro;
  - ou o cliente informa o CPF e a **data de nascimento** correta (segundo fator).
  - No modo restrito, o resumo é enviado só ao número do cadastro.
- **CPF e data de nascimento nunca vão para a OpenAI:** são retirados do texto e guardados só na
  sessão local.
- **Só números +55:** um número estrangeiro nunca "bate" com um cadastro, mesmo que os dígitos finais
  sejam iguais. A comparação aceita só a diferença do nono dígito de celular.
- **CPF cadastrado e CPF inexistente têm exatamente a mesma resposta** para quem chama de outro número,
  então não dá para descobrir quem é cliente da loja.
- **Limites:**
  - até 3 CPFs consultados por número em 24 h;
  - 3 datas de nascimento erradas bloqueiam por 24 h e passam a conversa para humano;
  - o contador não zera quando a pessoa se identifica;
  - erros contra um mesmo CPF contam em qualquer conversa.
- **Valores conferidos:** valores em R$ na resposta da IA precisam ter vindo das ferramentas ou da
  conversa. Se não vierem, nada é enviado e a conversa vai para humano.
- **Chaves de acesso:** as chaves da Nive, da OpenAI e da Evolution ficam criptografadas pelo sistema
  operacional e nunca chegam à interface.
- **Webhook local:** escuta só em `127.0.0.1`, com um token aleatório no caminho.
- **Electron:** `contextIsolation`, `sandbox`, sem `nodeIntegration`, IPC só aceita a janela do app e
  navegação externa bloqueada.
- **Auditoria:** toda consulta e identificação fica registrada (tela Consumo).

## Endpoints da API Nive usados

| Uso | Endpoint |
|---|---|
| Teste de conexão | `GET /products?take=1&active=true` |
| Cliente pelo telefone | `GET /customers?q=<8 últimos dígitos>` (o número é conferido no app) |
| Cliente pelo CPF | `GET /customers/tax-id-lookup/:cpf` e `GET /customers/:id` |
| Contas do cliente | `GET /receivables/customers/:id/statement` |
| Produtos | `GET /products?q=&active=true&productType=MERCHANDISE` e `GET /products/:id` |
| Reserva | `POST /sales` → `POST /sales/:id/items` → `PATCH /sales/:id` (observação) |

## Decisões em aberto

1. O rascunho criado pelo WhatsApp deveria **baixar ou reservar estoque** no ERP? Hoje o app desconta
   as reservas dele mesmo ao informar a disponibilidade.
2. A **data de nascimento** é obrigatória no cadastro de cliente da Nive? Sem ela, o app usa o modo restrito.
3. Vale empacotar a Evolution dentro do instalador, em vez de depender do Docker Desktop.
4. Vale criar um escopo de chave "Atendimento" no ERP, só leitura + rascunho de venda.

Detalhes completos em [`docs/plano-tecnico.pdf`](docs/plano-tecnico.pdf).
