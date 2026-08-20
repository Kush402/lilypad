import { and, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { oauthIdentities, users } from '../db/schema.js';
import type { OAuthProvider, ProviderIdentity } from './providers.js';
import { hashPassword, verifyPassword, verifyAgainstDummy } from './password.js';

/**
 * Turning a verified provider identity (or a proven email) into an account.
 *
 * This is where account takeover would live if it lived anywhere, so the rules
 * are stated rather than implied:
 *
 * 1. A known `(provider, subject)` always resolves to its existing account,
 *    regardless of what email the token now carries. Providers change the
 *    address they report — Apple's Hide My Email relay is the obvious case —
 *    and following the email instead of the subject would hand the account to
 *    whoever the address currently points at.
 * 2. An unknown identity may only ATTACH to an existing account when the
 *    provider says the email is verified. An unverified address is an
 *    unproven claim, and honouring it would let anyone who can type a victim's
 *    email address at a sloppy provider inherit their laptops.
 * 3. An unknown identity with no email at all cannot create an account,
 *    because the account would have no recovery path.
 */

export type LinkFailure = 'email_required' | 'email_unverified';

/**
 * Why a password sign-in failed
 * ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
 *
 * `no_password` is an account that has only ever used Apple, Google, or a magic
 * link — a normal state, not a missing value. All three reasons answer the
 * client identically; the distinction is for the audit log alone.
 */
export type PasswordSignInResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'no_account' | 'no_password' | 'wrong_password' };

export type LinkResult =
  { ok: true; userId: string; claimedFromUnproven: boolean } | { ok: false; reason: LinkFailure };

