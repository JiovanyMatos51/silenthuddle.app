/* ============================================================================
 * config.ts — Configuração de ambiente do app P2P
 * ========================================================================== */

/**
 * URL completa do endpoint serverless de sinalização (o handler em index.js).
 * Ajuste para o domínio real do seu deploy na Vercel, por exemplo:
 *   "https://meu-projeto.vercel.app/api/rooms"
 */
const env = import.meta.env ?? {};

export const SIGNALING_API_BASE = env.VITE_SIGNALING_API_BASE
  || "https://p2p-chat-test.vercel.app/api/";

const turnUrls = env.VITE_TURN_URL
  ?.split(",")
  .map((url: string) => url.trim())
  .filter(Boolean);

/** Servidores STUN públicos usados para descoberta de candidatos ICE. */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  ...(turnUrls?.length
    ? [{
        urls: turnUrls,
        username: env.VITE_TURN_USERNAME || "",
        credential: env.VITE_TURN_CREDENTIAL || "",
      }]
    : []),
];

/** O servidor só é consultado enquanto o código de entrada está aberto. */
export const JOIN_POLL_INTERVAL_MS = 6_000;
export const JOIN_POLL_MAX_ATTEMPTS = 5;
export const HANDSHAKE_TIMEOUT_MS = 20_000;

/** Versão enviada ao backend ao abrir uma sessão de sala. */
export const CLIENT_VERSION = "v1.4.1";

/** Limites compartilhados pela interface e validados novamente no backend. */
export const MAX_NICKNAME_LENGTH = 18;

/** Tamanho de cada chunk (bytes) na transferência de arquivos via DataChannel. */
export const FILE_CHUNK_SIZE = 16 * 1024;
export const FILE_CONFIRMATION_THRESHOLD = 10 * 1024 * 1024;
