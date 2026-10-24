# SilentHuddle

[Read this in English](README.md)

> **Conversas em grupo, chamadas e compartilhamento P2P.**  
> Windows · Android 7+ (API 24+) · Português e English

SilentHuddle é um aplicativo de comunicação construído com Tauri, TypeScript e
WebRTC. Mensagens, arquivos, voz, vídeo e compartilhamento de tela são trocados
diretamente entre os participantes sempre que a rede permite.

**Versão atual: 1.4.1**

<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Logo do SilentHuddle" width="112" />
</p>

## O que o app oferece

| Recurso | Descrição |
| --- | --- |
| Salas P2P | Sessões locais com código temporário de entrada e participantes em malha. |
| Chat | Mensagens, links, emojis, respostas, reações, avisos e mensagens privadas. |
| Voz e vídeo | Microfone, câmera, controle de volume por participante e detecção de fala. |
| Compartilhamento | Tela e áudio da apresentação, tela cheia e Picture-in-Picture quando suportados pelo sistema. |
| Arquivos | Previews de imagens, vídeos e áudios; confirmação antes de transferir arquivos grandes. |
| Preferências | Idioma, avatar, nickname, backend personalizado, dispositivos, áudio e efeitos sonoros. |
| Área de transferência | Colagem de imagens e arquivos no chat, incluindo leitura em blocos de arquivos do Explorador no Windows. |

<p align="center"><sub>Uma sessão efêmera para conversar com as pessoas que você escolheu.</sub></p>

## Segurança e privacidade

O WebRTC criptografa mídia e canais de dados em trânsito entre os dispositivos.
Isso protege o tráfego na rede, mas não torna confiáveis as pessoas na sala: um
participante recebe o que você envia e pode gravar mensagens, arquivos, áudio,
vídeo ou a tela. O app não tem contas, identidade verificada nem moderação.

Em conexões diretas, participantes podem descobrir o IP público uns dos outros
durante a negociação. STUN ajuda a estabelecer conexão, mas não oculta IPs. O app
aceita servidores TURN opcionais; configurar um servidor TURN, por si só, não
garante que toda conexão será retransmitida nem que o IP ficará oculto. Para isso,
a política de relay precisa ser forçada e validada no cliente. O serviço TURN
passa a transportar o tráfego.

O primeiro handshake usa um código temporário e troca descrições SDP pelo
backend. Essas descrições podem incluir candidatos ICE e endereços de rede; trate
o backend e o Redis como parte da infraestrutura confiável. O Redis mantém esse
estado temporariamente (TTL de 120 segundos). O código curto não é uma conta ou
identidade e deve ser compartilhado somente com quem você quer adicionar.

**Use o SilentHuddle apenas com pessoas de confiança.** Confirme o conteúdo antes
de compartilhar tela, câmera, microfone ou arquivos. Ao hospedar seu próprio
backend, use HTTPS, credenciais Redis protegidas e uma lista de origens CORS
adequada. CORS é uma proteção do navegador, não substitui autenticação ou limites
no servidor.

### TURN e segredos de build

