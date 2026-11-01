# Histórico de versões

## v0.3.2 — 2026-10-31

- **Escolha da plataforma de IA:** além da OpenAI (GPT), agora dá para usar a **Anthropic (Claude)** ou o **Google (Gemini)**, cada uma com a chave e os créditos do próprio lojista. Em Configurações → Inteligência artificial, com passo a passo de cada uma.
- **Todos os modelos para escolher:** lista agrupada (econômicos, equilibrados, avançados, topo de linha e gerações anteriores) com preço e custo aproximado por mil respostas. Inclui GPT-6 Luna/Terra/Sol/Astra e as gerações 5.x e 4.x; Claude Haiku/Sonnet/Opus 5.5 e Fable 5.1; Gemini 3.5 Flash-Lite, 3.8 Flash e 4 Argon. O botão Testar mostra também os modelos extras da sua conta, e há a opção de digitar outro.
- Novo padrão da OpenAI para instalações novas: **GPT-6 Luna** (mais novo e mais barato que o GPT-5 mini). Quem já escolheu um modelo continua com ele.
- Áudio: OpenAI e Gemini transcrevem sozinhos. Com o Claude, os áudios são transcritos pela OpenAI ou pelo Gemini se houver chave de um deles.
- O consumo estimado usa o preço de cada modelo de cada plataforma.

## v0.3.1 — 2026-10-31

- Mesmas novidades da 0.3.0 (o instalador da 0.3.0 não chegou a ser gerado): correção nos testes automáticos, que dependiam do fuso horário do computador.

## v0.3.0 — 2026-10-31

- **Testar IA (simulador):** nova tela para conversar com a IA como se fosse um cliente, com o catálogo real e as mesmas configurações, sem WhatsApp. Reservas e cadastros ali são só de teste.
- **Aprende com a equipe:** as últimas respostas que você e sua equipe mandaram viram exemplo do jeito da loja (valores e números são removidos). Pode desligar em Configurações → IA.
- **Foto do cliente:** quando o cliente manda foto de um produto ("tem esse?"), a IA vê a imagem e busca o mesmo ou o mais parecido no catálogo.
- **Marcar como lida:** os tracinhos ficam azuis quando a IA vai responder.
- **Avise-me quando chegar:** para produto esgotado, a IA oferece avisar; quando o estoque volta no sistema Nive, o cliente recebe a mensagem.
- **Lembrete de reserva:** algumas horas antes de vencer (padrão: 3 h), o cliente recebe um lembrete para buscar.
- **Retomar conversa parada:** se o cliente recebeu uma pergunta/opções e sumiu, a IA manda uma única mensagem leve depois de algumas horas (padrão: 4 h), só no mesmo dia.
- **Memória do cliente:** a IA anota preferências que o cliente contou (tamanho, gosto, para quem compra) e usa nas próximas conversas; aparecem em "A IA lembra" no painel do cliente, com opção de apagar.
- **Resumo do dia:** card em Consumo e, no horário escolhido, notificação e mensagem no seu celular (se informado).
- Mensagens por iniciativa própria só saem entre 8h e 20h30 e dentro do horário da loja.

## v0.2.16 — 2026-10-31

- A IA espera o cliente parar de digitar (ou de gravar áudio) antes de responder — WhatsApp embutido. Teto de 90 s para não travar.
- Uma resposta só: se o cliente manda outra mensagem enquanto a IA está pensando, o rascunho é descartado e ela responde tudo de uma vez (sem responder duas vezes a mesma coisa).
- Reserva com nome parecido com um cadastro: a IA pede nome e sobrenome; se houver cadastros parecidos (ex.: "Aliny" → "Aliny Rocker Beltrame"), o lojista confirma quem é na aprovação ou escolhe cadastrar um cliente novo. Nada é cadastrado sem essa confirmação, nem na reserva automática.

## v0.2.15 — 2026-10-31

