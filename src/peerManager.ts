/* ============================================================================
 * peerManager.ts — Módulo B: Gerenciador de Conexões Peer-to-Peer (mesh)
 *
 * Cada peer remoto tem uma RTCPeerConnection própria + um RTCDataChannel
 * "data" usado tanto para mensagens estruturadas (chat, presença, arquivos,
 * click-to-view) quanto para renegociação SDP após o handshake inicial
 * (padrão "perfect negotiation", com o peer "educado" definido pela mesma
 * regra de desempate lexicográfico usada no handshake — ver signaling.ts).
 * ========================================================================== */

import { ICE_SERVERS, FILE_CHUNK_SIZE, FILE_CONFIRMATION_THRESHOLD, HANDSHAKE_TIMEOUT_MS } from "./config";
import { isInitiator } from "./signaling";
import { screenQualityParameters } from "./screenQuality";
import type {
  DataChannelMessage,
  RemoteTrackKind,
  ReceivedFile,
  IncomingFileOffer,
  OutgoingFileSource,
} from "./types";

interface IncomingFileBuffer {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  accepted: boolean;
  receivedBytes: number;
  writeChain: Promise<void>;
}

interface OutgoingFileBuffer {
  fileId: string;
  file: OutgoingFileSource;
}

interface PendingRemoteTrack {
  stream: MediaStream;
  track: MediaStreamTrack;
  fallbackTimer: number;
}

interface PeerConnectionEntry {
  peerId: string;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  initiator: boolean;
  /** peer "educado": cede em caso de colisão de ofertas (perfect negotiation) */
  polite: boolean;
  makingOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  negotiationChain: Promise<void>;

  cameraSender: RTCRtpSender | null;
  screenSender: RTCRtpSender | null;
  screenFullscreen: boolean;
  screenQualityChain: Promise<void>;
  screenQualityQueued: boolean;
  screenAudioSender: RTCRtpSender | null;
  micSender: RTCRtpSender | null;

  /** o peer remoto pediu para receber nossa câmera (click-to-view) */
  remoteWantsMyCamera: boolean;

  /** trackId -> tipo, preenchido via mensagem "track-info" antes do ontrack */
  pendingTrackKinds: Map<string, RemoteTrackKind>;
  /** streamId -> tipo; fallback para plataformas que reescrevem o trackId */
  pendingStreamKinds: Map<string, RemoteTrackKind>;
  unclassifiedVideoTracks: Map<string, PendingRemoteTrack>;

  incomingFiles: Map<string, IncomingFileBuffer>;
  outgoingFiles: Map<string, OutgoingFileBuffer>;
}

export interface PeerManagerCallbacks {
  /** nova track remota pronta para uso (anexar a <video>/<audio>) */
  onRemoteTrack?: (peerId: string, kind: RemoteTrackKind, stream: MediaStream, track: MediaStreamTrack) => void;
  /** track remota removida (peer parou câmera/tela ou saiu) */
  onRemoteTrackEnded?: (peerId: string, kind: RemoteTrackKind) => void;
  /** mensagens de aplicação (chat, presença, video-request, etc.) */
  onMessage?: (peerId: string, message: DataChannelMessage) => void;
  onFileOffered?: (offer: IncomingFileOffer) => void;
  onFileChunk?: (peerId: string, fileId: string, base64Data: string) => Promise<void>;
  onFileReceived?: (file: ReceivedFile) => void;
  onFileProgress?: (peerId: string, fileId: string, receivedBytes: number, totalBytes: number) => void;
  onFileTransferError?: (peerId: string, fileId: string, error: unknown) => void;
  onFileSendError?: (peerId: string, name: string, error: unknown) => void;
  onPeerConnectionStateChange?: (peerId: string, state: RTCPeerConnectionState) => void;
  /** o peer remoto pediu para ver nossa câmera — o chamador decide se atende */
  onVideoRequested?: (peerId: string) => void;
  onVideoStopRequested?: (peerId: string) => void;
  onScreenRequested?: (peerId: string) => void;
  onScreenStopRequested?: (peerId: string) => void;
  /** DataChannel com o peer acabou de abrir — bom momento para enviar
   *  presença atual e sincronizar mídia ativa (mic/tela) */
  onChannelOpen?: (peerId: string) => void;
}