Configurações `VITE_*` são incluídas no aplicativo compilado e podem ser lidas por
quem instalar o app. Não coloque senhas permanentes ou outros segredos nessas
variáveis. Para TURN em produção, prefira credenciais temporárias e limitadas.
Veja a seção [TURN](#turn-recomendado-para-produção).

## Novidades da 1.4.1

- Tela cheia no compartilhamento, com botão para sair e Escape. O Android usa
  uma expansão dentro do app quando o WebView não oferece a Fullscreen API.
  O emissor recebe pelo DataChannel um pedido para priorizar a resolução nativa
  da captura (até 30 fps); isso não aumenta artificialmente a resolução nem
  elimina limitações da rede, da captura ou do WebView.
- Ctrl+V/Colar no campo de chat envia imagens e arquivos fornecidos pela área
  de transferência. No Windows, arquivos copiados do Explorador também são
  lidos nativamente em blocos, sem montar um Blob do arquivo inteiro em RAM.
  O botão de anexar aceita múltiplos arquivos. Arquivos acima de 10 MB continuam
  exigindo aceitação do destinatário antes da transmissão.
  No Android, os itens disponíveis para colagem dependem do teclado/WebView;
  o botão de anexar continua disponível.
- **Configurar servidor** na tela inicial salva a URL completa de uma API
  compatível em AppData (no armazenamento privado do app no Android).
  Vazio restaura o padrão, sem exibir seu endereço na interface. Use HTTPS;
  HTTP só é aceito para desenvolvimento em loopback. Os amigos devem escolher
  o mesmo backend para localizar os códigos. Nenhuma conexão é feita ao salvar.
- Pop-ups de entrada, adição e configuração usam o tema preto/cinza do app.

A arquitetura de entrada e os limites da 1.4.0 foram mantidos. Não há código
reutilizável do host, servidor HTTP no PC, abertura de portas ou nova arquitetura.

## Entrada nas salas

**Criar sala** cria uma sessão apenas no dispositivo, sem requisição ao backend.
Não há nome, senha, convite por link ou botão de atualização.

**Entrar na sala** abre um pop-up com um código temporário de cinco letras
maiúsculas (A–Z), um botão para copiar e outro para confirmar a entrada. O código
vale por dois minutos. A verificação automática ocorre a cada seis segundos e
para após cinco tentativas; a confirmação manual continua disponível até a
expiração. É possível cancelar ou gerar outro código.

Qualquer participante na sala pode clicar em **Adicionar** e informar
esse código. O backend troca somente a oferta e a resposta WebRTC dessa primeira
conexão. Assim que a resposta é recebida, o cliente cancela o código e encerra
as consultas. O Redis também remove automaticamente códigos abandonados.

Os demais participantes são apresentados pela pessoa que adicionou o amigo.
As ofertas/respostas das novas conexões passam pelos DataChannels desse
intermediário, formando uma malha com conexões diretas entre os participantes.
Nomes, cores, presença, chamadas, mensagens e arquivos circulam por P2P.
Não existe heartbeat nem diretório de salas no servidor; sair do criador não
encerra a sala dos demais. Um link perdido pode ser renegociado por outro peer
ainda conectado. Se não restar nenhuma conexão intermediária, use um novo código
de entrada para restabelecer o encontro.

O histórico de mensagens públicas, avisos, respostas e reações é sincronizado
pelas novas conexões da malha, em lotes com controle do buffer e deduplicação.
Referências a arquivos incluem nome, tipo e tamanho, sem retransmitir os bytes
automaticamente para quem entrou depois. Mensagens
privadas de `/msg` e mensagens locais de comandos não entram nessa sincronização.
O histórico pertence à sessão em memória e termina quando o usuário sai dela.

## Comandos do chat

| Comando | Exemplo | Resultado |
| --- | --- | --- |
| `/help` | `/help` | Exibe a lista de comandos só para você. |
| `/avatarcolor` | `/avatarcolor blue` | Muda a cor do avatar; aceita cores CSS e nomes comuns em português ou inglês. |
| `/nickname` | `/nickname joao123` | Altera seu nome, limitado a 18 caracteres. |
| `/warn` | `/warn aviso importante` | Envia um aviso destacado para a sala. |
| `/msg` | `/msg joao123 mensagem privada` | Envia mensagem privada para o participante com aquele nickname. |

## Estrutura

```text
src/                 Interface, WebRTC, chat, mídia e configurações
src-tauri/           Aplicativo nativo Tauri, Rust e configuração Android
backend/             API de sinalização para Vercel e Redis
api/                 Wrapper para publicar a API usando a raiz do projeto
scripts/             API local e testes de protocolo/recursos
localbackendtests/   Testes do backend de sinalização
```

**Atualização necessária:** publique o backend 1.4.1 de `backend` antes
de distribuir os clientes 1.4.1: a checagem de versão exige `v1.4.1`.
O protocolo não é compatível com o diretório
de salas da versão 1.3.3. Consulte `backend/README.md`.

## Desenvolvimento

Para testar o backend localmente, execute `npm run dev:api`. Antes de iniciar o
app em outro terminal, defina `VITE_SIGNALING_API_BASE=http://127.0.0.1:3001/api/`.
Na Vercel, o armazenamento em memória local é desabilitado e Redis é obrigatório.


```powershell
npm install
npm run tauri -- dev
```

Pré-requisitos no Windows: Node.js, Rust com toolchain MSVC e Visual Studio
Build Tools com o componente **Desenvolvimento para Desktop com C++**. Para criar
os instaladores release:

```powershell
npm run tauri -- build
```

Os pacotes são gravados em `src-tauri/target/release/bundle/`. Por padrão, a
`.gitignore` mantém instaladores, APKs, caches e arquivos de assinatura fora do
controle de versão.

Scripts úteis definidos em `package.json`:

```powershell
npm run build       # build da interface
npm run check       # verificação TypeScript
npm test            # testes existentes do backend e do protocolo
```

## Android (API 24+)

O projeto Android já está gerado em `src-tauri/gen/android` e reutiliza o
mesmo frontend da versão desktop. A configuração específica fica em
`src-tauri/tauri.android.conf.json`; permissões e integração nativa ficam no
projeto gerado.

Pré-requisitos no Windows:

- Android Studio com Android SDK, Platform-Tools, Build-Tools e NDK instalados.
- JDK 17.
- Visual Studio Build Tools com o componente **Desenvolvimento para Desktop
  com C++** (o Rust/MSVC usa `link.exe` até para executar build scripts durante
  a compilação Android no Windows).
- `ANDROID_HOME`, `JAVA_HOME` e `NDK_HOME` apontando para as instalações locais.
- Os quatro targets Rust para Android.

Exemplo para a instalação atualmente usada neste computador:

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot"
$env:ANDROID_HOME = "D:\dev\androidsdk"
$env:NDK_HOME = "D:\dev\androidsdk\ndk\27.1.12297006"

rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm install
```

Com um aparelho com depuração USB habilitada ou um emulador aberto:

```powershell
adb devices
npm run tauri -- android dev
```

Para gerar APKs de release separados por arquitetura:

```powershell
npm run tauri -- android build --apk --split-per-abi
```

Para gerar o Android App Bundle usado pela Play Store:

```powershell
npm run tauri -- android build --aab
```

Para produzir um APK universal de release:

```powershell
npm run tauri -- android build --apk --ci
```

Os artefatos são produzidos abaixo de
`src-tauri/gen/android/app/build/outputs`. Para publicar uma atualização,
assine o APK com a mesma keystore release das versões anteriores. O compartilhamento de tela
é habilitado quando o Android System WebView oferece `getDisplayMedia`; em
WebViews sem essa API, o app avisa que o recurso não está disponível. O áudio
da apresentação também depende de a fonte escolhida e o sistema fornecerem
uma faixa de áudio.

O endpoint de sinalização padrão fica em `src/config.ts`. Ele pode ser alterado
sem editar o código por meio de `VITE_SIGNALING_API_BASE`.

Durante uma chamada, a versão Android mantém um serviço em primeiro plano com
uma notificação persistente. Isso impede que o processo e o mecanismo WebRTC
sejam suspensos ao trocar de aplicativo. No Android 13 ou superior, autorize as
notificações quando solicitado. Ao sair da chamada, o serviço é encerrado.

## TURN (recomendado para produção)

STUN é suficiente em muitas redes, mas conexões atrás de NAT simétrico ou redes
corporativas precisam de um relay TURN. Configure no build do frontend:

```text
VITE_TURN_URL=turn:turn.exemplo.com:3478,turns:turn.exemplo.com:5349
VITE_TURN_USERNAME=usuario
VITE_TURN_CREDENTIAL=senha
```

As instruções do encontro inicial no backend estão em
`backend/README.md`.

## Identidade e metadados do aplicativo

- Nome, versão, identificador, empresa, copyright e descrições do instalador:
  `src-tauri/tauri.conf.json`.
- Autor, licença, homepage e versão do binário Rust: `src-tauri/Cargo.toml`.
- Nome e versão do pacote da interface: `package.json`.
- Ícone-fonte: `src/assets/logo.ico`. Para regenerar todos os formatos usados
  pelo instalador, execute `npm run tauri -- icon src/assets/logo.ico`.

## Licença

O SilentHuddle está sob a **licença MIT**. Consulte [`LICENSE.txt`](LICENSE.txt)
para ler o texto completo. A licença permite uso, modificação e redistribuição,
inclusive comercial, desde que os avisos de copyright e da licença sejam mantidos.

## Verificação sem compilar instaladores

```powershell
node node_modules/typescript/bin/tsc --noEmit
node localbackendtests/index.test.js
node --experimental-transform-types scripts/protocol.test.ts
node --experimental-transform-types scripts/features.test.ts
```

Os testes de protocolo cobrem a entrada de um terceiro peer pelo intermediário,
saída do criador, reconexão por outro peer, deduplicação de handshakes e exclusão
de conversas privadas do histórico. O teste TypeScript usa Node 24 com suporte
a transformação de tipos.

A negociação usa ofertas/respostas SDP; seu transporte pode ser HTTP no
primeiro encontro ou DataChannel nas apresentações seguintes.
Referência: [sinalização WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling).