- Nome do contato: as conversas mostram o nome que a pessoa definiu no próprio WhatsApp (também atualizado pela agenda de contatos do WhatsApp embutido).
- Renomear e salvar contato: botão de lápis no topo da conversa. O nome fica salvo no app e, se marcado, também nos contatos do WhatsApp (só no WhatsApp embutido). Deixar em branco volta ao nome do perfil. O nome do perfil continua visível como "~nome".

## v0.2.14 — 2026-10-31

- Foto de perfil do contato nas conversas, quando ele deixa a foto pública no WhatsApp (guardada por 24 h).
- Telefone completo e legível no lugar do número oculto: "+55 (48) 92002-5980". Contato sem nome aparece com o telefone formatado.

## v0.2.13 — 2026-10-31

- Foto + resposta numa mensagem só: quando a IA manda uma foto, a resposta vai como legenda da imagem (como no WhatsApp), em vez de foto com o nome do produto e depois outra mensagem.
- Corrigido o "[imagem]" que aparecia no começo de respostas da IA: o histórico não usa mais essa marcação para fotos enviadas pela loja, e marcações internas são removidas antes de enviar.

## v0.2.12 — 2026-10-31

- IA vendedora de verdade, para qualquer ramo: em pedido amplo ("tem perfume?", "quero uma roupa", "vende chocolate?") ela primeiro entende a necessidade com uma pergunta de vendedor (ex.: mais fresco, doce ou intenso; ocasião; tamanho; presente ou uso próprio) e só depois oferece 2–3 opções com o motivo de cada uma.
- A IA não repete produtos que já mostrou na conversa; em "só tem essas?" mostra apenas opções novas ou diz que são as que tem.
- Na conversa do app aparece o que a IA está fazendo: "Analisando a mensagem…", "IA pensando na resposta…", "Buscando produtos no sistema…", "Reservando o produto no sistema…".
- Correção: a análise "só assuntos da loja" falhava na OpenAI (chamada sem ferramentas) e acabava respondendo tudo.
- Dica na configuração do modelo para usar um modelo maior quando quiser respostas mais espertas.

## v0.2.11 — 2026-10-31

- Nova opção em Configurações → Reserva: "Informar ao cliente até quando fica reservado". Desligada, a confirmação sai sem data/horário limite e a IA também não fala em prazo (a validade continua valendo internamente).

## v0.2.10 — 2026-10-31

- "Responder só assuntos da loja" (ligado por padrão, em Configurações → Atendimento): antes de responder, a IA confere se a mensagem é sobre a loja. Conversa pessoal (família, amigos, fornecedores, representantes) fica sem resposta automática, sem "digitando…" e sem alerta, e aparece na conversa como "A IA não respondeu: parece conversa pessoal".
- Contatos pessoais não recebem o aviso de fora do horário.
- No meio de um atendimento da IA a análise não é repetida a cada mensagem (economiza e não atrasa). Se a análise falhar, o atendimento segue normal.

## v0.2.9 — 2026-10-31

- Botão "Cancelar reserva" na tela de Reservas (com confirmação): cancela o rascunho no sistema Nive, as peças voltam ao estoque e a reserva aparece como "Cancelada". Venda já finalizada não é cancelada por aqui.

## v0.2.8 — 2026-10-31

- Reservas acompanham o ERP: quando o rascunho é finalizado no sistema Nive, a reserva aparece como "Finalizada"; quando é excluído ou cancelado por lá, aparece como "Removida". A conferência roda a cada 2 minutos e ao abrir a tela de Reservas.
- Tela de Reservas mais limpa: nome do produto legível, número do pedido no lugar do código interno da venda.

## v0.2.7 — 2026-10-31

- Reserva em nome do cliente: a IA pergunta o nome completo quando o cliente não está identificado. O sistema procura esse nome no cadastro da Nive e, se não encontrar, cadastra o cliente novo (nome e telefone do WhatsApp) ao lançar o rascunho.
- A aprovação mostra em nome de quem é a reserva e avisa quando vai cadastrar um cliente novo ("Aprovar, cadastrar cliente e lançar rascunho"). Com vários clientes de mesmo nome, nada é vinculado nem cadastrado.
- Reserva vencida: se a venda não foi finalizada até o fim da validade, o rascunho é cancelado no ERP (as peças voltam ao estoque). Venda já finalizada nunca é mexida. Pode ser desligado em Configurações → Reserva.
- Pedido não aprovado dentro da validade vence e não pode mais ser aprovado.
- Mensagem de confirmação da reserva com o nome do produto legível e o nome do cliente.

