import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const VERSION = "v1.4.1";
const TTL_SECONDS = 120;
const PREFIX = "silenthuddle:rendezvous:v1";
const MAX_SDP_BYTES = 64 * 1024;
const ALLOWED_ORIGINS = new Set([
  "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost",
  "http://localhost:1420", "http://127.0.0.1:1420",
]);
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

class HttpError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    Object.assign(this, { status, code, retryAfter });
  }
}

class RedisStore {
  constructor(url, token) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  async command(...args) {
    const response = await fetch(this.url, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error || "Falha no Redis.");
    return body.result;
  }

  async rate(bucket, key, seconds = 60) {
    return Number(await this.command("EVAL",
      "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
      "1", `${PREFIX}:rate:${bucket}:${hash(key)}`, String(seconds)));
  }

  async throttle(key) {
    return (await this.command("SET", `${PREFIX}:poll:${hash(key)}`, "1", "NX", "EX", "5")) === "OK";
  }

  async rateCount(bucket, key) {
    return Number(await this.command("GET", `${PREFIX}:rate:${bucket}:${hash(key)}`)) || 0;
  }

  async create(code, record) {
    return (await this.command("SET", `${PREFIX}:waiting:${code}`, JSON.stringify(record), "NX", "EX", String(TTL_SECONDS))) === "OK";
  }

  async read(code) {
    const raw = await this.command("GET", `${PREFIX}:waiting:${code}`);
    return raw ? JSON.parse(raw) : null;
  }

  async claim(code, peerId, claimHash) {
    const result = await this.command("EVAL",
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 'missing' end
       local r = cjson.decode(raw)
       if r.peerId == ARGV[1] then return 'self' end
       if r.sponsorId then return 'busy' end
       local ttl = redis.call('PTTL', KEYS[1])
       if ttl <= 0 then return 'missing' end
       r.sponsorId = ARGV[1]; r.claimHash = ARGV[2]
       local encoded = cjson.encode(r)
       redis.call('SET', KEYS[1], encoded, 'PX', ttl)
       return encoded`,
      "1", `${PREFIX}:waiting:${code}`, peerId, claimHash);
    return ["missing", "self", "busy"].includes(result) ? result : JSON.parse(result);
  }

  async answer(code, peerId, claimHash, answer) {
    return this.command("EVAL",
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 'missing' end
       local r = cjson.decode(raw)
       if r.sponsorId ~= ARGV[1] or r.claimHash ~= ARGV[2] then return 'unauthorized' end
       if r.answer then return 'answered' end
       local ttl = redis.call('PTTL', KEYS[1])
       if ttl <= 0 then return 'missing' end
       r.answer = cjson.decode(ARGV[3])
       redis.call('SET', KEYS[1], cjson.encode(r), 'PX', ttl)
       return 'ok'`,
      "1", `${PREFIX}:waiting:${code}`, peerId, claimHash, JSON.stringify(answer));
  }

