import assert from "node:assert/strict";
import test from "node:test";
import { RoomMesh } from "../src/roomMesh.ts";
import { snapshotPublicHistory, historyBatches, validHistoryEntry } from "../src/chatHistory.ts";
import type { PeerManager } from "../src/peerManager.ts";
import type { DataChannelMessage, PeerInfo, ChatMessage } from "../src/types.ts";

// The protocol's transport is deliberately independent of fetch/HTTP.
globalThis.window = globalThis as unknown as Window & typeof globalThis;
const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const ROOM = "f0000000-0000-4000-8000-000000000000";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class Network {
  peers = new Map<string, Endpoint>();
  deliveries: { from: string; to: string; message: DataChannelMessage }[] = [];
  connect(a: string, b: string) {
    this.peers.get(a)!.manager.connections.set(b, true);
    this.peers.get(b)!.manager.connections.set(a, true);
    this.peers.get(a)!.mesh.channelOpened(b);
    this.peers.get(b)!.mesh.channelOpened(a);
  }
  disconnect(a: string, b: string) {
    for (const [from, to] of [[a, b], [b, a]]) {
      this.peers.get(from)!.manager.connections.delete(to);
      this.peers.get(from)!.mesh.peerClosed(to);
    }
  }
}

class FakeManager {
  connections = new Map<string, boolean>();
  offers: string[] = [];
  answers: string[] = [];
  constructor(readonly id: string, readonly network: Network) {}
  hasConnection(id: string) { return this.connections.has(id); }
  listConnectedPeerIds() { return Array.from(this.connections).filter(([, open]) => open).map(([id]) => id); }
  async createOffer(id: string) {
    this.offers.push(id);
    this.connections.set(id, false);
    return { type: "offer" as const, sdp: "offer" };
  }
  async acceptOffer(id: string) {
    this.connections.set(id, false);
    return { type: "answer" as const, sdp: "answer" };
  }
  async acceptAnswer(id: string) {
    this.answers.push(id);
    this.network.connect(this.id, id);
  }
  sendTo(to: string, message: DataChannelMessage) {
    if (!this.connections.get(to)) return false;
    this.network.deliveries.push({ from: this.id, to, message });
    queueMicrotask(() => this.network.peers.get(to)!.mesh.handle(this.id, message));
    return true;
  }
  broadcast(message: DataChannelMessage) { for (const id of this.listConnectedPeerIds()) this.sendTo(id, message); }
  closePeer(id: string) { this.connections.delete(id); }
}

class Endpoint {
  manager: FakeManager;
  mesh: RoomMesh;
  members = new Set<string>();
  histories: string[] = [];
  joined = false;
  constructor(id: string, network: Network, roomId: string | null) {
    this.manager = new FakeManager(id, network);
    const self: PeerInfo = { peerId: id, nickname: id.slice(0, 1), color: "blue", lastSeen: 0 };
    this.mesh = new RoomMesh(this.manager as unknown as PeerManager, () => self, {
      onMember: (peer) => this.members.add(peer.peerId),
      onMemberLeft: (peerId) => this.members.delete(peerId),
      onJoined: () => { this.joined = true; },
      onHistoryRequested: (peerId) => this.histories.push(peerId),
    }, roomId);
    network.peers.set(id, this);
  }
}

test("terceiro peer forma malha por intermediário, sem usar backend", async () => {
  const n = new Network();
  const a = new Endpoint(A, n, ROOM), b = new Endpoint(B, n, null), c = new Endpoint(C, n, null);
  try {
    a.mesh.admit(B); b.mesh.expectSponsor(A); n.connect(A, B); await flush();
    assert.equal(b.joined, true);
    b.mesh.admit(C); c.mesh.expectSponsor(B); n.connect(B, C); await flush();
    assert.equal(c.joined, true);
    assert.deepEqual(c.manager.listConnectedPeerIds().sort(), [A, B]);
    assert.deepEqual(a.manager.listConnectedPeerIds().sort(), [B, C]);
    assert.ok(n.deliveries.some(({ from, to, message }) => from === C && to === B && message.type === "mesh-signal"));
    assert.deepEqual(b.histories, [C]);

    a.mesh.leave(); await flush(); n.disconnect(A, B); n.disconnect(A, C);
    assert.equal(b.members.has(A), false);
    assert.equal(c.members.has(A), false);
    assert.equal(b.manager.listConnectedPeerIds().includes(C), true);

    // A participant other than the creator can keep adding friends.
    const d = new Endpoint(D, n, null);
    c.mesh.admit(D); d.mesh.expectSponsor(C); n.connect(C, D); await flush();
    assert.deepEqual(d.manager.listConnectedPeerIds().sort(), [B, C]);
    assert.equal(d.members.has(A), false);
  } finally { for (const peer of n.peers.values()) peer.mesh.stop(); }
});

