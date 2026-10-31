# Nive Atende

Atendente automático de WhatsApp para lojistas Nive, instalado no computador da loja.
Responde o consumidor como se fosse o lojista, consultando o ERP da Nive pela API pública,
com IA paga pela chave OpenAI do próprio lojista. Nada roda no servidor de produção da Nive.

> **Status:** planejamento. O desenvolvimento ainda não começou.
> Nome "Nive Atende" provisório.

## Documentos

- [`docs/plano-tecnico.pdf`](docs/plano-tecnico.pdf): plano técnico completo (arquitetura,
  segurança, API Nive, IA, configurações, riscos e roteiro).
- [`docs/esbocos/`](docs/esbocos/): esboços de layout.
  - `01-tela-principal.png`: caixa de entrada estilo WhatsApp
  - `02-barra-de-status.png`: estados verde, amarelo e vermelho
  - `03-bandeja-e-notificacoes.png`: ícone ao lado do relógio, menu e avisos do Windows
  - `04-marcacao-ia-humano.png`: como cada resposta é marcada como IA ou humana

## Resumo do escopo

- **Sempre responde:** disponibilidade e preço de produto; reserva como rascunho no ERP
  (configurável pelo lojista).
- **Responde com identificação do cliente:** quanto tem para pagar, parcelas, vencimentos e
  itens da conta. Só do próprio cliente: identificado pelo número cadastrado, ou CPF + segundo
  fator. A autorização é feita no código, nunca pela IA.
- **Entende áudio:** transcreve e responde por texto.
- **Passa para humano:** desconto, troca, reclamação e tudo fora do escopo.
- **Interface:** barra de status no topo, caixa de entrada estilo WhatsApp (texto, áudio,
  imagem, figurinha), ícone na bandeja do Windows, marcação de cada resposta como IA ou humana.

## Stack prevista

Electron + TypeScript + React · Node.js · SQLite · Evolution API v2 (local) · OpenAI
(function calling + transcrição) · ffmpeg. Detalhes e decisões em aberto no plano técnico.