export class PeerManager {
  private readonly localPeerId: string;
  private readonly connections = new Map<string, PeerConnectionEntry>();
  private callbacks: PeerManagerCallbacks = {};

  constructor(localPeerId: string) {
    this.localPeerId = localPeerId;
  }

  setCallbacks(callbacks: PeerManagerCallbacks): void {
    this.callbacks = callbacks;
  }

  hasConnection(peerId: string): boolean {
    return this.connections.has(peerId);
  }

  listConnectedPeerIds(): string[] {
    return Array.from(this.connections.values())
      .filter((entry) => entry.dataChannel?.readyState === "open")
      .map((entry) => entry.peerId);
  }

  /* ==========================================================================
   * Handshake inicial (SDP completo, transporte escolhido pelo chamador)
   * ======================================================================== */

  private createConnection(peerId: string, initiator: boolean): PeerConnectionEntry {
    if (this.connections.has(peerId)) throw new Error("Já existe uma conexão com este participante.");
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const entry: PeerConnectionEntry = {
      peerId,
      pc,
      dataChannel: null,
      initiator,
      polite: !isInitiator(this.localPeerId, peerId),
      makingOffer: false,
      isSettingRemoteAnswerPending: false,
      negotiationChain: Promise.resolve(),
      cameraSender: null,
      screenSender: null,
      screenFullscreen: false,
      screenQualityChain: Promise.resolve(),
      screenQualityQueued: false,
      screenAudioSender: null,
      micSender: null,
      remoteWantsMyCamera: false,
      pendingTrackKinds: new Map(),
      pendingStreamKinds: new Map(),
      unclassifiedVideoTracks: new Map(),
      incomingFiles: new Map(),
      outgoingFiles: new Map(),
    };
    this.connections.set(peerId, entry);

    this.bindConnectionEvents(entry);

    if (initiator) {
      const channel = pc.createDataChannel("data");
      this.bindDataChannel(entry, channel);
    } else {
      pc.ondatachannel = (event) => this.bindDataChannel(entry, event.channel);
    }

    return entry;
  }

