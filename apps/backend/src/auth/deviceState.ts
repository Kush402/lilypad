import type { DeviceState } from '@lilypad/protocol';

/**
 * A device's lifecycle state, derived rather than stored.
 *
 * The product model has three states and one rule
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)):
 *
 * - **UNLINKED** — the device exists and may even hold a keypair, but no
 *   account owns it. It is not reachable by anyone.
 * - **LINKED** — an account owns it, established by the explicit linking
 *   ceremony. Signing into an account never produces this state on its own.
 * - **REVOKED** — ownership was withdrawn. Terminal until it links again.
 *
 * Derived, not a column, because the underlying facts already exist and a
 * fourth source of truth could disagree with them. `schema.ts` states the
 * invariant this mirrors: "An enrolled device is exactly one with a non-NULL
 * `publicKey` AND a non-NULL `userId`."
 *
 * A public key alone is NOT linkage. A desktop generates its keypair on first
 * run, long before any account has approved it — treating that as linked is
 * precisely the "account = device discovery" mistake the product model exists
 * to prevent.
 */
export interface DeviceOwnershipFacts {
  userId: string | null;
  publicKey: string | null;
  revokedAt: Date | null;
}

export function deviceState(facts: DeviceOwnershipFacts): DeviceState {
  // Revocation outranks everything: a revoked device still has its owner and
  // its key on the row, and neither may resurrect it.
  if (facts.revokedAt !== null) return 'revoked';
  if (facts.userId !== null && facts.publicKey !== null) return 'linked';
  return 'unlinked';
}

/** Whether this device may act — the single question every authorization
 * check reduces to. Only a linked device can. */
export function isLinked(facts: DeviceOwnershipFacts): boolean {
  return deviceState(facts) === 'linked';
}
