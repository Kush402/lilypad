import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { oauthIdentities, users } from '../db/schema.js';
import type { OAuthProvider, ProviderIdentity } from './providers.js';

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
