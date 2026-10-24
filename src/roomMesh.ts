import type { PeerManager } from "./peerManager";
import type { DataChannelMessage, MeshControlMessage, PeerInfo } from "./types";

interface MeshCallbacks {
  onMember: (peer: PeerInfo) => void;
  onMemberLeft: (peerId: string) => void;
  onJoined: () => void;
  onHistoryRequested: (peerId: string) => void;
}

interface PendingLink {
  negotiationId: string;
  timer: number;
}

/** Room directory and SDP routing live exclusively on the DataChannels. */
export class RoomMesh {
  private readonly members = new Map<string, PeerInfo>();
  private readonly admissions = new Set<string>();
  private readonly pending = new Map<string, PendingLink>();
  private readonly retryCounts = new Map<string, number>();
  private readonly retryTimers = new Map<string, number>();
  private readonly offerLimits = new Map<string, { since: number; count: number }>();
  private sponsorId: string | null = null;
  private stopped = false;

  constructor(
    private readonly manager: PeerManager,
    private readonly getSelf: () => PeerInfo,
    private readonly callbacks: MeshCallbacks,
    private roomId: string | null,
  ) {}

  expectSponsor(peerId: string): void {
    this.sponsorId = peerId;
    this.remember({ peerId, nickname: "Peer", color: "#f2f2f2", lastSeen: Date.now() });
  }

  admit(peerId: string): void {
    if (!this.roomId || this.members.size >= 63) throw new Error("A sala atingiu o limite de participantes.");
    this.admissions.add(peerId);
    this.remember({ peerId, nickname: "Peer", color: "#f2f2f2", lastSeen: Date.now() });
  }

  forgetAdmission(peerId: string): void {
    this.admissions.delete(peerId);
    this.members.delete(peerId);
    this.manager.closePeer(peerId);
    this.callbacks.onMemberLeft(peerId);
  }

  updateIdentity(peerId: string, nickname: string, color: string): void {
    const member = this.members.get(peerId);
    if (member) {
      member.nickname = nickname.slice(0, 18);
      member.color = color.slice(0, 64);
    }
  }

  isMember(peerId: string): boolean {
    return this.members.has(peerId);
  }

