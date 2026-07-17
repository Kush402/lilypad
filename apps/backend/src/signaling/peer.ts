import type { SignalingMessage } from '@lilypad/protocol';

/**
 * A signaling peer, decoupled from the transport (real WebSocket in prod, a
 * fake object in tests). The hub only needs to send it messages and close it.
 */
export interface Peer {
  send(msg: SignalingMessage): void;
  close(code: number, reason: string): void;
}