test("introduções repetidas e respostas antigas não duplicam conexões", async () => {
  const n = new Network();
  const a = new Endpoint(A, n, ROOM), b = new Endpoint(B, n, null), c = new Endpoint(C, n, null);
  try {
    a.mesh.admit(B); b.mesh.expectSponsor(A); n.connect(A, B); await flush();
    b.mesh.admit(C); c.mesh.expectSponsor(B); n.connect(B, C); await flush();
    const member = { peerId: A, nickname: "A", color: "red", lastSeen: 0 };
    b.manager.sendTo(C, { type: "mesh-introduce", roomId: ROOM, member });
    b.manager.sendTo(C, { type: "mesh-introduce", roomId: ROOM, member });
    b.manager.sendTo(C, { type: "mesh-signal", roomId: ROOM, fromPeerId: A, toPeerId: C,
      negotiationId: crypto.randomUUID(), sdp: { type: "answer", sdp: "stale" } });
    await flush();
    assert.deepEqual(c.manager.offers, [A]);
    assert.deepEqual(c.manager.answers, [A]);
    const before = n.deliveries.length;
    // B cannot forward a message claiming to have originated at another peer.
    c.manager.sendTo(B, { type: "mesh-signal", roomId: ROOM, fromPeerId: A, toPeerId: C,
      negotiationId: crypto.randomUUID(), sdp: { type: "offer", sdp: "forged" } });
    await flush();
    assert.equal(n.deliveries.length, before + 1);
  } finally { for (const peer of n.peers.values()) peer.mesh.stop(); }
});

test("perda de um link usa outro participante para reconectar", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const n = new Network();
  const a = new Endpoint(A, n, ROOM), b = new Endpoint(B, n, null), c = new Endpoint(C, n, null);
  try {
    a.mesh.admit(B); b.mesh.expectSponsor(A); n.connect(A, B); await flush();
    b.mesh.admit(C); c.mesh.expectSponsor(B); n.connect(B, C); await flush();
    n.disconnect(A, C);
    t.mock.timers.tick(2_001); await flush();
    assert.equal(c.manager.listConnectedPeerIds().includes(A), true);
    assert.ok(n.deliveries.some(({ message }) => message.type === "mesh-route-request"));
  } finally { for (const peer of n.peers.values()) peer.mesh.stop(); }
});

test("histórico exporta somente mensagens públicas e preserva respostas e reações", () => {
  const base: ChatMessage = { id: "message", authorId: A, author: "Alice", text: "Oi", time: "12:00", createdAt: 1 };
  const views = [
    { message: { ...base, kind: "normal" as const, replyTo: { peerId: B, nickname: "Bob" } }, reactions: new Map([["👍", new Set([B])]]) },
    { message: { ...base, id: "warn", kind: "warn" as const }, reactions: new Map() },
    { message: { ...base, id: "secret", text: "Segredo", kind: "private" as const }, reactions: new Map() },
    { message: { ...base, id: "local", text: "/help", kind: "system" as const }, reactions: new Map() },
  ];
  const entries = snapshotPublicHistory(views);
  assert.deepEqual(entries.map(({ message }) => message.id), ["message", "warn"]);
  assert.equal(entries[0].message.replyTo?.peerId, B);
  assert.deepEqual(entries[0].reactions, [{ emoji: "👍", peerId: B, active: true, revision: 1 }]);
  assert.equal(validHistoryEntry(entries[0]), true);
  assert.equal(validHistoryEntry({ ...entries[0], message: { ...entries[0].message, kind: "private" } }), false);
  const removed = snapshotPublicHistory([{
    ...views[0],
    reactionEvents: new Map([[`${B}:👍`, { peerId: B, emoji: "👍", active: false, revision: 2 }]]),
  }]);
  assert.deepEqual(removed[0].reactions, [{ peerId: B, emoji: "👍", active: false, revision: 2 }]);
  const many = Array.from({ length: 320 }, (_, i) => ({ ...entries[0], message: { ...entries[0].message, id: String(i), text: "😀".repeat(2_000) } }));
  const batches = Array.from(historyBatches(many));
  assert.equal(batches.flat().length, many.length);
  assert.ok(batches.every((batch) => batch.length <= 100 && new TextEncoder().encode(JSON.stringify(batch)).length < 64 * 1024));
  const crowded = { ...entries[0], message: { ...entries[0].message, text: "😀".repeat(4_000) },
    reactions: Array.from({ length: 1_000 }, (_, revision) => ({ peerId: B, emoji: "👍", active: false, revision: revision + 1 })) };
  const fragments = Array.from(historyBatches([crowded])).flat();
  assert.equal(fragments.flatMap((fragment) => fragment.reactions).length, 1_000);
  assert.ok(fragments.every((fragment) => validHistoryEntry(fragment)));
  assert.ok(fragments.every((fragment) => fragment.message.text === crowded.message.text));
});
