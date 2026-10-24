/* ============================================================================
 * types.ts — Tipos compartilhados entre signaling / peerManager / mediaService
 * / main
 * ========================================================================== */

export interface PeerInfo {
  peerId: string;
  nickname: string;
  color: string;
  lastSeen: number;
}

export interface RoomSession {
  /** Identificador aleatório criado localmente, nunca registrado no backend. */
  roomId: string;
  peerId: string;
  nickname: string;
  avatarColor: string;
}

export type TrackKind = "camera" | "screen";
export type RemoteTrackKind = TrackKind | "audio" | "screen-audio";
export type ChatMessageKind = "normal" | "warn" | "private" | "system";

export interface ChatReplyReference {
  peerId: string;
  nickname: string;
}

export interface PublicHistoryEntry {
  message: ChatMessage & { kind: "normal" | "warn"; createdAt: number };
  reactions: HistoryReaction[];
}

export interface HistoryReaction {
  peerId: string;
  emoji: string;
  active: boolean;
  revision: number;
}

export type MeshControlMessage =
  | { type: "room-welcome"; roomId: string; members: PeerInfo[] }
  | { type: "mesh-introduce"; roomId: string; member: PeerInfo }
  | { type: "mesh-signal"; roomId: string; fromPeerId: string; toPeerId: string; negotiationId: string; sdp: RTCSessionDescriptionInit }
  | { type: "mesh-leave"; roomId: string }
  | { type: "mesh-route-request"; roomId: string; targetPeerId: string }
  | { type: "mesh-route-ready"; roomId: string; member: PeerInfo };

/* ----------------------------------------------------------------------------
 * Mensagens trocadas via RTCDataChannel (canal "data")
 * -------------------------------------------------------------------------- */

export type DataChannelMessage =
  | MeshControlMessage
  | { type: "history-batch"; entries: PublicHistoryEntry[] }
  | { type: "presence"; nickname: string; color: string; inCall: boolean; micOn: boolean; audioOn: boolean; cameraOn: boolean; screenSharing: boolean }
  | { type: "chat"; messageId: string; text: string; time: string; createdAt?: number; kind: Exclude<ChatMessageKind, "system">; replyTo?: ChatReplyReference }
  | { type: "reaction"; messageId: string; emoji: string; active: boolean; revision: number }
  | { type: "call-start" }
  | { type: "call-join" }
  | { type: "call-leave" }
  | { type: "video-request" }
  | { type: "video-stop" }
  | { type: "screen-request" }
  | { type: "screen-stop" }
  | { type: "screen-quality"; fullscreen: boolean }
  | { type: "track-info"; trackId: string; streamId: string; kind: RemoteTrackKind }
  | { type: "track-removed"; kind: RemoteTrackKind }
  | { type: "speaking"; speaking: boolean }
  | { type: "file-offer"; fileId: string; name: string; size: number; mime: string; requiresAcceptance: boolean }
  | { type: "file-response"; fileId: string; accepted: boolean }
  | { type: "file-chunk"; fileId: string; index: number; total: number; data: string }
  | { type: "file-end"; fileId: string }
  /* renegociação SDP feita diretamente pelo DataChannel após o handshake inicial */
  | { type: "renegotiate-offer"; sdp: RTCSessionDescriptionInit }
  | { type: "renegotiate-answer"; sdp: RTCSessionDescriptionInit };

/* ----------------------------------------------------------------------------
 * Estado de um participante remoto, do ponto de vista da UI
 * -------------------------------------------------------------------------- */

export interface Participant {
  id: string;
  nickname: string;
  avatarColor?: string;
  inCall: boolean;
  micOn: boolean;
  audioOn: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  speaking?: boolean;
  pingMs?: number;
}

export interface ChatMessage {
  id: string;
  authorId: string;
  author: string;
  text: string;
  time: string;
  createdAt?: number;
  avatarColor?: string;
  kind?: ChatMessageKind;
  replyTo?: ChatReplyReference;
  highlighted?: boolean;
  notice?: string;
  actions?: boolean;
}

export interface ReceivedFile {
  peerId: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

export interface IncomingFileOffer extends ReceivedFile {
  requiresAcceptance: boolean;
}

/** File-backed sources (native clipboard or DOM File) are read one chunk at a time. */
export interface OutgoingFileSource {
  name: string;
  type: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