  /** SDP completo. Quem chama escolhe se o transporte é HTTP ou outro peer. */
  async createOffer(peerId: string): Promise<RTCSessionDescriptionInit> {
    const entry = this.createConnection(peerId, true);
    const { pc } = entry;
    entry.makingOffer = true;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await this.waitIceGatheringComplete(pc);
      return { type: "offer", sdp: pc.localDescription!.sdp };
    } catch (error) {
      this.closePeer(peerId);
      throw error;
    } finally {
      entry.makingOffer = false;
    }
  }

  async acceptOffer(peerId: string, sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const entry = this.createConnection(peerId, false);
    try {
      await entry.pc.setRemoteDescription(sdp);
      await entry.pc.setLocalDescription(await entry.pc.createAnswer());
      await this.waitIceGatheringComplete(entry.pc);
      this.armHandshakeTimeout(entry);
      return { type: "answer", sdp: entry.pc.localDescription!.sdp };
    } catch (error) {
      this.closePeer(peerId);
      throw error;
    }
  }

  async acceptAnswer(peerId: string, sdp: RTCSessionDescriptionInit, pendingId = peerId): Promise<void> {
    const entry = this.connections.get(pendingId);
    if (!entry || entry.pc.signalingState !== "have-local-offer") throw new Error("Oferta expirada.");
    if (pendingId !== peerId) {
      if (this.connections.has(peerId)) throw new Error("Participante já conectado.");
      this.connections.delete(pendingId);
      entry.peerId = peerId;
      entry.polite = !isInitiator(this.localPeerId, peerId);
      this.connections.set(peerId, entry);
    }
    await entry.pc.setRemoteDescription(sdp);
    this.armHandshakeTimeout(entry);
  }

  private armHandshakeTimeout(entry: PeerConnectionEntry): void {
    window.setTimeout(() => {
      if (this.connections.get(entry.peerId) === entry && entry.dataChannel?.readyState !== "open") {
        this.closePeer(entry.peerId);
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /** Sem trickle ICE disponível no backend: aguardamos a coleta terminar para
   *  garantir que o SDP publicado já contenha todos os candidatos. */
  private waitIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      // salvaguarda: não trava para sempre se algum candidato nunca fechar
      setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }, 4000);
    });
  }

  /* ==========================================================================
   * Eventos da RTCPeerConnection
   * ======================================================================== */

  private bindConnectionEvents(entry: PeerConnectionEntry): void {
    const { pc } = entry;

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable") this.applyScreenQuality(entry);
    };

    pc.onconnectionstatechange = () => {
      if (this.connections.get(entry.peerId) !== entry) return;
      this.callbacks.onPeerConnectionStateChange?.(entry.peerId, pc.connectionState);
      if (pc.connectionState === "failed") {
        // Remove a entrada para que o próximo ciclo de descoberta faça um
        // handshake completo (restartIce sem nova oferta não resolve sozinho).
        this.closePeer(entry.peerId);
      }
      if (pc.connectionState === "disconnected") {
        window.setTimeout(() => {
          if (this.connections.get(entry.peerId) === entry && pc.connectionState === "disconnected") {
            this.closePeer(entry.peerId);
          }
        }, 5000);
      }
    };

    pc.ontrack = (event) => {
      if (this.connections.get(entry.peerId) !== entry) return;
      const track = event.track;
      const stream = event.streams[0] ?? new MediaStream([track]);
      const knownKind = entry.pendingTrackKinds.get(track.id) ?? entry.pendingStreamKinds.get(stream.id);

      if (track.kind === "audio") {
        const kind = knownKind === "screen-audio" ? "screen-audio" : "audio";
        entry.pendingTrackKinds.delete(track.id);
        entry.pendingStreamKinds.delete(stream.id);
        this.deliverRemoteTrack(entry, stream, track, kind);
        return;
      }

      if (knownKind === "camera" || knownKind === "screen") {
        entry.pendingTrackKinds.delete(track.id);
        entry.pendingStreamKinds.delete(stream.id);
        this.deliverRemoteTrack(entry, stream, track, knownKind);
      } else {
        // Em renegociações rápidas o ontrack pode chegar antes da mensagem que
        // diferencia câmera de tela. Aguardamos a identificação explicitamente
        // e só usamos câmera como fallback se ela realmente não chegar.
        const fallbackTimer = window.setTimeout(() => {
          if (!entry.unclassifiedVideoTracks.delete(track.id)) return;
          this.deliverRemoteTrack(entry, stream, track, "camera");
        }, 1500);
        entry.unclassifiedVideoTracks.set(track.id, { stream, track, fallbackTimer });
      }
    };

    // handler de renegociação automática (ex.: quando addTrack/removeTrack é
    // chamado depois que a conexão já está de pé)
    pc.onnegotiationneeded = async () => {
      if (!entry.dataChannel || entry.dataChannel.readyState !== "open") return; // handshake inicial ainda cuida disso
      this.enqueueNegotiation(entry, async () => {
        if (pc.signalingState !== "stable" || pc.connectionState === "closed") return;
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription(await pc.createOffer());
          this.sendRaw(entry, { type: "renegotiate-offer", sdp: pc.localDescription! });
        } finally {
          entry.makingOffer = false;
        }
      });
    };
  }

  private deliverRemoteTrack(
    entry: PeerConnectionEntry,
    stream: MediaStream,
    track: MediaStreamTrack,
    kind: RemoteTrackKind,
  ): void {
    this.callbacks.onRemoteTrack?.(entry.peerId, kind, stream, track);
    track.addEventListener("ended", () => {
      if (this.connections.get(entry.peerId) === entry) this.callbacks.onRemoteTrackEnded?.(entry.peerId, kind);
    }, { once: true });
  }

  private enqueueNegotiation(entry: PeerConnectionEntry, task: () => Promise<void>): void {
    entry.negotiationChain = entry.negotiationChain.then(task, task).catch((error) => {
      console.error(`[peerManager] falha na renegociação com ${entry.peerId}`, error);
    });
  }

  /* ==========================================================================
   * DataChannel — mensagens de aplicação e renegociação
   * ======================================================================== */

  private bindDataChannel(entry: PeerConnectionEntry, channel: RTCDataChannel): void {
    entry.dataChannel = channel;

    channel.onopen = () => {
      this.callbacks.onChannelOpen?.(entry.peerId);
    };

    channel.onmessage = (event) => {
      let message: DataChannelMessage;
      try {
        message = JSON.parse(event.data);
        if (!message || typeof message !== "object" || typeof message.type !== "string") return;
      } catch {
        return;
      }
      if (message.type === "renegotiate-offer" || message.type === "renegotiate-answer") {
        this.enqueueNegotiation(entry, () => this.handleIncomingMessage(entry, message));
      } else {
        void this.handleIncomingMessage(entry, message).catch((error) => {
          console.error(`[peerManager] mensagem inválida de ${entry.peerId}`, error);
        });
      }
    };

    channel.onclose = () => {
      entry.dataChannel = null;
      if (this.connections.get(entry.peerId) === entry && entry.pc.connectionState !== "closed") {
        this.closePeer(entry.peerId);
      }
    };
  }

  private async handleIncomingMessage(entry: PeerConnectionEntry, message: DataChannelMessage): Promise<void> {
    switch (message.type) {
      case "renegotiate-offer":
        await this.handleRenegotiateOffer(entry, message.sdp);
        return;

      case "renegotiate-answer":
        entry.isSettingRemoteAnswerPending = true;
        try {
          if (entry.pc.signalingState === "have-local-offer") {
            await entry.pc.setRemoteDescription(message.sdp);
          }
        } finally {
          entry.isSettingRemoteAnswerPending = false;
        }
        return;

      case "track-info": {
        entry.pendingTrackKinds.set(message.trackId, message.kind);
        entry.pendingStreamKinds.set(message.streamId, message.kind);
        const pendingEntry = entry.unclassifiedVideoTracks.has(message.trackId)
          ? [message.trackId, entry.unclassifiedVideoTracks.get(message.trackId)!] as const
          : Array.from(entry.unclassifiedVideoTracks.entries()).find(([, value]) => value.stream.id === message.streamId);
        const pendingTrack = pendingEntry?.[1];
        if (pendingTrack) {
          window.clearTimeout(pendingTrack.fallbackTimer);
          entry.unclassifiedVideoTracks.delete(pendingEntry![0]);
          entry.pendingTrackKinds.delete(message.trackId);
          entry.pendingStreamKinds.delete(message.streamId);
          this.deliverRemoteTrack(entry, pendingTrack.stream, pendingTrack.track, message.kind);
        }
        return;
      }

      case "track-removed":
        this.callbacks.onRemoteTrackEnded?.(entry.peerId, message.kind);
        return;

      case "video-request":
        entry.remoteWantsMyCamera = true;
        this.callbacks.onVideoRequested?.(entry.peerId);
        return;

      case "video-stop":
        entry.remoteWantsMyCamera = false;
        this.callbacks.onVideoStopRequested?.(entry.peerId);
        return;

      case "screen-request":
        this.callbacks.onScreenRequested?.(entry.peerId);
        return;

      case "screen-stop":
        this.callbacks.onScreenStopRequested?.(entry.peerId);
        return;

      case "screen-quality":
        if (typeof message.fullscreen !== "boolean" || entry.screenFullscreen === message.fullscreen) return;
        entry.screenFullscreen = message.fullscreen;
        this.applyScreenQuality(entry);
        return;

      case "file-offer":
        entry.incomingFiles.set(message.fileId, {
          fileId: message.fileId,
          name: message.name,
          mime: message.mime,
          size: message.size,
          accepted: false,
          receivedBytes: 0,
          writeChain: Promise.resolve(),
        });
        this.callbacks.onFileOffered?.({
          peerId: entry.peerId,
          fileId: message.fileId,
          name: message.name,
          mime: message.mime,
          size: message.size,
          requiresAcceptance: message.requiresAcceptance,
        });
        return;

      case "file-response": {
        const outgoing = entry.outgoingFiles.get(message.fileId);
        if (!outgoing) return;
        if (!message.accepted) {
          entry.outgoingFiles.delete(message.fileId);
          return;
        }
        void this.streamFile(entry, outgoing)
          .catch((error) => this.callbacks.onFileSendError?.(entry.peerId, outgoing.file.name, error))
          .finally(() => entry.outgoingFiles.delete(message.fileId));
        return;
      }

      case "file-chunk": {
        const buffer = entry.incomingFiles.get(message.fileId);
        if (!buffer?.accepted) return;
        const chunkBytes = Math.min(FILE_CHUNK_SIZE, Math.max(0, buffer.size - buffer.receivedBytes));
        buffer.receivedBytes += chunkBytes;
        buffer.writeChain = buffer.writeChain.then(async () => {
          await this.callbacks.onFileChunk?.(entry.peerId, message.fileId, message.data);
        });
        this.callbacks.onFileProgress?.(entry.peerId, message.fileId, buffer.receivedBytes, buffer.size);
        return;
      }

      case "file-end": {
        const buffer = entry.incomingFiles.get(message.fileId);
        if (!buffer) return;
        try {
          await buffer.writeChain;
          this.callbacks.onFileReceived?.({
            peerId: entry.peerId,
            fileId: buffer.fileId,
            name: buffer.name,
            mime: buffer.mime,
            size: buffer.size,
          });
        } catch (error) {
          this.callbacks.onFileTransferError?.(entry.peerId, message.fileId, error);
        } finally {
          entry.incomingFiles.delete(message.fileId);
        }
        return;
      }

      default:
        // chat, presence, call-start, call-join, call-leave, speaking...
        this.callbacks.onMessage?.(entry.peerId, message);
    }
  }

  /** Perfect negotiation: resolve colisão de ofertas usando o papel
   *  "educado"/"não-educado" definido no handshake inicial. */
  private async handleRenegotiateOffer(entry: PeerConnectionEntry, sdp: RTCSessionDescriptionInit): Promise<void> {
    const { pc } = entry;
    const readyForOffer = !entry.makingOffer && (pc.signalingState === "stable" || entry.isSettingRemoteAnswerPending);
    const offerCollision = !readyForOffer;
    const ignoreOffer = !entry.polite && offerCollision;
    if (ignoreOffer) return;

    if (offerCollision && pc.signalingState !== "stable") await pc.setLocalDescription({ type: "rollback" });
    await pc.setRemoteDescription(sdp);

    await pc.setLocalDescription(await pc.createAnswer());
    this.sendRaw(entry, { type: "renegotiate-answer", sdp: pc.localDescription! });
  }

  private sendRaw(entry: PeerConnectionEntry, message: DataChannelMessage): boolean {
    if (entry.dataChannel?.readyState !== "open") return false;
    try {
      entry.dataChannel.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Histórico pode conter muitas mensagens: respeita o buffer do canal. */
  async sendBuffered(peerId: string, message: DataChannelMessage): Promise<boolean> {
    const entry = this.connections.get(peerId);
    if (!entry) return false;
    const startedAt = Date.now();
    while (entry.dataChannel?.readyState === "open" && entry.dataChannel.bufferedAmount > 64 * 1024) {
      if (Date.now() - startedAt > HANDSHAKE_TIMEOUT_MS) return false;
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    }
    return this.sendRaw(entry, message);
  }

  /** Envia uma mensagem de aplicação para um peer específico. */
  sendTo(peerId: string, message: DataChannelMessage): boolean {
    const entry = this.connections.get(peerId);
    if (!entry) return false;
    return this.sendRaw(entry, message);
  }

  /** Envia uma mensagem de aplicação para todos os peers conectados. */
  broadcast(message: DataChannelMessage): void {
    for (const entry of this.connections.values()) this.sendRaw(entry, message);
  }

  /* ==========================================================================
   * Controle de mídia por conexão (câmera, mic, tela) — usado por mediaService
   * ======================================================================== */

  private sendTrackInfo(entry: PeerConnectionEntry, track: MediaStreamTrack, stream: MediaStream, kind: RemoteTrackKind): void {
    this.sendRaw(entry, { type: "track-info", trackId: track.id, streamId: stream.id, kind });
  }

  async attachMicToPeer(peerId: string, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    const entry = this.connections.get(peerId);
    if (!entry || entry.micSender) return;
    this.sendTrackInfo(entry, track, stream, "audio");
    entry.micSender = entry.pc.addTrack(track, stream);
  }

  async attachMicToAll(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    for (const [peerId] of this.connections) await this.attachMicToPeer(peerId, track, stream);
  }

  /** Troca o device do microfone em todas as conexões via replaceTrack —
   *  não dispara renegociação, então é instantâneo. */
  replaceMicTrackForAll(track: MediaStreamTrack): void {
    for (const entry of this.connections.values()) {
      void entry.micSender?.replaceTrack(track);
    }
  }

  /** Troca o device da câmera em todas as conexões que já a recebem. */
  replaceCameraTrackForAll(track: MediaStreamTrack): void {
    for (const entry of this.connections.values()) {
      void entry.cameraSender?.replaceTrack(track);
    }
  }

  removeMicFromAll(): void {
    for (const peerId of this.connections.keys()) this.removeMicFromPeer(peerId);
  }

  removeMicFromPeer(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry?.micSender) return;
    entry.pc.removeTrack(entry.micSender);
    entry.micSender = null;
    this.sendRaw(entry, { type: "track-removed", kind: "audio" });
  }

  /** Anexa a câmera local apenas a um peer específico (usado no fluxo
   *  click-to-view, quando esse peer pediu para nos ver). */
  async attachCameraToPeer(peerId: string, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    const entry = this.connections.get(peerId);
    if (!entry || entry.cameraSender) return;
    this.sendTrackInfo(entry, track, stream, "camera");
    entry.cameraSender = entry.pc.addTrack(track, stream);
  }

  /** Anexa a câmera a todos os peers que já haviam solicitado antes de a
   *  câmera ser ligada (útil quando o usuário liga a câmera depois). */
  async attachCameraToPendingRequesters(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    for (const [peerId, entry] of this.connections) {
      if (entry.remoteWantsMyCamera && !entry.cameraSender) {
        await this.attachCameraToPeer(peerId, track, stream);
      }
    }
  }

  removeCameraFromPeer(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry?.cameraSender) return;
    entry.pc.removeTrack(entry.cameraSender);
    entry.cameraSender = null;
    this.sendRaw(entry, { type: "track-removed", kind: "camera" });
  }

  removeCameraFromAll(): void {
    for (const peerId of this.connections.keys()) this.removeCameraFromPeer(peerId);
  }

  removeScreenFromPeer(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    entry.screenFullscreen = false;
    if (entry.screenSender) {
      entry.pc.removeTrack(entry.screenSender);
      entry.screenSender = null;
      this.sendRaw(entry, { type: "track-removed", kind: "screen" });
    }
    if (entry.screenAudioSender) {
      entry.pc.removeTrack(entry.screenAudioSender);
      entry.screenAudioSender = null;
      this.sendRaw(entry, { type: "track-removed", kind: "screen-audio" });
    }
  }

  removeCallMediaFromPeer(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (entry) entry.remoteWantsMyCamera = false;
    this.removeMicFromPeer(peerId);
    this.removeCameraFromPeer(peerId);
    this.removeScreenFromPeer(peerId);
  }

  /** Tela é sempre transmitida (broadcast) para todos os peers conectados
   *  enquanto o compartilhamento estiver ativo — diferente da câmera, que é
   *  sob demanda (click-to-view). */
  async broadcastScreenTrack(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    for (const [peerId] of this.connections) await this.attachScreenToPeer(peerId, track, stream);
  }

  async attachScreenToPeer(peerId: string, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    const entry = this.connections.get(peerId);
    if (!entry || entry.screenSender) return;
    this.sendTrackInfo(entry, track, stream, "screen");
    entry.screenSender = entry.pc.addTrack(track, stream);
    this.applyScreenQuality(entry);

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack && !entry.screenAudioSender) {
      // Use um MediaStream separado para que a identificação por streamId não
      // confunda vídeo e áudio da apresentação em plataformas que reescrevem
      // os IDs das tracks durante a negociação.
      const audioStream = new MediaStream([audioTrack]);
      this.sendTrackInfo(entry, audioTrack, audioStream, "screen-audio");
      entry.screenAudioSender = entry.pc.addTrack(audioTrack, audioStream);
    }
  }

  private applyScreenQuality(entry: PeerConnectionEntry): void {
    if (entry.screenQualityQueued) return;
    entry.screenQualityQueued = true;
    entry.screenQualityChain = entry.screenQualityChain.then(async () => {
      entry.screenQualityQueued = false;
      if (this.connections.get(entry.peerId) !== entry || entry.pc.signalingState !== "stable") return;
      const sender = entry.screenSender;
      if (!sender) return;
      const parameters = screenQualityParameters(sender.getParameters(), entry.screenFullscreen);
      if (!parameters) return;
      try {
        await sender.setParameters(parameters);
      } catch {
        const compatible = screenQualityParameters(sender.getParameters(), entry.screenFullscreen);
        if (!compatible) return;
        delete compatible.degradationPreference;
        await sender.setParameters(compatible);
      }
    }).catch(() => {
      // Older WebViews may not implement degradationPreference. Keep the stream
      // running instead of stopping/restarting capture or requesting permission.
    });
  }

  stopBroadcastingScreen(): void {
    for (const peerId of this.connections.keys()) this.removeScreenFromPeer(peerId);
  }

  /** Chamado quando um NOVO peer entra na mesma call enquanto já estamos com
   *  mídia ativa, garantindo que ele receba mic, câmera e tela imediatamente. */
  async syncActiveMediaToPeer(
    peerId: string,
    media: {
      micTrack?: MediaStreamTrack | null;
      micStream?: MediaStream | null;
      cameraTrack?: MediaStreamTrack | null;
      cameraStream?: MediaStream | null;
      screenTrack?: MediaStreamTrack | null;
      screenStream?: MediaStream | null;
    },
  ): Promise<void> {
    if (media.micTrack && media.micStream) await this.attachMicToPeer(peerId, media.micTrack, media.micStream);
    if (media.cameraTrack && media.cameraStream) {
      await this.attachCameraToPeer(peerId, media.cameraTrack, media.cameraStream);
    }
    if (media.screenTrack && media.screenStream) {
      await this.attachScreenToPeer(peerId, media.screenTrack, media.screenStream);
    }
  }

  /** RTT atual de cada conexão, aproveitando as verificações ICE do próprio
   * WebRTC. Não envia pacotes extras pelo DataChannel. */
  async measureRoundTripTimes(): Promise<Map<string, number | null>> {
    const measurements = new Map<string, number | null>();
    await Promise.all(Array.from(this.connections.values()).map(async (entry) => {
      try {
        const report = await entry.pc.getStats();
        let selectedPairId: string | undefined;
        report.forEach((stat) => {
          if (stat.type === "transport" && typeof stat.selectedCandidatePairId === "string") {
            selectedPairId = stat.selectedCandidatePairId;
          }
        });

        let roundTripTime: number | null = null;
        report.forEach((stat) => {
          if (stat.type !== "candidate-pair") return;
          const selected = selectedPairId ? stat.id === selectedPairId : stat.nominated && stat.state === "succeeded";
          if (selected && typeof stat.currentRoundTripTime === "number") {
            roundTripTime = stat.currentRoundTripTime;
          }
        });
        measurements.set(entry.peerId, roundTripTime === null ? null : Math.max(0, Math.round(roundTripTime * 1000)));
      } catch {
        measurements.set(entry.peerId, null);
      }
    }));
    return measurements;
  }

  /* ==========================================================================
   * Transferência de arquivos (chunking sobre DataChannel)
   * ======================================================================== */

  sendFileTo(peerId: string, file: File): void {
    const entry = this.connections.get(peerId);
    if (!entry?.dataChannel || entry.dataChannel.readyState !== "open") return;
    this.offerFile(entry, file);
  }

  broadcastFile(file: OutgoingFileSource, fileId = crypto.randomUUID()): void {
    for (const entry of this.connections.values()) this.offerFile(entry, file, fileId);
  }

  private offerFile(entry: PeerConnectionEntry, file: OutgoingFileSource, fileId = crypto.randomUUID()): void {
    if (entry.dataChannel?.readyState !== "open") return;
    entry.outgoingFiles.set(fileId, { fileId, file });
    this.sendRaw(entry, {
      type: "file-offer",
      fileId,
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      requiresAcceptance: file.size > FILE_CONFIRMATION_THRESHOLD,
    });
  }

  respondToFileOffer(peerId: string, fileId: string, accepted: boolean): void {
    const entry = this.connections.get(peerId);
    const incoming = entry?.incomingFiles.get(fileId);
    if (!entry || !incoming) return;
    incoming.accepted = accepted;
    if (!accepted) entry.incomingFiles.delete(fileId);
    this.sendRaw(entry, { type: "file-response", fileId, accepted });
  }

  private async streamFile(entry: PeerConnectionEntry, outgoing: OutgoingFileBuffer): Promise<void> {
    const channel = entry.dataChannel;
    if (!channel || channel.readyState !== "open") return;

    const { fileId, file } = outgoing;
    const total = Math.ceil(file.size / FILE_CHUNK_SIZE);

    for (let index = 0; index < total; index++) {
      const slice = file.slice(index * FILE_CHUNK_SIZE, (index + 1) * FILE_CHUNK_SIZE);
      const data = bytesToBase64(new Uint8Array(await slice.arrayBuffer()));

      // controle simples de backpressure para não estourar o buffer do canal
      while (channel.bufferedAmount > 4 * FILE_CHUNK_SIZE) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      if (channel.readyState !== "open") return;
      this.sendRaw(entry, { type: "file-chunk", fileId, index, total, data });
    }

    this.sendRaw(entry, { type: "file-end", fileId });
  }

  /* ==========================================================================
   * Ciclo de vida
   * ======================================================================== */

  closePeer(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    this.connections.delete(peerId);
    for (const pending of entry.unclassifiedVideoTracks.values()) window.clearTimeout(pending.fallbackTimer);
    entry.unclassifiedVideoTracks.clear();
    entry.pendingTrackKinds.clear();
    entry.pendingStreamKinds.clear();
    entry.incomingFiles.clear();
    entry.outgoingFiles.clear();
    entry.dataChannel?.close();
    // As tracks locais são compartilhadas entre várias conexões. Parar uma
    // track aqui derrubava o microfone/câmera para todos quando apenas um peer
    // saía; o MediaService é o único responsável por encerrá-las.
    entry.pc.close();
    this.callbacks.onPeerConnectionStateChange?.(peerId, "closed");
  }

  closeAll(): void {
    for (const peerId of Array.from(this.connections.keys())) this.closePeer(peerId);
  }
}

/* -- utilitários de codificação para o file transfer ------------------------ */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
