import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  SIGNALING_PATH,
  BACKEND_REAP_INTERVAL_MS,
  BACKEND_HEARTBEAT_TIMEOUT_MS,
  ConnectRequestSchema,
  encodeSignal,
  type ConnectResponse,
} from '@lilypad/protocol';
import type { Peer } from '../signaling/hub.js';
import {
  IpConnectionLimiter,
  TokenBucket,
  isUnexpectedBrowserOrigin,
} from '../signaling/guards.js';
import { decideRegisterGate } from '../signaling/registerAuth.js';
import type { SignalingHubBundle } from '../signaling/hubBundle.js';
import { advertisedUrls } from '../services/advertisedUrls.js';
import { log } from '../logging.js';
import { config } from '../config.js';
import { isAuthorizedMetricsRequest } from '../metricsAuth.js';

/** Abuse-guard tuning. Generous for real clients (which batch ICE/heartbeats),
 * tight enough to bound a hostile socket. */
const MAX_CONNECTIONS_PER_IP = 20;
const MSG_BURST = 60; // tokens
const MSG_REFILL_PER_SEC = 20; // sustained frames/sec per socket
const REGISTER_TIMEOUT_MS = 10_000; // close sockets that never register

/**
 * WebSocket signaling endpoint. The route is a thin adapter: it turns each
 * socket into a `Peer` and hands raw frames to the transport-agnostic
 * `SignalingHub` (which owns all routing/validation/state). Session lifecycle
 * is persisted to Redis via the hub's hooks.
 */