  channelOpened(peerId: string): void {
    if (this.stopped) return;
    this.clearPending(peerId);
    this.retryCounts.delete(peerId);
    const timer = this.retryTimers.get(peerId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.retryTimers.delete(peerId);
    const member = this.members.get(peerId);
    if (member) this.callbacks.onMember(member);
    if (!this.admissions.delete(peerId) || !this.roomId) {
      if (member && this.roomId) this.callbacks.onHistoryRequested(peerId);
      return;
    }

    const connected = this.manager.listConnectedPeerIds()
      .filter((id) => id !== peerId && this.members.has(id));
    const members = [this.getSelf(), ...connected.map((id) => this.members.get(id)!)];
    this.manager.sendTo(peerId, { type: "room-welcome", roomId: this.roomId, members });
    for (const id of connected) {
      this.manager.sendTo(id, { type: "mesh-introduce", roomId: this.roomId, member: this.members.get(peerId)! });
    }
    this.callbacks.onHistoryRequested(peerId);
  }

  /** Returns true for control messages, including rejected/malformed controls. */
  handle(peerId: string, message: DataChannelMessage): boolean {
    if (!message.type.startsWith("mesh-") && message.type !== "room-welcome") return false;
    if (this.stopped) return true;
    void this.handleControl(peerId, message as MeshControlMessage).catch((error) => {
      console.warn("Falha na negociação da malha P2P", error);
    });
    return true;
  }

  private async handleControl(peerId: string, message: MeshControlMessage): Promise<void> {
    if (message.type === "room-welcome") {
      if (this.roomId || peerId !== this.sponsorId || !validId(message.roomId)
        || !Array.isArray(message.members) || message.members.length > 64) return;
      const members = message.members.filter(validMember);
      if (!members.some((member) => member.peerId === peerId)) return;
      this.roomId = message.roomId;
      for (const member of members) this.remember(member);
      this.callbacks.onJoined();
      for (const member of members) {
        if (member.peerId !== peerId && member.peerId !== this.getSelf().peerId) {
          void this.ensureLink(member, peerId).catch((error) => console.warn("Falha ao apresentar participante", error));
        }
      }
      return;
    }

    if (!this.roomId || message.roomId !== this.roomId || !this.members.has(peerId)) return;
    switch (message.type) {
      case "mesh-introduce":
      case "mesh-route-ready":
        if (validMember(message.member)) {
          this.remember(message.member);
          await this.ensureLink(message.member, peerId);
        }
        return;
      case "mesh-route-request": {
        if (message.targetPeerId === peerId || !this.manager.listConnectedPeerIds().includes(message.targetPeerId)) return;
        const target = this.members.get(message.targetPeerId);
        const requester = this.members.get(peerId);
        if (!target || !requester) return;
        this.manager.sendTo(message.targetPeerId, { type: "mesh-introduce", roomId: this.roomId, member: requester });
        this.manager.sendTo(peerId, { type: "mesh-route-ready", roomId: this.roomId, member: target });
        return;
      }
      case "mesh-leave":
        this.removeMember(peerId);
        return;
      case "mesh-signal":
        await this.routeSignal(peerId, message);
        return;
    }
  }

  private remember(member: PeerInfo): void {
    if (member.peerId === this.getSelf().peerId || this.members.size >= 63 && !this.members.has(member.peerId)) return;
    // A placeholder from another peer must not overwrite identity already received directly.
    const current = this.members.get(member.peerId);
    if (!current) {
      this.members.set(member.peerId, { ...member });
      this.callbacks.onMember(member);
    }
  }

  private async ensureLink(member: PeerInfo, relayId: string): Promise<void> {
    const selfId = this.getSelf().peerId;
    if (this.stopped || !this.roomId || member.peerId === selfId || member.peerId === relayId
      || this.manager.hasConnection(member.peerId) || selfId < member.peerId) return;
    const negotiationId = crypto.randomUUID();
    this.trackPending(member.peerId, negotiationId);
    try {
      const sdp = await this.manager.createOffer(member.peerId);
      if (this.stopped || !this.pending.has(member.peerId)) return;
      if (!this.manager.sendTo(relayId, {
        type: "mesh-signal", roomId: this.roomId, fromPeerId: selfId,
        toPeerId: member.peerId, negotiationId, sdp,
      })) this.manager.closePeer(member.peerId);
    } catch (error) {
      this.clearPending(member.peerId);
      throw error;
    }
  }

  private async routeSignal(relayId: string, message: Extract<MeshControlMessage, { type: "mesh-signal" }>): Promise<void> {
    if (!validId(message.fromPeerId) || !validId(message.toPeerId) || !validId(message.negotiationId)
      || !message.sdp || !["offer", "answer"].includes(message.sdp.type)
      || typeof message.sdp.sdp !== "string" || new TextEncoder().encode(message.sdp.sdp).length > 64 * 1024) return;
    if (message.toPeerId !== this.getSelf().peerId) {
      // A relay may only forward the authenticated transport sender's SDP.
      if (message.fromPeerId !== relayId || !this.members.has(message.toPeerId)) return;
      this.manager.sendTo(message.toPeerId, message);
      return;
    }
    if (!this.members.has(message.fromPeerId)) return;
    if (message.sdp.type === "answer") {
      if (this.pending.get(message.fromPeerId)?.negotiationId !== message.negotiationId) return;
      await this.manager.acceptAnswer(message.fromPeerId, message.sdp);
      return;
    }
    if (message.fromPeerId < this.getSelf().peerId || this.manager.hasConnection(message.fromPeerId)) return;
    const limit = this.offerLimits.get(message.fromPeerId);
    const next = limit && Date.now() - limit.since < 60_000 ? limit : { since: Date.now(), count: 0 };
    if (++next.count > 20) return;
    this.offerLimits.set(message.fromPeerId, next);
    this.trackPending(message.fromPeerId, message.negotiationId);
    const sdp = await this.manager.acceptOffer(message.fromPeerId, message.sdp);
    if (!this.stopped && this.roomId) this.manager.sendTo(relayId, {
      type: "mesh-signal", roomId: this.roomId, fromPeerId: this.getSelf().peerId,
      toPeerId: message.fromPeerId, negotiationId: message.negotiationId, sdp,
    });
  }

  private trackPending(peerId: string, negotiationId: string): void {
    this.clearPending(peerId);
    const timer = window.setTimeout(() => {
      this.pending.delete(peerId);
      this.manager.closePeer(peerId);
    }, 20_000);
    this.pending.set(peerId, { negotiationId, timer });
  }

  private clearPending(peerId: string): void {
    const link = this.pending.get(peerId);
    if (link) window.clearTimeout(link.timer);
    this.pending.delete(peerId);
  }

  peerClosed(peerId: string): void {
    if (this.stopped || !this.members.has(peerId)) return;
    this.clearPending(peerId);
    const neverJoined = this.admissions.delete(peerId);
    this.callbacks.onMemberLeft(peerId);
    if (neverJoined) {
      this.members.delete(peerId);
      return;
    }
    if (!this.roomId) return;
    const attempt = (this.retryCounts.get(peerId) ?? 0) + 1;
    this.retryCounts.set(peerId, attempt);
    if (attempt > 3) {
      this.members.delete(peerId);
      this.retryCounts.delete(peerId);
      return;
    }
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(peerId);
      if (this.stopped || !this.roomId || this.manager.hasConnection(peerId)) return;
      for (const id of this.manager.listConnectedPeerIds()) {
        this.manager.sendTo(id, { type: "mesh-route-request", roomId: this.roomId, targetPeerId: peerId });
      }
      // A relay may no longer know this peer. Finish recovery instead of keeping
      // a dead member forever when no route is available.
      this.retryTimers.set(peerId, window.setTimeout(() => {
        this.retryTimers.delete(peerId);
        if (!this.stopped && !this.manager.hasConnection(peerId)) this.peerClosed(peerId);
      }, 8_000));
    }, attempt * 2_000);
    this.retryTimers.set(peerId, timer);
  }

  private removeMember(peerId: string): void {
    this.members.delete(peerId);
    this.clearPending(peerId);
    const timer = this.retryTimers.get(peerId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.retryTimers.delete(peerId);
    this.manager.closePeer(peerId);
    this.callbacks.onMemberLeft(peerId);
  }

  leave(): void {
    if (this.roomId) this.manager.broadcast({ type: "mesh-leave", roomId: this.roomId });
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    for (const link of this.pending.values()) window.clearTimeout(link.timer);
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.pending.clear();
    this.retryTimers.clear();
    this.members.clear();
    this.admissions.clear();
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

function validMember(value: unknown): value is PeerInfo {
  if (!value || typeof value !== "object") return false;
  const member = value as PeerInfo;
  return validId(member.peerId) && typeof member.nickname === "string" && member.nickname.length <= 18
    && typeof member.color === "string" && member.color.length <= 64;
}
