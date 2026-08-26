import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  DevicePairsQuerySchema as ListQuerySchema,
  PairIdParamsSchema as PairParamsSchema,
  PairAutoApprovePatchSchema as PatchBodySchema,
  UnpairRequestSchema,
  DeviceIdParamsSchema,
  DeviceRenameSchema,
} from '@lilypad/protocol';
import { TrustService, createDrizzleTrustStore } from '../services/trust.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import {
  optionalAuth,
  optionalActorOf,
  requireDevice,
  actorOf,
  deviceActorOf,
} from '../auth/requireAuth.js';
import { actAsDevice, manageDevice, managePair } from '../auth/authorize.js';
import { rejectRevokedActor } from '../auth/liveDevice.js';
import {
  deviceOwnershipByFingerprint,
  deviceOwnershipById,
  pairOwnership,
} from '../auth/ownership.js';
import {
  AccountDeviceService,
  createDrizzleAccountDeviceStore,
} from '../services/accountDevices.js';
import { RefreshTokenService, createDrizzleRefreshTokenStore } from '../auth/refreshTokens.js';
import type { SignalingHub } from '../signaling/hub.js';
import { log } from '../logging.js';

/**
 * Trusted-pair management (M5.4) — consumed by the desktop's dashboard
 * (Trusted Devices pane) and by the phone's Forget.
 *
 * Every route here is ownership-gated (M9,
 * [ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)). Before it,
 * these took the caller's word: `?desktopDeviceId=` listed any laptop's phones
 * and a pair uuid revoked any pair and killed its live session. Knowing an
 * identifier is no longer sufficient for anything an account owns.
 *
 * `optionalAuth`, not `requireAuth`: a device no account owns has no owner to
 * prove and keeps the behaviour it shipped with — see `auth/authorize.ts`.
 */
