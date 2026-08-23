import type { Actor } from './tokens.js';
import {
  ownsDevice,
  canManagePair,
  type DeviceOwnership,
  type PairOwnership,
} from './ownership.js';

/**
 * The authorization rule every route applies, as a pure decision
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * `ownership.ts` answers "who owns this?"; this answers "may this caller
 * proceed?". It is deliberately pure and DB-free — the same split as
 * `signaling/registerAuth.ts` — so the rule that guards every route is
 * exhaustively table-testable without a Postgres, a Fastify, or a socket.
 *
 * **Two questions, not one.** They are different and conflating them is how
 * authorization bugs get written:
 *
 * - _Acting as_ a device (`actAsDevice`) — the caller claims to BE a machine:
 *   ringing a laptop, redeeming a QR, unpairing, claiming a presence room.
 *   Owning it is not enough; you must present that device's own token. This is
 *   what makes a device id in a request body worthless.
 * - _Managing_ a device or pair (`manageDevice`/`managePair`) — the caller acts
 *   on a resource it owns: listing trusted phones, flipping Always-allow,
 *   revoking. Any device of the owning account qualifies, which is what lets a
 *   phone manage its laptop's pairs in P2.
 *
 * **There is no unowned lane.** A device row with no `user_id` may do nothing
 * at all.
 *
 * This branch used to ALLOW. The reasoning was that a row nobody owns has no
 * account to protect and no cross-user boundary to cross, so it should keep
 * the behaviour it shipped with before accounts existed — and that the branch
 * would become unreachable once enrolment was mandatory. Enrolment never
 * became mandatory (P1 chose "linking is offered, not demanded"), so what was
 * written as a migration ramp had quietly become permanent: knowing a
 * fingerprint was sufficient to act as any unlinked device, forever.
 *
 * The product model is now **account → devices**: an account is established
 * first, and every device hangs beneath one. A device that belongs to no
 * account is therefore not a device with reduced privileges — it is a device
 * that cannot act, because there is no one on whose behalf it would be acting.
 * The only remaining `allow` is `lane: 'owner'`.
 *
 * What this does NOT gate, deliberately, is the ceremony that creates the
 * ownership in the first place: `/devices/challenge`, `/devices/token` and
 * `/devices/enrollment-code` consult none of these decisions, so a brand-new
 * computer can still mint the code a phone approves. Linking remains possible;
 * only ACTING while unlinked does not.
 *
 * A denied caller must never be able to tell "not yours" from "does not
 * exist", so every caller maps `allow: false` to the same 404 it would return
 * for a resource that was never there.
 */

export type Access =
  /** The actor owns (or is) the resource. The only way to be allowed. */
  { allow: true; lane: 'owner' } | { allow: false };

const DENY: Access = { allow: false };
const OWNER: Access = { allow: true, lane: 'owner' };

/**
 * May this caller act AS this device?
 *
 * An unknown device (`null`) is unowned by definition — the caller named
 * something that does not exist, and the route's own not-found handling
 * answers that, not this.
 */
export function actAsDevice(actor: Actor | null, device: DeviceOwnership | null): Access {
  // A device nobody has heard of cannot be acted as. The route's own not-found
  // handling is what tells the caller so; this only refuses to authorize it.
  if (device === null) return DENY;
  // A revoked device may not act, whoever asks. Revocation exists precisely
  // for the machine that is no longer in the owner's hands.
  if (device.state === 'revoked') return DENY;
  // On no account, so acting on nobody's behalf.
  if (device.userId === null) return DENY;
  if (actor === null) return DENY;
  // Both halves: the token must have been minted FOR this device row, and its
  // subject must still be the account that owns it.
  if (actor.deviceId !== device.deviceId) return DENY;
  return ownsDevice(actor.userId, device) ? OWNER : DENY;
}

/**
 * May this caller manage this device?
 *
 * Unlike `actAsDevice`, a revoked device is still manageable by its owner —
 * "I lost my laptop" must not also mean "and now you cannot clean up after
 * it". What revocation stops is the device acting, which is the check above.
 */
export function manageDevice(actor: Actor | null, device: DeviceOwnership | null): Access {
  if (device === null) return DENY;
  if (device.userId === null) return DENY;
  if (actor === null) return DENY;
  return ownsDevice(actor.userId, device) ? OWNER : DENY;
}

/**
 * May this caller manage this pair?
 *
 * One owned side is enough to make the relationship someone's business, and
 * `canManagePair` then decides whose. With neither side owned there is nobody
 * it could be the business of.
 */
export function managePair(actor: Actor | null, pair: PairOwnership | null): Access {
  if (pair === null) return DENY;
  // Neither side on an account: there is no owner to authorize against, so
  // nobody may manage it. Such a pair can no longer be created — both
  // ceremonies now require owned devices — and any that survive are inert.
  if (pair.desktop.userId === null && pair.mobile.userId === null) return DENY;
  if (actor === null) return DENY;
  return canManagePair(actor.userId, pair) ? OWNER : DENY;
}