export interface AccountStore {
  findUserIdByIdentity(provider: OAuthProvider, subject: string): Promise<string | null>;
  findUserIdByEmail(email: string): Promise<string | null>;
  /** Insert a user, or return the existing id if another request won the race. */
  createUser(email: string): Promise<string>;
  /** Link an identity to a user, or do nothing if it is already linked. */
  linkIdentity(userId: string, provider: OAuthProvider, subject: string): Promise<void>;
  /** The credential row behind an address, or null if the address is unknown.
   * `passwordHash` is null for an account that has only ever used OAuth or a
   * magic link — a normal state, not a missing value (ADR-0012).
   * `emailVerifiedAt` is null when nobody has ever proved they read the
   * inbox — see `users.emailVerifiedAt` and `claimUnprovenAccount`. */
  findCredentialsByEmail(email: string): Promise<{
    userId: string;
    passwordHash: string | null;
    emailVerifiedAt: Date | null;
  } | null>;
  /** Insert a password account. Returns null if the address is already taken —
   * the unique index decides, not a prior read, so two concurrent signups
   * cannot both succeed. */
  createPasswordUser(input: {
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<string | null>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** Mark the address proven, and drop any password that was set before it
   * was. Returns true when a password was actually cleared, which is the
   * signal the caller needs to revoke the squatter's sessions too. */
  claimUnprovenAccount(userId: string): Promise<boolean>;
  /** Mark the address proven without touching credentials — the reset-password
   * path, where the person changing the password just proved the inbox. */
  markEmailVerified(userId: string): Promise<void>;
}

/**
 * The outcome of resolving a PROVEN address to an account.
 *
 * `claimedFromUnproven` is true when the account already existed with a
 * password nobody had ever proved they were entitled to set. That is an
 * account pre-hijacking attempt (register the victim's address, wait for them
 * to sign in for real, keep the password), so the password is dropped and the
 * caller must revoke every refresh token the squatter holds.
 */
export interface ProvenEmailResult {
  userId: string;
  claimedFromUnproven: boolean;
}

export class AccountService {
  constructor(private readonly store: AccountStore) {}

  /** Resolve (or create) the account behind a verified provider identity. */
  async resolveProviderIdentity(identity: ProviderIdentity): Promise<LinkResult> {
    const existing = await this.store.findUserIdByIdentity(identity.provider, identity.subject);
    // A known (provider, subject) is already proven and already attached —
    // nothing to claim, whatever the token now says the address is.
    if (existing) return { ok: true, userId: existing, claimedFromUnproven: false };

    if (!identity.email) return { ok: false, reason: 'email_required' };
    if (!identity.emailVerified) return { ok: false, reason: 'email_unverified' };

    // Reached only with a provider-VERIFIED address, so this caller has proved
    // the inbox exactly as strongly as a magic link does.
    const byEmail = await this.store.findUserIdByEmail(identity.email);
    let claimedFromUnproven = false;
    let userId: string;
    if (byEmail) {
      userId = byEmail;
      claimedFromUnproven = await this.store.claimUnprovenAccount(userId);
    } else {
      userId = await this.store.createUser(identity.email);
    }
    await this.store.linkIdentity(userId, identity.provider, identity.subject);
    return { ok: true, userId, claimedFromUnproven };
  }

  /**
   * Resolve (or create) the account behind a proven email address — the
   * magic-link path. No identity row is written: for this method the email IS
   * the identity, and possession of the inbox is the proof.
   */
  async resolveEmail(email: string): Promise<ProvenEmailResult> {
    const normalized = email.trim().toLowerCase();
    const existing = await this.store.findUserIdByEmail(normalized);
    if (!existing)
      return { userId: await this.store.createUser(normalized), claimedFromUnproven: false };
    return {
      userId: existing,
      claimedFromUnproven: await this.store.claimUnprovenAccount(existing),
    };
  }

  /**
   * Create an account from name + email + password
   * ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
   *
   * The taken-address answer is authoritative because the unique index
   * produces it, not a read-then-write: checking first and inserting second
   * would let two concurrent signups for one address both pass the check.
   */
  async signUpWithPassword(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<{ ok: true; userId: string } | { ok: false; reason: 'email_in_use' }> {
    const userId = await this.store.createPasswordUser({
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
    });
    return userId ? { ok: true, userId } : { ok: false, reason: 'email_in_use' };
  }

  /**
   * Check email + password.
   *
   * **The three failures are distinguished HERE and nowhere the caller can
   * reach.** The route answers `invalid_credentials` for all of them, and must
   * keep doing so; what `reason` exists for is the audit log, which is the only
   * place an operator can find out whether a user typed the wrong address or
   * the wrong password. Without it a failed sign-in is undiagnosable — the
   * question "did the account even match?" had no answer anywhere in the
   * system, which is exactly the wall a real support case hits.
   *
   * Every branch still pays for a real hash comparison. Returning early would
   * make "no such account" measurably faster than "wrong password", which is an
   * account-existence oracle on the one route worth automating.
   */
  async verifyPasswordSignIn(email: string, password: string): Promise<PasswordSignInResult> {
    const found = await this.store.findCredentialsByEmail(email.trim().toLowerCase());
    if (!found) {
      await verifyAgainstDummy(password);
      return { ok: false, reason: 'no_account' };
    }
    if (!found.passwordHash) {
      await verifyAgainstDummy(password);
      return { ok: false, reason: 'no_password' };
    }
    return (await verifyPassword(password, found.passwordHash))
      ? { ok: true, userId: found.userId }
      : { ok: false, reason: 'wrong_password' };
  }

  /**
   * Set a new password for a proven address. Creates nothing: a reset token is
   * proof of inbox possession for an account that already exists, and minting
   * an account here would turn "reset your password" into a second signup route
   * with no name and weaker enumeration properties.
   */
  async setPasswordForEmail(email: string, password: string): Promise<string | null> {
    const found = await this.store.findCredentialsByEmail(email.trim().toLowerCase());
    if (!found) return null;
    await this.store.setPasswordHash(found.userId, await hashPassword(password));
    // Redeeming the reset token WAS proof of inbox possession. Recording it
    // means a squatted account stops being squatted once its real owner
    // resets, rather than staying claimable forever.
    await this.store.markEmailVerified(found.userId);
    return found.userId;
  }
}

/** Adapts the real Drizzle client to `AccountStore`. */
export function createDrizzleAccountStore(database: typeof defaultDb = defaultDb): AccountStore {
  return {
    async findUserIdByIdentity(provider, subject) {
      const rows = await database
        .select({ userId: oauthIdentities.userId })
        .from(oauthIdentities)
        .where(and(eq(oauthIdentities.provider, provider), eq(oauthIdentities.subject, subject)))
        .limit(1);
      return rows[0]?.userId ?? null;
    },
    async findUserIdByEmail(email) {
      const rows = await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows[0]?.id ?? null;
    },
    async createUser(email) {
      // Two first-time sign-ins for one address can race. `users.email` is
      // unique, so the loser yields to the winner rather than erroring —
      // the outcome ("one account for this address") is the same either way.
      // `emailVerifiedAt` is set here and not in `createPasswordUser`: every
      // caller of this method arrived holding proof of the inbox (a redeemed
      // magic link, or a provider-verified address), and signup holds none.
      const inserted = await database
        .insert(users)
        .values({ email, emailVerifiedAt: new Date() })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      if (inserted[0]) return inserted[0].id;
      const raced = await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const row = raced[0];
      if (!row) throw new Error('user insert conflicted but no row exists');
      return row.id;
    },
    async findCredentialsByEmail(email) {
      const rows = await database
        .select({
          userId: users.id,
          passwordHash: users.passwordHash,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows[0] ?? null;
    },
    async createPasswordUser({ email, name, passwordHash }) {
      // `onConflictDoNothing` + an empty `returning` IS the taken-address
      // answer: the unique index on `users.email` is what decides, so a
      // concurrent signup for the same address loses here rather than
      // overwriting the winner's credentials.
      const inserted = await database
        .insert(users)
        .values({ email, name, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      return inserted[0]?.id ?? null;
    },
    async setPasswordHash(userId, passwordHash) {
      await database.update(users).set({ passwordHash }).where(eq(users.id, userId));
    },
    async claimUnprovenAccount(userId) {
      // One statement, with `email_verified_at IS NULL` in the WHERE rather
      // than in a preceding SELECT: two concurrent proofs of the same inbox
      // must not both report a claim, or both would revoke and each would sign
      // the other out.
      //
      // Revoking on the (rare) unproven-but-passwordless row is not
      // over-reach: a session on an account nobody had proved belongs to
      // whoever created it, and that was by definition not this caller.
      const claimed = await database
        .update(users)
        .set({ passwordHash: null, emailVerifiedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)))
        .returning({ id: users.id });
      return claimed.length > 0;
    },
    async markEmailVerified(userId) {
      await database
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    },
    async linkIdentity(userId, provider, subject) {
      // Idempotent: re-linking an identity that already exists is a no-op, and
      // the unique index means a concurrent duplicate cannot split the account.
      await database
        .insert(oauthIdentities)
        .values({ userId, provider, subject })
        .onConflictDoNothing({
          target: [oauthIdentities.provider, oauthIdentities.subject],
        });
    },
  };
}
