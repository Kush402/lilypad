import { SignalingHub } from './hub.js';
import { SessionManager } from '../session/manager.js';
import { RoomStore } from '../session/roomStore.js';
import { buildIceServers } from '../turn/credentials.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import { RoomAuthStore } from '../services/roomAuth.js';
import { TrustService, createDrizzleTrustStore } from '../services/trust.js';
import { redis } from '../redis.js';
import { log } from '../logging.js';
import { config } from '../config.js';

export interface SignalingHubBundle {
  hub: SignalingHub;
  sessions: SessionManager;
  roomStore: RoomStore;
  auditLog: AuditLogService;
  roomAuth: RoomAuthStore;
  trust: TrustService;
}

/** Builds the SignalingHub and every service its hooks close over, as ONE
 * bundle — constructed exactly once (in server.ts) and shared between
 * `signalingRoutes` (which owns the WS route + hub lifecycle: resurrection,
 * reaping, shutdown) and `deviceRoutes` (which needs `hub` alone, to force-end
 * a live room when a desktop revokes a trusted device — see
 * `SignalingHub.endRoomsForDevicePair`). Splitting hub construction out of
 * `signalingRoutes` without this bundle would either duplicate room state
 * across two hub instances (wrong — silent divergence) or leave `deviceRoutes`
 * with no way to reach live rooms at all. */
export function createSignalingHubBundle(): SignalingHubBundle {
  const sessions = new SessionManager(redis);
  const roomStore = new RoomStore(redis);
  const auditLog = new AuditLogService(createDrizzleAuditLogStore());
  const roomAuth = new RoomAuthStore(redis);
  const trust = new TrustService(createDrizzleTrustStore());

  const hub = new SignalingHub({
    buildIceServers: (label) => buildIceServers({ label }).iceServers,
    // FORCE_RELAY defaults false (normal ICE): flip it only once a dedicated
    // TURN relay is deployed — see infra/coturn-prod/README.md.
    iceTransportPolicy: config.env.FORCE_RELAY ? 'relay' : 'all',
    roomStore,
    onSessionStart: (info) => {
      void sessions
        .create({
          id: info.sessionId,
          roomId: info.roomId,
          desktopDeviceId: info.desktopDeviceId,
          mobileDeviceId: info.mobileDeviceId,
          scopes: info.scopes,
          initialState: 'connecting',
        })
        .catch((err) => log.session.error({ err }, 'failed to persist session'));
      // Repudiation mitigation (docs/threat-model.md). Fire-and-forget, same
      // as the persistence call above: an audit-log blip must never block
      // or fail ICE issuance.
      void auditLog
        .sessionStart({
          metadata: {
            sessionId: info.sessionId,
            roomId: info.roomId,
            desktopDeviceId: info.desktopDeviceId,
            mobileDeviceId: info.mobileDeviceId,
            scopes: info.scopes,
          },
        })
        .catch((err) => log.audit.error({ err }, 'failed to write session_start audit log'));
    },
    onSessionEnd: (sessionId, reason) => {
      void sessions
        .end(sessionId, reason)
        .catch((err) => log.session.error({ err }, 'failed to end session'));
      void auditLog
        .sessionEnd({ metadata: { sessionId, reason } })
        .catch((err) => log.audit.error({ err }, 'failed to write session_end audit log'));
    },
    onStateChange: (roomId, sessionId, from, to) =>
      log.session.info({ roomId, sessionId, from, to }, 'session state'),
    onRoomClosed: (roomId) => {
      // A dead room's auth record must not outlive it (zombie-room guard —
      // see RoomAuthStore.delete). Fire-and-forget like every other hook.
      void roomAuth
        .delete(roomId)
        .catch((err) => log.signaling.warn({ err, roomId }, 'room-auth record delete failed'));
    },
    onTrustEstablished: (info) => {
      // "Trust this device" rode on the approval — record the persistent pair
      // and hand the phone its per-pair connect secret over the (authenticated,
      // wss-in-prod) mobile seat. Fire-and-forget: a Postgres blip must never
      // fail the approval itself (the user can re-trust on the next pairing).
      void trust
        .establishTrust(info.desktopDeviceId, info.mobileDeviceId)
        .then(({ pairSecret }) => {
          hub.deliverPairSecret(info.roomId, pairSecret);
          return auditLog.devicePaired({
            metadata: {
              desktopDeviceId: info.desktopDeviceId,
              mobileDeviceId: info.mobileDeviceId,
              trusted: true,
            },
          });
        })
        .catch((err) => log.signaling.error({ err }, 'failed to record device trust'));
    },
    onPairDenied: (info) => {
      void auditLog
        .pairDenied({
          metadata: {
            roomId: info.roomId,
            desktopDeviceId: info.desktopDeviceId,
            mobileDeviceId: info.mobileDeviceId,
            reason: info.reason,
          },
        })
        .catch((err) => log.audit.error({ err }, 'failed to write pair_denied audit log'));
    },
  });

  return { hub, sessions, roomStore, auditLog, roomAuth, trust };
}
