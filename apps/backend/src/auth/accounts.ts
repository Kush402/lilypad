import { and, eq } from 'drizzle-orm';
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

export type LinkResult = { ok: true; userId: string } | { ok: false; reason: LinkFailure };

export interface AccountStore {
  findUserIdByIdentity(provider: OAuthProvider, subject: string): Promise<string | null>;
  findUserIdByEmail(email: string): Promise<string | null>;
  /** Insert a user, or return the existing id if another request won the race. */
  createUser(email: string): Promise<string>;
  /** Link an identity to a user, or do nothing if it is already linked. */
  linkIdentity(userId: string, provider: OAuthProvider, subject: string): Promise<void>;
  /** The credential row behind an address, or null if the address is unknown.
   * `passwordHash` is null for an account that has only ever used OAuth or a
   * magic link — a normal state, not a missing value (ADR-0012). */
  findCredentialsByEmail(
    email: string,
  ): Promise<{ userId: string; passwordHash: string | null } | null>;
  /** Insert a password account. Returns null if the address is already taken —
   * the unique index decides, not a prior read, so two concurrent signups
   * cannot both succeed. */
  createPasswordUser(input: {
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<string | null>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
}

export class AccountService {
  constructor(private readonly store: AccountStore) {}

  /** Resolve (or create) the account behind a verified provider identity. */
  async resolveProviderIdentity(identity: ProviderIdentity): Promise<LinkResult> {
    const existing = await this.store.findUserIdByIdentity(identity.provider, identity.subject);
    if (existing) return { ok: true, userId: existing };

    if (!identity.email) return { ok: false, reason: 'email_required' };
    if (!identity.emailVerified) return { ok: false, reason: 'email_unverified' };

    const byEmail = await this.store.findUserIdByEmail(identity.email);
    const userId = byEmail ?? (await this.store.createUser(identity.email));
    await this.store.linkIdentity(userId, identity.provider, identity.subject);
    return { ok: true, userId };
  }

  /**
   * Resolve (or create) the account behind a proven email address — the
   * magic-link path. No identity row is written: for this method the email IS
   * the identity, and possession of the inbox is the proof.
   */
  async resolveEmail(email: string): Promise<string> {
    const normalized = email.trim().toLowerCase();
    const existing = await this.store.findUserIdByEmail(normalized);
    return existing ?? this.store.createUser(normalized);
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
   * Check email + password. Returns null for an unknown address, a wrong
   * password, and an account with no password alike — the caller must not be
   * able to tell those apart, so this signature cannot express the difference.
   *
   * Both null branches still pay for a real hash comparison. Returning early
   * would make "no such account" measurably faster than "wrong password",
   * which is an account-existence oracle on the one route worth automating.
   */
  async verifyPasswordSignIn(email: string, password: string): Promise<string | null> {
    const found = await this.store.findCredentialsByEmail(email.trim().toLowerCase());
    if (!found?.passwordHash) return verifyAgainstDummy(password).then(() => null);
    return (await verifyPassword(password, found.passwordHash)) ? found.userId : null;
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
      const inserted = await database
        .insert(users)
        .values({ email })
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
        .select({ userId: users.id, passwordHash: users.passwordHash })
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
