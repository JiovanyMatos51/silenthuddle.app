import { CLIENT_VERSION, SIGNALING_API_BASE } from "./config.ts";
 
export interface WaitingTicket {
  code: string;
  token: string;
  expiresAt: number;
}

export interface ClaimedOffer {
  peerId: string;
  offer: RTCSessionDescriptionInit;
  claimToken: string;
}

export interface WaitingMatch {
  answer: { peerId: string; sdp: RTCSessionDescriptionInit } | null;
}

export class SignalingError extends Error {
  constructor(message: string, readonly code = "SIGNALING_ERROR", readonly status = 0) {
    super(message);
    this.name = "SignalingError";
  }
}

/** Regra estável também usada para resolver colisões na renegociação. */
export function isInitiator(localPeerId: string, remotePeerId: string): boolean {
  return localPeerId > remotePeerId;
}

/**
 * Rendezvous de uso único. Não registra salas, presença ou estado da chamada.
 * O único polling é solicitado pela UI do código temporário.
 */
export class RendezvousClient {
  constructor(private readonly apiBase: string | (() => string) = SIGNALING_API_BASE) {}

  private async call<T>(action: string, params: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(typeof this.apiBase === "function" ? this.apiBase() : this.apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, clientVersion: CLIENT_VERSION, ...params }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new SignalingError(
          body.error || `Falha no encontro inicial: HTTP ${response.status}`,
          body.code,
          response.status,
        );
      }
      return body as T;
    } catch (error) {
      if (error instanceof SignalingError) throw error;
      throw new SignalingError("Não foi possível acessar o servidor de sinalização.", "NETWORK_ERROR");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  register(peerId: string, offer: RTCSessionDescriptionInit): Promise<WaitingTicket> {
    return this.call("register_waiting", { peerId, offer });
  }

  claim(code: string, peerId: string): Promise<ClaimedOffer> {
    return this.call("claim_waiting", { code, peerId });
  }

  answer(code: string, peerId: string, claimToken: string, answer: RTCSessionDescriptionInit): Promise<void> {
    return this.call("answer_waiting", { code, peerId, claimToken, answer });
  }

  poll(ticket: WaitingTicket): Promise<WaitingMatch> {
    return this.call("poll_waiting", { code: ticket.code, token: ticket.token });
  }

  cancel(ticket: WaitingTicket): Promise<void> {
    return this.call("cancel_waiting", { code: ticket.code, token: ticket.token });
  }
}