export async function deviceRoutes(
  app: FastifyInstance,
  deps: { hub: SignalingHub },
): Promise<void> {
  const { hub } = deps;
  const trust = new TrustService(createDrizzleTrustStore());
  const auditLog = new AuditLogService(createDrizzleAuditLogStore());
  const accountDevices = new AccountDeviceService(createDrizzleAccountDeviceStore());
  const refreshTokens = new RefreshTokenService(createDrizzleRefreshTokenStore());

  /** One answer for "not yours" and "never existed" alike — a caller that can
   * tell them apart can enumerate other accounts' devices. */
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

  // ── Account devices (P2) ──────────────────────────────────────────────────
  // A DIFFERENT list from the pairs below, answering a different question:
  // these are the machines the account owns, not which phone may reach which
  // laptop. Revoking here withdraws ownership, so the device loses every
  // pairing at once and can no longer authenticate at all.
  //
  // `requireDevice`, not `optionalAuth`: there is no unowned lane here, because
  // the resource IS an account's device list. Without an account there is
  // nothing to list.

  /** Every device on the caller's account. */
  app.get('/devices', { preHandler: [requireDevice, rejectRevokedActor] }, async (req, reply) => {
    const actor = deviceActorOf(req);
    const list = await accountDevices.list(actor.userId, actor.deviceId, (kind, fingerprint) =>
      hub.hasLiveSession(kind, fingerprint),
    );
    return reply.code(200).send({ devices: list });
  });

  /** Rename a device. A label for a human; nothing authorizes on it. */
  app.patch(
    '/devices/:deviceId',
    {
      preHandler: [requireDevice, rejectRevokedActor],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const params = DeviceIdParamsSchema.safeParse(req.params);
      const body = DeviceRenameSchema.safeParse(req.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const device = await deviceOwnershipById(params.data.deviceId);
      if (!manageDevice(actorOf(req), device).allow) return notFound(reply);
      await accountDevices.rename(params.data.deviceId, body.data.name);
      return reply.code(200).send({ ok: true });
    },
  );

  /**
   * Revoke a device — "I lost my laptop" / "sign this phone out".
   *
   * Three things have to happen, and for a while only the first two did.
   *
   * 1. `revoked_at` is set, so the device's key stops authenticating.
   * 2. Its live rooms end immediately, including its presence room. Without
   *    that, a ten-minute access token would keep a stolen machine
   *    controllable for ten more minutes, which is exactly the window
   *    revocation exists to close.
   * 3. **Every refresh token on the account is revoked.** This is the one that
   *    was missing, and without it revocation did not survive contact with the
   *    threat it exists for. A stolen Mac holds an account refresh token in its
   *    keychain; a stolen phone holds one wherever its client put it. Revoking
   *    the device left that credential untouched, and an account session is
   *    enough to call `POST /devices/enroll` — which resolves to
   *    `DeviceRegistry.claim()`, and `claim()` writes `revoked_at: null`. The
   *    revoked device could therefore re-enrol its own unchanged keypair and
   *    hand itself a working device token again. Verified against production
   *    before the fix: revoke returned 200, `/devices/token` correctly returned
   *    403 `device_revoked`, and then re-enrolment returned 200 and
   *    `/devices/token` returned 200 — fully restored, by the machine that had
   *    just been revoked.
   *
   * Revoking the whole account's sessions rather than only this device's is
   * deliberate: `refresh_tokens` has no device column to scope by, and it
   * could not have one — a client signs in before it enrols, so at issue time
   * there is no device to bind to. Signing out everywhere is also the safe
   * direction and the ordinary meaning of "I lost my laptop". It costs the
   * user's other machines nothing today, because nothing in either client ever
   * presents a refresh token: the desktop reads its stored session only to
   * render who is signed in, and the phone keeps no refresh token at all.
   */
  app.delete(
    '/devices/:deviceId',
    {
      preHandler: [requireDevice, rejectRevokedActor],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const params = DeviceIdParamsSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
      const device = await deviceOwnershipById(params.data.deviceId);
      if (!manageDevice(actorOf(req), device).allow) return notFound(reply);

      const userId = deviceActorOf(req).userId;
      const revoked = await accountDevices.revoke(params.data.deviceId);
      if (revoked) {
        // `device_removed`, NOT `revoked`. The two are different facts and the
        // phone acts on them differently: `revoked` means THIS PAIRING is over,
        // and the phone drops its local row and the connect secret with it —
        // correct for `DELETE /devices/pairs/:pairId`, and wrong here. Removing
        // a DEVICE leaves every `trusted_devices` row standing, and re-enrolling
        // the same key restores reach without another QR (`claim` clears
        // `revoked_at`). A phone that had thrown the secret away could not take
        // that path: the secret is never re-issued, so it would have to re-pair
        // to recover from something that was reversible.
        //
        // That went from a theoretical waste to a broken promise when signing
        // out of a Mac started routing through this very handler
        // (`account_sign_out`, ADR-0015) — the product now tells people, on the
        // sign-out confirmation and on the website, that their pairings survive.
        const ended = hub.endRoomsForDevice(revoked.fingerprint, 'device_removed');
        if (ended > 0) {
          log.signaling.info(
            { deviceId: params.data.deviceId, ended },
            'device revoke ended live rooms',
          );
        }
        // Awaited, not fire-and-forget: a revoke that answers 200 while the
        // credential that undoes it is still live would be worse than one that
        // fails outright, because the user would believe it worked.
        await refreshTokens.revokeUser(userId);
      }
      void auditLog
        .sessionsRevoked({
          userId,
          metadata: { event: 'device_revoked', deviceId: params.data.deviceId },
        })
        .catch((err) => log.audit.error({ err }, 'failed to write device_revoked audit log'));
      return reply.code(200).send({ ok: true });
    },
  );

  /**
   * Every pair THIS PHONE holds — the authoritative answer to "which laptops
   * can I still ring", for the phone's own list.
   *
   * Registered before `GET /devices/pairs` so the literal path is matched
   * ahead of it rather than swallowed by the query-string route.
   *
   * `requireDevice`, not `optionalAuth`: the resource is defined BY the caller
   * — "my pairs" is meaningless without knowing which device is asking, and a
   * device id in a query string would let anyone enumerate any phone's
   * laptops. The actor's `deviceId` is the `devices.id` uuid, so nothing here
   * is self-asserted.
   *
   * A desktop actor calling this gets an empty list rather than an error: no
   * pair names a desktop on its mobile side, so the honest answer is "none".
   *
   * Revoked pairs are INCLUDED. The phone stores its laptops in its keychain
   * and, before this route existed, checked them against nothing — a laptop
   * revoked from the other side kept appearing until the user tapped it and
   * the connect failed. Telling the phone a pair is revoked is what lets it
   * drop the row.
   */
  app.get(
    '/devices/pairs/mine',
    {
      preHandler: [requireDevice, rejectRevokedActor],
      // Deliberately the server-wide 120/minute rather than the 30 its
      // siblings in this file use, and stated so the choice is visible. Those
      // are mutations, where 30 is generous; this is a read the phone runs
      // every time the laptop list comes into focus, and a user moving
      // between screens would trip 30 without doing anything unusual.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const actor = deviceActorOf(req);
      const pairs = await trust.listForMobile(actor.deviceId);
      return reply.code(200).send({ pairs });
    },
  );

  /** Every pair for a desktop, for its Trusted Devices list. */
  app.get(
    '/devices/pairs',
    { preHandler: [optionalAuth, rejectRevokedActor] },
    async (req, reply) => {
      const parsed = ListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const desktop = await deviceOwnershipByFingerprint('desktop', parsed.data.desktopDeviceId);
      if (!manageDevice(optionalActorOf(req), desktop).allow) return notFound(reply);
      const pairs = await trust.listForDesktop(parsed.data.desktopDeviceId);
      return reply.code(200).send({ pairs });
    },
  );

  /** Flip a pair's "connect without approval" (Always allow) setting. */
  app.patch(
    '/devices/pairs/:pairId',
    {
      preHandler: [optionalAuth, rejectRevokedActor],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const params = PairParamsSchema.safeParse(req.params);
      const body = PatchBodySchema.safeParse(req.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const pair = await pairOwnership(params.data.pairId);
      if (!managePair(optionalActorOf(req), pair).allow) return notFound(reply);
      await trust.setAutoApprove(params.data.pairId, body.data.autoApprove);
      return reply.code(200).send({ ok: true });
    },
  );

  /** Revoke a pair (desktop-side "Revoke"). The row is kept as audit trail;
   * the connect gate fails closed from now on. Also force-ends any live
   * session for this exact pair right now — revoke must not wait for the
   * phone to happen to disconnect on its own. */
  app.delete(
    '/devices/pairs/:pairId',
    {
      preHandler: [optionalAuth, rejectRevokedActor],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const params = PairParamsSchema.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const pair = await pairOwnership(params.data.pairId);
      if (!managePair(optionalActorOf(req), pair).allow) return notFound(reply);
      const fingerprints = await trust.revoke(params.data.pairId);
      if (fingerprints) {
        const ended = hub.endRoomsForDevicePair(
          fingerprints.desktopFingerprint,
          fingerprints.mobileFingerprint,
          'revoked',
        );
        if (ended > 0) {
          log.signaling.info({ pairId: params.data.pairId, ended }, 'revoke ended a live session');
        }
      }
      void auditLog
        .sessionsRevoked({ metadata: { event: 'device_revoked', pairId: params.data.pairId } })
        .catch((err) => log.audit.error({ err }, 'failed to write device_revoked audit log'));
      return reply.code(200).send({ ok: true });
    },
  );

  /** Mobile-initiated unpair — a phone "Forget" severs the pairing on the
   * backend too (so it leaves the laptop's Trusted Devices), the symmetric
   * counterpart to the desktop's own Revoke above. Idempotent: unknown or
   * already-revoked pairs still return ok. Ends any live session for the pair
   * with a NEUTRAL reason ('unpaired', not 'revoked') — the phone initiated
   * this itself, so it must not trip the mobile client's "your access was
   * revoked" alert, which is reserved for the desktop-initiated Revoke. */
  app.post(
    '/devices/unpair',
    {
      preHandler: [optionalAuth, rejectRevokedActor],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = UnpairRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { desktopDeviceId, mobileDeviceId } = parsed.data;
      // The phone must BE the phone it names — severing someone else's pairing
      // is a denial of service against their laptop, and naming a device is
      // not being it. The desktop side needs no separate check: either side of
      // a pair may sever it (`canManagePair`), and an unrelated desktop id
      // simply finds no pair below.
      const mobile = await deviceOwnershipByFingerprint('mobile', mobileDeviceId);
      if (!actAsDevice(optionalActorOf(req), mobile).allow) return notFound(reply);
      const pair = await trust.findPair(desktopDeviceId, mobileDeviceId);
      if (pair && !pair.revoked) {
        await trust.revoke(pair.pairId);
        const ended = hub.endRoomsForDevicePair(desktopDeviceId, mobileDeviceId, 'unpaired');
        void auditLog
          .sessionsRevoked({
            metadata: {
              event: 'device_unpaired_by_mobile',
              pairId: pair.pairId,
              endedLiveSessions: ended,
            },
          })
          .catch((err) => log.audit.error({ err }, 'failed to write device_unpaired audit log'));
      }
      return reply.code(200).send({ ok: true });
    },
  );
}
