import type { DeviceKind, SignalingMessage, SessionScope } from '@lilypad/protocol';
import type { Room } from './room.js';

/**
 * What a message means for a room: zero, one, or two effects for the
 * orchestrator to execute in order. Nothing here touches `Peer.send`/
 * `Peer.close` or the persistence hooks — `route()` mutates `Room`'s own
 * in-memory state (FSM, scopes, established) as it decides, since that's
 * data, not I/O, but every actual side effect to the outside world is
 * described, not performed.
 */
export type RouteAction =
  | { kind: 'relay'; to: DeviceKind; msg: SignalingMessage }
  | { kind: 'respond'; to: DeviceKind; type: SignalingMessage['type']; payload: unknown }
  | { kind: 'approve'; grantedScopes: SessionScope[] }
  | { kind: 'end'; reason: string }
  | { kind: 'reject'; to: DeviceKind; code: string; message: string };

/**
 * Pure routing decisions, extracted from `SignalingHub.dispatch`'s 16-case
 * switch. Deliberately preserves today's exact behavior, including one
 * pattern worth flagging rather than silently "fixing" in a decomposition
 * pass: every `room.tryFsm(...)` call here still discards its boolean result
 * (an illegal transition is silently ignored, not surfaced to the client) —
 * see the M3 architecture audit's Finding F2 for the proposed follow-up
 * (turning that into a visible `reject` action is a protocol-visible change
 * that deserves its own review, not a side effect of a refactor).
 */
export class MessageRouter {
  route(room: Room, from: DeviceKind, msg: SignalingMessage): RouteAction[] {
    switch (msg.type) {
      case 'register':
        // Re-register is a no-op ack; already seated.
        return [];

      case 'ping':
        return [{ kind: 'respond', to: from, type: 'pong', payload: {} }];

      case 'heartbeat':
        return []; // lastSeen already bumped by the caller

      case 'pair-request': {
        if (from !== 'mobile') {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'forbidden',
              message: 'only the mobile may send this',
            },
          ];
        }
        room.scopes = msg.payload.requestedScopes;
        room.tryFsm('waiting_approval');
        return [{ kind: 'relay', to: 'desktop', msg }];
      }

      case 'pair-approved': {
        if (from !== 'desktop') {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'forbidden',
              message: 'only the desktop may send this',
            },
          ];
        }
        if (!room.hasSeat('desktop') || !room.hasSeat('mobile')) {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'peer_missing',
              message: 'both peers must be present to approve',
            },
          ];
        }
        return [{ kind: 'approve', grantedScopes: msg.payload.grantedScopes }];
      }

      case 'pair-denied': {
        if (from !== 'desktop') {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'forbidden',
              message: 'only the desktop may send this',
            },
          ];
        }
        return [
          { kind: 'relay', to: 'mobile', msg },
          { kind: 'end', reason: 'denied by desktop' },
        ];
      }

      case 'offer': {
        if (from !== 'desktop') {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'forbidden',
              message: 'only the desktop may send this',
            },
          ];
        }
        room.tryFsm('negotiating');
        return [{ kind: 'relay', to: 'mobile', msg }];
      }

      case 'answer': {
        if (from !== 'mobile') {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'forbidden',
              message: 'only the mobile may send this',
            },
          ];
        }
        room.tryFsm('connected');
        room.markEstablished();
        return [{ kind: 'relay', to: 'desktop', msg }];
      }

      case 'ice-candidate':
        return [{ kind: 'relay', to: room.otherRole(from), msg }];

      case 'frame-size':
        // Desktop → mobile only: the capture resolution the phone needs to map
        // touches onto the letterboxed video content rect
        // (docs/audit/m3/input-touch.md Finding 1). A mobile sender has no
        // capture surface, so reject it from that side rather than reflect it.
        if (from !== 'desktop') {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'forbidden',
              message: 'only the desktop may send this',
            },
          ];
        }
        return [{ kind: 'relay', to: 'mobile', msg }];

      case 'clipboard-update':
        // Desktop → mobile only: this is the desktop-OS-clipboard-changed
        // direction (docs/audit/m3/prior-art.md Finding 6). The reverse
        // direction (phone → desktop) already travels over the DataChannel
        // as an `InputEvent`, not signaling, so a mobile sender here would
        // be using the wrong channel entirely — reject rather than relay.
        if (from !== 'desktop') {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'forbidden',
              message: 'only the desktop may send this',
            },
          ];
        }
        return [{ kind: 'relay', to: 'mobile', msg }];

      case 'set-capture-mode':
        // Mobile → desktop only: only the viewer has the mode-toggle UI, and
        // only the desktop can actually rebuild its capture pipeline
        // (docs/audit/m3/prior-art.md Finding 2).
        if (from !== 'mobile') {
          return [
            {
              kind: 'reject',
              to: from,
              code: 'forbidden',
              message: 'only the mobile may send this',
            },
          ];
        }
        return [{ kind: 'relay', to: 'desktop', msg }];

      case 'renegotiate':
        // Either peer may ask; the desktop (offerer) produces the new offer —
        // relay ALWAYS targets 'desktop' regardless of who sent it (matches
        // the original's exact behavior, including if the desktop itself
        // were to send this).
        room.tryFsm('negotiating');
        return [{ kind: 'relay', to: 'desktop', msg }];

      case 'pause':
        room.tryFsm('paused');
        return [{ kind: 'relay', to: room.otherRole(from), msg }];

      case 'resume':
        room.tryFsm('connected');
        return [{ kind: 'relay', to: room.otherRole(from), msg }];

      case 'disconnect':
        return [
          { kind: 'relay', to: room.otherRole(from), msg },
          { kind: 'end', reason: `${from} disconnected` },
        ];

      // Server-originated types (session-start, pong, error, …) must not
      // arrive from a client.
      default:
        return [
          {
            kind: 'reject',
            to: from,
            code: 'unexpected_type',
            message: `'${msg.type}' not accepted from a client`,
          },
        ];
    }
  }
}