  async cancel(code, tokenHash) {
    return this.command("EVAL",
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 'missing' end
       local r = cjson.decode(raw)
       if r.tokenHash ~= ARGV[1] then return 'unauthorized' end
       redis.call('DEL', KEYS[1])
       return 'ok'`,
      "1", `${PREFIX}:waiting:${code}`, tokenHash);
  }
}

/** Development/test fallback only; Vercel always requires Redis. */
class MemoryStore {
  records = new Map();
  limits = new Map();
  polls = new Map();

  async rate(bucket, key, seconds = 60) {
    const id = `${bucket}:${key}`;
    let record = this.limits.get(id);
    if (!record || record.until <= Date.now()) {
      record = { count: 0, until: Date.now() + seconds * 1000 };
      this.limits.set(id, record);
    }
    return ++record.count;
  }

  async throttle(key) {
    if ((this.polls.get(key) || 0) > Date.now()) return false;
    this.polls.set(key, Date.now() + 5_000);
    return true;
  }

  async create(code, record) {
    if ((this.records.get(code)?.expiresAt || 0) > Date.now()) return false;
    this.records.set(code, record);
    return true;
  }

  async read(code) {
    const record = this.records.get(code);
    if (record?.expiresAt <= Date.now()) this.records.delete(code);
    return this.records.get(code) || null;
  }

  async rateCount(bucket, key) {
    const record = this.limits.get(`${bucket}:${key}`);
    return record && record.until > Date.now() ? record.count : 0;
  }

  async claim(code, peerId, claimHash) {
    const record = await this.read(code);
    if (!record) return "missing";
    if (record.peerId === peerId) return "self";
    if (record.sponsorId) return "busy";
    record.sponsorId = peerId;
    record.claimHash = claimHash;
    return record;
  }

  async answer(code, peerId, claimHash, answer) {
    const record = await this.read(code);
    if (!record) return "missing";
    if (record.sponsorId !== peerId || !equal(record.claimHash, claimHash)) return "unauthorized";
    if (record.answer) return "answered";
    record.answer = answer;
    return "ok";
  }

  async cancel(code, tokenHash) {
    const record = await this.read(code);
    if (!record) return "missing";
    if (!equal(record.tokenHash, tokenHash)) return "unauthorized";
    this.records.delete(code);
    return "ok";
  }
}

const store = redisUrl && redisToken ? new RedisStore(redisUrl, redisToken)
  : process.env.VERCEL ? null : new MemoryStore();

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Vary", "Origin");
  const origin = header(req, "origin").replace(/\/$/, "");
  const allowed = new Set([...ALLOWED_ORIGINS,
    ...(process.env.SIGNALING_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean)]);
  if (origin && !allowed.has(origin)) return res.status(403).json({ code: "CORS_ORIGIN_DENIED", error: "Origem não autorizada." });
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ code: "METHOD_NOT_ALLOWED", error: "Use o método POST." });
  if (!store) return res.status(503).json({ code: "SIGNALING_STORE_NOT_CONFIGURED", error: "Configure as credenciais do Redis." });

  try {
    const body = parseBody(req.body);
    if (body.clientVersion !== VERSION) throw new HttpError(426, "CLIENT_OUTDATED", "Seu cliente está desatualizado. Atualize para continuar usando o app.");
    const ip = header(req, "x-vercel-forwarded-for") || header(req, "x-forwarded-for") || req.socket?.remoteAddress || "unknown";
    const ipKey = ip.split(",")[0].trim();

    switch (body.action) {
      case "register_waiting": {
        await rate("register", ipKey, 10, "REGISTER_RATE_LIMITED");
        const peerId = validateId(body.peerId);
        const offer = validateSdp(body.offer, "offer");
        const token = randomBytes(32).toString("hex");
        const expiresAt = Date.now() + TTL_SECONDS * 1000;
        for (let attempt = 0; attempt < 20; attempt++) {
          const code = Array.from({ length: 5 }, () => String.fromCharCode(65 + randomInt(26))).join("");
          if (await store.create(code, { peerId, offer, tokenHash: hash(token), expiresAt })) {
            return res.status(200).json({ code, token, expiresAt });
          }
        }
        throw new HttpError(503, "CODE_ALLOCATION_FAILED", "Não foi possível gerar um código. Tente novamente.");
      }
      case "claim_waiting": {
        await rate("claim", ipKey, 20, "CLAIM_RATE_LIMITED");
        const peerId = validateId(body.peerId);
        const code = validateCode(body.code);
        if (await store.rateCount("code-failure", ipKey) >= 5) {
          throw new HttpError(429, "CODE_ATTEMPTS_BLOCKED", "Muitos códigos incorretos. Aguarde um minuto.", 60);
        }
        const claimToken = randomBytes(32).toString("hex");
        const record = await store.claim(code, peerId, hash(claimToken));
        if (record === "missing" || record === "busy") {
          await store.rate("code-failure", ipKey);
          if (record === "missing") throw new HttpError(404, "CODE_NOT_FOUND", "Código não encontrado ou expirado.");
          throw new HttpError(409, "CODE_USED", "Esse código já foi utilizado. Peça um novo código.");
        }
        if (record === "self") throw new HttpError(400, "SELF_JOIN", "Não é possível adicionar seu próprio código.");
        return res.status(200).json({ peerId: record.peerId, offer: record.offer, claimToken });
      }
      case "answer_waiting": {
        await rate("answer", ipKey, 20, "CLAIM_RATE_LIMITED");
        const result = await store.answer(validateCode(body.code), validateId(body.peerId),
          hash(validateToken(body.claimToken)), validateSdp(body.answer, "answer"));
        if (result === "missing") throw new HttpError(404, "CODE_NOT_FOUND", "Código expirado.");
        if (result === "unauthorized") throw new HttpError(401, "INVALID_TOKEN", "Token de conexão inválido.");
        if (result === "answered") throw new HttpError(409, "CODE_USED", "Resposta já publicada.");
        return res.status(200).json({ ok: true });
      }
      case "poll_waiting": {
        const code = validateCode(body.code);
        const token = validateToken(body.token);
        const record = await store.read(code);
        if (!record) throw new HttpError(404, "CODE_NOT_FOUND", "Código não encontrado ou expirado.");
        if (!equal(record.tokenHash, hash(token))) throw new HttpError(401, "INVALID_TOKEN", "Token de entrada inválido.");
        if (!await store.throttle(`${code}:${hash(token)}`)) throw new HttpError(429, "POLL_TOO_FAST", "Aguarde antes de confirmar novamente.", 5);
        return res.status(200).json({ answer: record.answer ? { peerId: record.sponsorId, sdp: record.answer } : null });
      }
      case "cancel_waiting": {
        await rate("cancel", ipKey, 30, "CLAIM_RATE_LIMITED");
        const result = await store.cancel(validateCode(body.code), hash(validateToken(body.token)));
        if (result === "unauthorized") throw new HttpError(401, "INVALID_TOKEN", "Token de entrada inválido.");
        return res.status(200).json({ ok: true });
      }
      default:
        throw new HttpError(400, "UNKNOWN_ACTION", "Ação não disponível nesta versão.");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
      return res.status(error.status).json({ code: error.code, error: error.message });
    }
    console.error("Falha no rendezvous", error);
    return res.status(503).json({ code: "SIGNALING_UNAVAILABLE", error: "Não foi possível acessar o serviço de conexão." });
  }
}

async function rate(bucket, key, max, code) {
  if (await store.rate(bucket, key) > max) throw new HttpError(429, code, "Muitas tentativas nesta rede. Aguarde um minuto.", 60);
}

function parseBody(raw) {
  try {
    if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
    if (Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw || {}), "utf8") > 128 * 1024) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Payload muito grande.");
    }
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_BODY", "JSON inválido.");
  }
}

function validateSdp(value, type) {
  if (!value || value.type !== type || typeof value.sdp !== "string"
    || !/^v=0[\r\n]/.test(value.sdp) || !value.sdp.includes("m=application ")) {
    throw new HttpError(400, "INVALID_SDP", "Descrição WebRTC inválida.");
  }
  if (Buffer.byteLength(value.sdp, "utf8") > MAX_SDP_BYTES) throw new HttpError(413, "SDP_TOO_LARGE", "Descrição WebRTC muito grande.");
  return { type, sdp: value.sdp };
}

function validateId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new HttpError(400, "INVALID_PEER_ID", "Identificador inválido.");
  return value;
}

function validateCode(value) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{5}$/.test(code)) throw new HttpError(400, "INVALID_CODE", "O código precisa ter cinco letras maiúsculas.");
  return code;
}

function validateToken(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new HttpError(401, "INVALID_TOKEN", "Token inválido.");
  return value;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function equal(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : typeof value === "string" ? value : "";
}
