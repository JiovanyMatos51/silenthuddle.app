import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import handler from "../backend/api/index.js";

const offer = { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
const answer = { ...offer, type: "answer" };
let sequence = 1;
async function call(body, options = {}) {
  const ip = options.ip || `198.51.100.${sequence++}`;
  const response = {
    statusCode: 200, headers: {}, payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    end() { return this; },
  };
  await handler({
    method: options.method || "POST",
    body: { clientVersion: "v1.4.1", ...body },
    headers: { "x-forwarded-for": ip, ...options.headers },
    socket: { remoteAddress: ip },
  }, response);
  return response;
}

async function register(options = {}) {
  const peerId = randomUUID();
  const response = await call({ action: "register_waiting", peerId, offer }, options);
  assert.equal(response.statusCode, 200);
  return { peerId, ...response.payload };
}

test("código de cinco letras, credencial privada e expiração de dois minutos", async () => {
  const ticket = await register();
  assert.match(ticket.code, /^[A-Z]{5}$/);
  assert.match(ticket.token, /^[a-f0-9]{64}$/);
  assert.ok(ticket.expiresAt - Date.now() <= 120_000 && ticket.expiresAt > Date.now() + 119_000);
  assert.equal((await call({ action: "create_room" })).statusCode, 400);
  assert.equal((await call({ action: "heartbeat" })).statusCode, 400);
  assert.equal((await call({ action: "list_peers" })).statusCode, 400);
});

test("primeiro encontro troca SDP, protege a consulta e consome o código", async () => {
  const ticket = await register();
  const sponsorId = randomUUID();
  const claimed = await call({ action: "claim_waiting", code: ticket.code, peerId: sponsorId });
  assert.equal(claimed.statusCode, 200);
  assert.deepEqual(claimed.payload.offer, offer);
  assert.equal(claimed.payload.peerId, ticket.peerId);
  assert.equal(claimed.payload.token, undefined);
  const stolen = await call({ action: "poll_waiting", code: ticket.code, token: "0".repeat(64) });
  assert.equal(stolen.statusCode, 401);
  const forged = await call({ action: "answer_waiting", code: ticket.code, peerId: sponsorId, claimToken: "0".repeat(64), answer });
  assert.equal(forged.statusCode, 401);
  const accepted = await call({ action: "answer_waiting", code: ticket.code, peerId: sponsorId, claimToken: claimed.payload.claimToken, answer });
  assert.equal(accepted.statusCode, 200);
  const polled = await call({ action: "poll_waiting", code: ticket.code, token: ticket.token });
  assert.deepEqual(polled.payload.answer, { peerId: sponsorId, sdp: answer });
  const removed = await call({ action: "cancel_waiting", code: ticket.code, token: ticket.token });
  assert.equal(removed.statusCode, 200);
  assert.equal((await call({ action: "poll_waiting", code: ticket.code, token: ticket.token })).statusCode, 404);
});

test("dois participantes não conseguem reivindicar o mesmo código", async () => {
  const ticket = await register();
  const responses = await Promise.all(Array.from({ length: 5 }, () =>
    call({ action: "claim_waiting", code: ticket.code, peerId: randomUUID() })));
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(responses.filter((response) => response.statusCode === 409).length, 4);
});

test("cancelamento exige credencial e uma resposta não pode recriar o código", async () => {
  const ticket = await register();
  const peerId = randomUUID();
  const claimed = await call({ action: "claim_waiting", code: ticket.code, peerId });
  assert.equal((await call({ action: "cancel_waiting", code: ticket.code, token: "0".repeat(64) })).statusCode, 401);
  await call({ action: "cancel_waiting", code: ticket.code, token: ticket.token });
  assert.equal((await call({ action: "answer_waiting", code: ticket.code, peerId, claimToken: claimed.payload.claimToken, answer })).statusCode, 404);
});

test("polling tem intervalo mínimo e o código expira sem heartbeat", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const ticket = await register();
  const query = { action: "poll_waiting", code: ticket.code, token: ticket.token };
  assert.equal((await call(query)).statusCode, 200);
  assert.equal((await call(query)).payload.code, "POLL_TOO_FAST");
  now += 6_000;
  assert.equal((await call(query)).statusCode, 200);
  now += 120_000;
  assert.equal((await call(query)).statusCode, 404);
});

test("registro limitado a dez códigos por IP por minuto", async () => {
  const ip = "register-limit";
  for (let i = 0; i < 10; i++) await register({ ip });
  const blocked = await call({ action: "register_waiting", peerId: randomUUID(), offer }, { ip });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.payload.code, "REGISTER_RATE_LIMITED");
});

test("cinco códigos incorretos bloqueiam tentativas do IP temporariamente", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const ticket = await register();
  const ip = "guess-limit";
  for (let i = 0; i < 5; i++) {
    const missing = await call({ action: "claim_waiting", code: "AAAAA", peerId: randomUUID() }, { ip });
    assert.equal(missing.statusCode, 404);
  }
  const blocked = await call({ action: "claim_waiting", code: ticket.code, peerId: randomUUID() }, { ip });
  assert.equal(blocked.payload.code, "CODE_ATTEMPTS_BLOCKED");
  now += 61_000;
  assert.equal((await call({ action: "claim_waiting", code: ticket.code, peerId: randomUUID() }, { ip })).statusCode, 200);
});

test("versão, SDP e tamanho de payload são validados antes da troca", async () => {
  const outdated = await call({ action: "register_waiting", peerId: randomUUID(), offer, clientVersion: "v1.3.3" });
  assert.equal(outdated.statusCode, 426);
  const invalid = await call({ action: "register_waiting", peerId: randomUUID(), offer: { type: "offer", sdp: "lixo" } });
  assert.equal(invalid.statusCode, 400);
  const oversized = await call({ action: "register_waiting", peerId: randomUUID(), offer: { ...offer, sdp: offer.sdp + "a".repeat(65_536) } });
  assert.equal(oversized.statusCode, 413);
  const huge = await call({ action: "register_waiting", arbitrary: "x".repeat(129 * 1024) });
  assert.equal(huge.statusCode, 413);
  const ticket = await register();
  assert.equal((await call({ action: "claim_waiting", code: ticket.code, peerId: ticket.peerId })).payload.code, "SELF_JOIN");
});

test("CORS permite desktop, Android e desenvolvimento; sites externos são bloqueados", async () => {
  for (const origin of ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420"]) {
    const response = await call({}, { method: "OPTIONS", headers: { origin } });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["Access-Control-Allow-Origin"], origin);
  }
  assert.equal((await call({}, { method: "OPTIONS", headers: { origin: "https://malicious.example" } })).statusCode, 403);
});