export async function signalingRoutes(
  app: FastifyInstance,
  bundle: SignalingHubBundle,
): Promise<void> {
  const { hub, sessions, roomAuth, trust } = bundle;

  // Resurrect any rooms a prior process was mid-session on, BEFORE accepting
  // connections — Fastify awaits a plugin's promise before the server starts
  // listening, so this can't race an incoming register. See
  // docs/audit/m3/reconnect-lifecycle.md Finding 3.
  const resurrected = await hub.resurrectRoomsFromStore();
  if (resurrected > 0) {
    log.signaling.info({ resurrected }, 'resurrected rooms from a prior process');
  }

  // Companion to resurrection above: any `SessionRecord` a prior process
  // never got to mark terminal (crash, kill -9) would otherwise read as
  // "active" for up to its full TTL (default 1h). Bound that window to one
  // boot cycle instead. See docs/audit/m3/testing-reliability.md Finding 5.
  const swept = await sessions.sweepOrphaned(BACKEND_HEARTBEAT_TIMEOUT_MS).catch((err: unknown) => {
    log.session.warn({ err }, 'orphaned-session sweep failed — degrading to no sweep this boot');
    return 0;
  });
  if (swept > 0) {
    log.session.info({ swept }, 'marked orphaned sessions from a prior process disconnected');
  }

  // Reap peers that stopped heart-beating.
  const reaper = setInterval(() => hub.reapStale(), BACKEND_REAP_INTERVAL_MS);
  app.addHook('onClose', async () => {
    clearInterval(reaper);
    // Graceful shutdown: notify live peers before the transport tears down.
    hub.shutdownAll('server shutting down');
  });

  // Operational metrics for scrapers/operators — the hub owns session state,
  // so the endpoint lives here (no cross-route hub sharing needed). Publicly
  // reachable, unauthenticated metrics hand an attacker load/timing recon
  // for free (docs/audit/m3/backend-security.md Finding 13) — gated behind
  // a static bearer token whenever one is configured (required in
  // production; `loadEnv`'s production guard enforces that it's set).
  app.get('/metrics', async (req, reply) => {
    if (!isAuthorizedMetricsRequest(req.headers.authorization, config.env.METRICS_BEARER_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return hub.metricsSnapshot();
  });

  // M5.4 no-QR reconnect: a trusted phone asks the backend to ring its
  // desktop. Lives in this route module because it needs the live hub (same
  // reason /metrics does). Rate-limited like /pairing/create — it is fully
  // unauthenticated pre-M5-keys and mints Redis state on success.
  app.post(
    '/connect/request',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = ConnectRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { desktopDeviceId, mobileDeviceId, mobileDeviceName, pairSecret } = parsed.data;

      // Authorize: trusted, not revoked, and the per-pair connect secret must
      // match (unless this is a legacy pre-secret pair). Fails closed.
      const authz = await trust.authorizeConnect(desktopDeviceId, mobileDeviceId, pairSecret);
      if (!authz.ok) {
        if (authz.reason === 'not_trusted') {
          return reply.code(404).send({
            error: 'not_trusted',
            message: 'no trust relationship — pair with a QR first',
          });
        }
        if (authz.reason === 'revoked') {
          return reply.code(403).send({
            error: 'revoked',
            message: 'this pairing was revoked — pair again with a QR',
          });
        }
        // bad_secret — deliberately reported as not_trusted so a caller
        // guessing device ids can't distinguish "wrong secret" (pair exists)
        // from "no such pair"; the honest remedy is the same: re-pair.
        return reply.code(404).send({
          error: 'not_trusted',
          message: 'this device needs to pair again — scan the QR once',
        });
      }
      const pair = authz.pair;
      if (!hub.isDesktopPresent(desktopDeviceId)) {
        return reply
          .code(503)
          .send({ error: 'desktop_offline', message: 'the desktop is not reachable right now' });
      }

      // Mint the session room exactly as a redeem would: room-auth bound to
      // BOTH devices (session TTL) BEFORE either device can try to register.
      const roomId = randomUUID();
      await roomAuth.recordDesktop(roomId, desktopDeviceId);
      await roomAuth.recordMobile(roomId, desktopDeviceId, mobileDeviceId);

      const scopes = ['view', 'control'] as const;
      const delivered = hub.notifyConnectRequest(desktopDeviceId, {
        sessionRoomId: roomId,
        mobileDeviceId,
        mobileDeviceName: mobileDeviceName ?? null,
        requestedScopes: [...scopes],
        autoApprove: pair.autoApprove,
      });
      if (!delivered) {
        // Presence dropped between the check and the send — same honest answer.
        void roomAuth.delete(roomId).catch(() => {});
        return reply
          .code(503)
          .send({ error: 'desktop_offline', message: 'the desktop is not reachable right now' });
      }

      void trust
        .touchConnected(pair.pairId)
        .catch((err) => log.signaling.warn({ err }, 'lastConnectedAt update failed'));

      // Mirrors PairingRedeemResponse so the phone's downstream session flow
      // is byte-for-byte the pairing flow.
      const response: ConnectResponse = {
        roomId,
        signalingUrl: advertisedUrls().signalingUrl,
        scopes: [...scopes],
        desktopDeviceName: pair.displayName,
      };
      return reply.code(200).send(response);
    },
  );

  // Shared across all sockets: bound concurrent connections per source IP.
  const ipLimiter = new IpConnectionLimiter(MAX_CONNECTIONS_PER_IP);

  app.get(SIGNALING_PATH, { websocket: true }, (socket, req) => {
    const ip = req.ip;
    if (isUnexpectedBrowserOrigin(req.headers.origin, req.headers.host)) {
      log.signaling.warn(
        { ip, origin: req.headers.origin },
        'WS upgrade carried a browser Origin header — rejecting',
      );
      try {
        socket.close(4403, 'unexpected origin');
      } catch {
        /* already closed */
      }
      return;
    }
    if (!ipLimiter.acquire(ip)) {
      log.signaling.warn({ ip }, 'per-IP connection cap reached — rejecting socket');
      try {
        socket.close(4429, 'too many connections');
      } catch {
        /* already closed */
      }
      return;
    }

    const rate = new TokenBucket(MSG_BURST, MSG_REFILL_PER_SEC);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      ipLimiter.release(ip);
    };

    const peer: Peer = {
      send: (msg) => {
        try {
          socket.send(encodeSignal(msg));
        } catch (err) {
          req.log.error({ err }, 'signaling send failed');
        }
      },
      close: (code, reason) => {
        try {
          socket.close(code, reason);
        } catch {
          /* already closed */
        }
      },
    };

    // A socket that connects but never registers ties up a seat/IP slot; close
    // it once the register window elapses.
    const registerTimer = setTimeout(() => {
      if (!hub.isRegistered(peer)) {
        log.signaling.warn({ ip }, 'socket did not register in time — closing');
        peer.close(4408, 'register timeout');
      }
    }, REGISTER_TIMEOUT_MS);

    // Every frame from this socket is processed strictly one at a time, in
    // arrival order, even though a `register` attempt now needs an `await`ed
    // Redis room-auth lookup before it may reach the hub. Without this, a
    // client that fires `register` immediately followed by `pair-request`
    // (both apps do exactly this, with no ack-wait in between) could have
    // its `pair-request` processed while `register`'s lookup is still
    // in-flight — the hub would see an unregistered peer and reject it with
    // `not_registered`. Chaining every message onto the same promise, rather
    // than converting `SignalingHub` itself to async, keeps the hub's
    // existing fully-synchronous, "pure and testable" design (and its
    // existing test suite) completely untouched — the async boundary lives
    // only here, at the one layer that already does connection-level I/O
    // (rate limiting, IP caps). See `docs/audit/m3/backend-security.md`
    // Finding 1.
    let queue: Promise<void> = Promise.resolve();

    async function processMessage(raw: Buffer): Promise<void> {
      if (!rate.allow()) {
        log.signaling.warn({ ip }, 'per-socket message rate exceeded — closing');
        peer.close(4429, 'message rate exceeded');
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        peer.send({
          type: 'error',
          roomId: '',
          from: 'desktop',
          ts: Date.now(),
          payload: { code: 'bad_json', message: 'frame was not valid JSON' },
        });
        return;
      }

      const decision = await decideRegisterGate(
        json,
        hub.isRegistered(peer),
        (roomId, role, deviceId) => roomAuth.verify(roomId, role, deviceId),
      );
      switch (decision.action) {
        case 'error':
          log.signaling.error({ roomId: decision.attempt.roomId }, 'room-auth lookup failed');
          peer.close(1011, 'internal error');
          return;
        case 'reject_unauthorized':
          log.signaling.warn(
            { roomId: decision.attempt.roomId, role: decision.attempt.role },
            'register rejected: room not authorized for this device',
          );
          peer.send({
            type: 'error',
            roomId: decision.attempt.roomId,
            from: decision.attempt.role,
            ts: Date.now(),
            payload: {
              code: 'unauthorized_room',
              message: 'this device is not authorized to join this room',
            },
          });
          peer.close(4403, 'unauthorized room');
          return;
        case 'proceed':
          break;
      }

      hub.handleMessage(peer, json);
    }

    socket.on('message', (raw: Buffer) => {
      // `.catch` here, not inside `processMessage`, so `queue` itself is
      // NEVER a rejected promise going into the next message's `.then` — an
      // unanticipated throw must not permanently wedge every future frame
      // on this socket behind a dead chain.
      queue = queue
        .then(() => processMessage(raw))
        .catch((err: unknown) => {
          log.signaling.error({ err }, 'unexpected error processing signaling message');
        });
    });

    socket.on('close', () => {
      clearTimeout(registerTimer);
      release();
      hub.handleClose(peer);
    });
  });
}