## v0.2.6 — 2026-10-31

- O cliente vê "digitando…" no WhatsApp enquanto a IA busca as informações e prepara a resposta (renovado a cada 8 s até enviar).
- WhatsApp embutido: a loja fica "disponível" e inscrita na conversa, para o "digitando…" aparecer de fato no celular do cliente.

## v0.2.5 — 2026-10-31

- Mensagens da IA mais legíveis: um produto por linha, nome e preço em *negrito*, no máximo 3 opções por mensagem e uma pergunta no final.
- Nomes de produto em CAIXA ALTA chegam à IA já legíveis (ex.: "Perfume Connoisseur Woman Armaf 100 ml").
- A IA não informa a quantidade em estoque (só "última unidade" quando for o caso).
- Markdown que a IA eventualmente use é convertido para a formatação do WhatsApp.
- O app mostra *negrito*, _itálico_ e ~riscado~ nas conversas, como no WhatsApp.

## v0.2.4 — 2026-10-31

- IA vendedora: entende com naturalidade o que o cliente procura (para quem é, estilo, marca, quanto quer gastar), compara o catálogo antes de oferecer e recomenda as 2–3 melhores opções com estoque. Itens esgotados não são oferecidos.
- Novo campo "Contexto e personalidade da IA" em Configurações → Personalidade, para o lojista descrever a loja e o jeito de atender.
- A IA lê a conversa inteira até um limite configurável (padrão: 40 mensagens), lembrando o que o cliente já disse.
- A foto de produto enviada pela IA agora aparece na conversa do app.
- "Apagar para todos" nas mensagens enviadas pela loja; mensagens apagadas pelo cliente aparecem como apagadas (com opção de ver o original).

## v0.2.3 — 31/10/2026

- Corrige o pareamento do WhatsApp: mesma configuração da Evolution API (cliente "Chrome", sincronização inicial ligada, que o WhatsApp exige para o novo formato de contatos)
- Nova opção "Conectar com número de telefone": gera um código de 8 caracteres para digitar no celular, sem precisar da câmera
- Registro mais detalhado do pareamento para suporte

## v0.2.2 — 31/10/2026

- Corrige chaves que não eram salvas no Mac: se o Chaveiro do sistema falhar, a chave é guardada criptografada num arquivo protegido do app
- Botão de olho para mostrar/esconder a chave digitada; mostra o final da chave salva para conferência
- A chave é salva sozinha ao colar ou sair do campo, e o "Testar" salva o que está na tela antes de testar
- Mensagens claras quando falta a chave ou o slug, erro visível se não for possível salvar, e registro no log

## v0.2.1 — 31/10/2026

- Corrige o pareamento do WhatsApp ("Verifique sua conexão" no celular): o app passa a usar a versão atual do WhatsApp Web
- A janela do QR Code nunca mostra um código vencido e ganhou o botão "Gerar novo código"
- Registros (logs) da conexão do WhatsApp para suporte, com botão em Ajustes > Programa

## v0.2.0 — 31/10/2026

- WhatsApp embutido no programa (motor Baileys, o mesmo da Evolution): sem Docker, é só conectar e ler o QR Code; reconecta sozinho ao abrir
- Servidor Evolution externo continua disponível como opção avançada em Ajustes > Conexões
- Áudio gravado no app é convertido para mensagem de voz (OGG/Opus)
- Mensagem clara quando o servidor Evolution não responde

## v0.1.0 — 31/10/2026

- Primeira versão (MVP): atendimento automático no WhatsApp com IA, consulta de produtos e contas na API Nive, reserva em rascunho, transcrição de áudio, marcação IA × humano, barra de status, bandeja e instaladores para Mac e Windows
