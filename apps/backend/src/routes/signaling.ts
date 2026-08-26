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
import { optionalAuth, optionalActorOf } from '../auth/requireAuth.js';
import { rejectRevokedActor } from '../auth/liveDevice.js';
import { actAsDevice } from '../auth/authorize.js';
import { deviceOwnershipByFingerprint } from '../auth/ownership.js';
import { bearerToken, verifyAccessToken, type Actor } from '../auth/tokens.js';
import type { SignalingHubBundle } from '../signaling/hubBundle.js';
import { advertisedUrls } from '../services/advertisedUrls.js';
import { allowedProofHosts } from '../auth/proofOrigin.js';
import { log } from '../logging.js';
import { config } from '../config.js';
import { isAuthorizedMetricsRequest } from '../metricsAuth.js';
import { serverMetrics } from '../serverMetrics.js';

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
    // The signaling counters answer "are sessions happening"; the server
    // counters answer "is the API working". A scraper that can only see the
    // first cannot tell a healthy idle server from one returning 500 to
    // everything.
    //
    // `deviceProofHosts` is not a counter, and is here on purpose. A v2 device
    // proof names the host it is for and this server refuses any other
    // (`proofOrigin.ts`), so a deployment whose advertised address does not
    // match what clients actually use would reject every updated client with
    // an opaque `invalid_signature`. Publishing the effective set turns
    // "deploy the server first, then the clients" from a hope into a check:
    // curl this after deploying, confirm the host the apps use is listed, and
    // only then cut the client builds. Token-gated like everything else here.
    return {
      ...hub.metricsSnapshot(),
      ...serverMetrics.snapshot(),
      deviceProofHosts: [
        ...allowedProofHosts({
          publicBaseUrl: config.env.PUBLIC_BASE_URL,
          advertisedApiBaseUrl: advertisedUrls().apiBaseUrl,
          extraHosts: config.env.DEVICE_PROOF_HOSTS,
        }),
      ],
    };
  });

  // M5.4 no-QR reconnect: a trusted phone asks the backend to ring its
  // desktop. Lives in this route module because it needs the live hub (same
  // reason /metrics does). Rate-limited like /pairing/create — it is fully
  // unauthenticated pre-M5-keys and mints Redis state on success.
  app.post(
    '/connect/request',
    {
      preHandler: [optionalAuth, rejectRevokedActor],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = ConnectRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { desktopDeviceId, mobileDeviceId, mobileDeviceName, pairSecret } = parsed.data;

      // The caller must BE the phone it names (M9, ADR-0010). Ringing someone
      // else's laptop is the single highest-value thing an attacker could do
      // here, and until now the only thing between them and it was knowing two
      // device ids and a secret. Same 404 as an unknown pair: a caller that
      // could tell "not your phone" from "no such pair" could enumerate.
      const mobile = await deviceOwnershipByFingerprint('mobile', mobileDeviceId);
      const notTrusted = () =>
        reply.code(404).send({
          error: 'not_trusted',
          message: 'no trust relationship — pair with a QR first',
        });
      if (!actAsDevice(optionalActorOf(req), mobile).allow) return notTrusted();

      // Authorize: trusted, not revoked, and the per-pair connect secret must
      // match (unless this is a legacy pre-secret pair). Fails closed.
      const authz = await trust.authorizeConnect(desktopDeviceId, mobileDeviceId, pairSecret);
      if (!authz.ok) {
        if (authz.reason === 'not_trusted') {
          return notTrusted();
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

      // A laptop removed from its account is not reachable, whatever its pairs
      // still say. Device revocation withdraws OWNERSHIP; the `trusted_devices`
      // rows survive as audit trail, so `authorizeConnect` passes one and the
      // ring would otherwise fall through to the presence check and answer 503
      // `desktop_offline`. Measured against production. It grants no access —
      // a revoked device cannot hold a device token, so it can never occupy a
      // presence room — but "offline" is the wrong sentence for a Mac that is
      // sitting there switched on.
      //
      // **Checked AFTER authorization, which is what lets it say so.** It used
      // to run before, and answer the same anonymous 404 as an unknown pair, so
      // that a caller guessing device ids could not learn which ones exist.
      // Past `authorizeConnect` there is nothing left to learn: this caller has
      // proved it is the phone it names AND presented the per-pair secret for
      // this exact laptop, which is only issued to a phone that completed the
      // pairing ceremony with it.
      //
      // The code names the FACT rather than either cause: a Mac signs itself
      // out (`account_sign_out`, ADR-0015) or an owner removes it from "Your
      // devices" on their phone, and the row that results is identical. Naming
      // one of the two would be wrong half the time.
      //
      // The distinction became worth drawing when signing out of a Mac started
      // releasing it. "Pair again with a QR" is
      // now advice that leads in a circle: `/pairing/create` refuses a computer
      // no account owns, so the phone would send its owner to redo a ceremony
      // that cannot succeed until the thing it is not mentioning gets done.
      const desktop = await deviceOwnershipByFingerprint('desktop', desktopDeviceId);
      if (desktop?.state === 'revoked') {
        return reply.code(403).send({
          error: 'desktop_not_on_account',
          message:
            'that computer is not on your account — sign in to Lilypad on it to bring it back',
        });
      }

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

    // Who this socket is, resolved once here rather than per frame, and only
    // after the cheap transport guards above have had their say — a socket
    // being rejected for its origin or the per-IP cap must not first cost a
    // signature verification.
    //
    // The token rides the `Authorization` header on the upgrade request: a
    // WebSocket carries no per-message headers, and a bearer token inside a
    // routed signaling payload would spread through logs and relay paths.
    // Never rejects — an unauthenticated socket is exactly what an unlinked
    // device has, and only the claims it goes on to make decide whether that
    // is enough.
    const socketActor: Promise<Actor | null> = (async () => {
      const token = bearerToken(req.headers.authorization);
      return token ? verifyAccessToken(token) : null;
    })();

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
        async (deviceId) => {
          const desktop = await deviceOwnershipByFingerprint('desktop', deviceId);
          return actAsDevice(await socketActor, desktop).allow;
        },
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
