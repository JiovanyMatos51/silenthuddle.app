# Rendezvous 1.4.1 — Vercel/Redis

O backend guarda apenas códigos temporários, ofertas e respostas do primeiro
handshake. Não cria salas, não armazena perfis ou histórico de chat, não lista
participantes e não recebe heartbeats. Cada código é de uso único e expira em
120 segundos, mesmo se o cliente fechar sem cancelar.

## Publicação

Se o repositório contém o app inteiro, use `backend` como Root Directory
na Vercel e o `vercel.json` dessa pasta. Se publicou apenas o conteúdo desta
pasta como um repositório separado, use a raiz (`.`) como Root Directory.
O handler fica em `api/index.js`; o `vercel.json` deve apontar para esse arquivo.
A rota do aplicativo continua sendo `https://SEU-DOMINIO/api/`.
A raiz do projeto também tem um wrapper/configuração de backend, caso o projeto
Vercel esteja configurado com a raiz inteira em vez de `backend`.

Configure `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`
(ou as variáveis legadas `KV_REST_API_URL` e `KV_REST_API_TOKEN`).
Sem Redis a função retorna HTTP 503 na Vercel. O fallback em memória funciona
apenas fora da Vercel para testes. A versão aceita fica na constante `VERSION`
de `api/index.js`, sincronizada com `CLIENT_VERSION` em `src/config.ts`.

Faça redeploy deste backend antes de distribuir clientes **1.4.1**.
Clientes com outra string de versão recebem HTTP 426. O namespace Redis
`silenthuddle:rendezvous:v1` não usa as salas do protocolo antigo.
Os dados antigos já tinham TTL e podem expirar naturalmente; não é necessário
apagar o Redis.

## Protocolo HTTP

Todas as requisições são POST JSON com `clientVersion: "v1.4.1"`.
O handshake e os TTLs permanecem iguais aos da versão 1.4.0.

| Ação | Enviado pelo cliente | Resposta |
| --- | --- | --- |
| `register_waiting` | `peerId`, `offer` SDP criada localmente | `code`, `token`, `expiresAt` |
| `claim_waiting` | `code`, `peerId` de quem adiciona | `peerId` de quem espera, `offer`, `claimToken` |
| `answer_waiting` | `code`, `peerId`, `claimToken`, `answer` SDP | `ok` |
| `poll_waiting` | `code`, `token` de quem espera | `answer: null` ou `{ peerId, sdp }` |
| `cancel_waiting` | `code`, `token` de quem espera | `ok` |

Os IDs de peer são UUIDs aleatórios de sessão. O código de cinco letras A–Z
é gerado com aleatoriedade criptográfica e registrado usando SET NX, com
repetição em caso de colisão. Claim, publicação da resposta e cancelamento são
atômicos no Redis (scripts Lua); dois participantes não podem consumir o mesmo
código. O código sozinho não permite ler a resposta nem cancelar a entrada.

As credenciais internas têm 256 bits, são armazenadas como hashes e jamais
devem ser copiadas junto com o código. Não são tokens de mídia ou senhas de sala.
A oferta/resposta SDP é apenas a descrição necessária ao WebRTC.

## Limites

- Dez registros de código por IP por minuto.
- Vinte claims e vinte publicações de resposta por IP por minuto.
- Cinco tentativas de código incorreto/usado bloqueiam claims desse IP por um minuto.
- Um polling autenticado por código a cada cinco segundos; a UI usa seis segundos,
  limita as verificações automáticas a cinco e permite confirmação manual.
- SDP de no máximo 64 KiB e corpo JSON de no máximo 128 KiB.
- CORS restrito às origens Tauri/Wry de desktop/Android e localhost de desenvolvimento.
  Origens adicionais precisam estar explicitamente em `SIGNALING_ALLOWED_ORIGINS`,
  separadas por vírgulas.

## Testes

Na raiz do app: `node localbackendtests/index.test.js`.
Para executar a API de desenvolvimento: `npm run dev:api`.
O log local imprime somente os nomes das ações, nunca SDP ou credenciais.
