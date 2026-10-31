# Histórico de versões

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
