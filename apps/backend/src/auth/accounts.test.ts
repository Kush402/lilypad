import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AccountService, type AccountStore } from './accounts.js';
import type { OAuthProvider, ProviderIdentity } from './providers.js';

function fakeStore(): AccountStore & {
  users: Map<string, string>;
  identities: Map<string, string>;
  hashes: Map<string, string>;
} {
  const users = new Map<string, string>(); // userId → email
  const identities = new Map<string, string>(); // "provider:subject" → userId
  const hashes = new Map<string, string>(); // userId → password hash
  const idByEmail = (email: string) => {
    for (const [id, mail] of users) if (mail === email) return id;
    return null;
  };
  return {
    users,
    identities,
    hashes,
    findCredentialsByEmail(email) {
      const userId = idByEmail(email);
      return Promise.resolve(userId ? { userId, passwordHash: hashes.get(userId) ?? null } : null);
    },
    createPasswordUser({ email, name, passwordHash }) {
      void name;
      if (idByEmail(email)) return Promise.resolve(null);
      const id = randomUUID();
      users.set(id, email);
      hashes.set(id, passwordHash);
      return Promise.resolve(id);
    },
    setPasswordHash(userId, passwordHash) {
      hashes.set(userId, passwordHash);
      return Promise.resolve();
    },
    findUserIdByIdentity(provider, subject) {
      return Promise.resolve(identities.get(`${provider}:${subject}`) ?? null);
    },
    findUserIdByEmail(email) {
      for (const [id, mail] of users) if (mail === email) return Promise.resolve(id);
      return Promise.resolve(null);
    },
    createUser(email) {
      const id = randomUUID();
      users.set(id, email);
      return Promise.resolve(id);
    },
    linkIdentity(userId, provider, subject) {
      const key = `${provider}:${subject}`;
      if (!identities.has(key)) identities.set(key, userId);
      return Promise.resolve();
    },
  };
}

function identity(overrides: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    provider: 'google' as OAuthProvider,
    subject: 'sub-1',
    email: 'ada@example.com',
    emailVerified: true,
    ...overrides,
  };
}

describe('AccountService.resolveProviderIdentity', () => {
  let store: ReturnType<typeof fakeStore>;
  let accounts: AccountService;

  beforeEach(() => {
    store = fakeStore();
    accounts = new AccountService(store);
  });

  it('creates an account on first sign-in and links the identity', async () => {
    const result = await accounts.resolveProviderIdentity(identity());
    expect(result.ok).toBe(true);
    expect(store.users.size).toBe(1);
    expect(store.identities.get('google:sub-1')).toBe(result.ok && result.userId);
  });

  it('returns the same account on a second sign-in', async () => {
    const first = await accounts.resolveProviderIdentity(identity());
    const second = await accounts.resolveProviderIdentity(identity());
    expect(second).toEqual(first);
    expect(store.users.size).toBe(1);
  });

  // Apple's Hide My Email can change the address reported for the same user.
  // Following the email instead of the subject would hand the account to
  // whoever the new address belongs to.
  it('follows the subject, not the email, for a known identity', async () => {
    const first = await accounts.resolveProviderIdentity(identity());
    const moved = await accounts.resolveProviderIdentity(
      identity({ email: 'somebody-else@example.com' }),
    );
    expect(moved).toEqual(first);
    expect(store.users.size).toBe(1);
  });

  it('links a second provider to an existing account with the same verified email', async () => {
    const viaGoogle = await accounts.resolveProviderIdentity(identity({ provider: 'google' }));
    const viaApple = await accounts.resolveProviderIdentity(
      identity({ provider: 'apple', subject: 'apple-sub-1' }),
    );
    expect(viaApple).toEqual(viaGoogle);
    expect(store.users.size).toBe(1);
    expect(store.identities.size).toBe(2);
  });

  // The account-takeover case: without this rule, anyone who can get a
  // provider to assert an unverified address inherits that account.
  it('refuses to attach an UNVERIFIED email to an existing account', async () => {
    await accounts.resolveProviderIdentity(identity({ provider: 'google' }));
    const attacker = await accounts.resolveProviderIdentity(
      identity({ provider: 'apple', subject: 'attacker-sub', emailVerified: false }),
    );
    expect(attacker).toEqual({ ok: false, reason: 'email_unverified' });
    expect(store.users.size).toBe(1);
    expect(store.identities.size).toBe(1);
  });

  it('refuses to create an account from an unverified email', async () => {
    const result = await accounts.resolveProviderIdentity(identity({ emailVerified: false }));
    expect(result).toEqual({ ok: false, reason: 'email_unverified' });
    expect(store.users.size).toBe(0);
  });

  it('refuses to create an account with no email, which would have no recovery path', async () => {
    const result = await accounts.resolveProviderIdentity(identity({ email: null }));
    expect(result).toEqual({ ok: false, reason: 'email_required' });
    expect(store.users.size).toBe(0);
  });

  // Apple stops sending the email after the first authorization; a returning
  // user must not be blocked by that.
  it('accepts a known identity that no longer carries an email', async () => {
    const first = await accounts.resolveProviderIdentity(identity());
    const returning = await accounts.resolveProviderIdentity(
      identity({ email: null, emailVerified: false }),
    );
    expect(returning).toEqual(first);
  });

  it('keeps different subjects on different accounts', async () => {
    const one = await accounts.resolveProviderIdentity(identity({ subject: 'sub-1' }));
    const two = await accounts.resolveProviderIdentity(
      identity({ subject: 'sub-2', email: 'grace@example.com' }),
    );
    expect(one).not.toEqual(two);
    expect(store.users.size).toBe(2);
  });
});

describe('AccountService.resolveEmail', () => {
  it('creates then reuses one account per address', async () => {
    const store = fakeStore();
    const accounts = new AccountService(store);
    const first = await accounts.resolveEmail('ada@example.com');
    const second = await accounts.resolveEmail('ada@example.com');
    expect(second).toBe(first);
    expect(store.users.size).toBe(1);
  });

  it('normalizes case and surrounding whitespace', async () => {
    const store = fakeStore();
    const accounts = new AccountService(store);
    const first = await accounts.resolveEmail('ada@example.com');
    expect(await accounts.resolveEmail('  Ada@Example.COM ')).toBe(first);
    expect(store.users.size).toBe(1);
  });

  it('writes no identity row — the email IS the identity for magic link', async () => {
    const store = fakeStore();
    await new AccountService(store).resolveEmail('ada@example.com');
    expect(store.identities.size).toBe(0);
  });
});

// ── password sign-in (ADR-0012) ──────────────────────────────────────────────
describe('AccountService password credentials', () => {
  const signUp = (accounts: AccountService, over: Partial<{ email: string }> = {}) =>
    accounts.signUpWithPassword({
      name: 'Ada Lovelace',
      email: over.email ?? 'ada@example.com',
      password: 'correct horse battery staple',
    });

  it('creates an account and verifies the password it was given', async () => {
    const accounts = new AccountService(fakeStore());
    const created = await signUp(accounts);
    expect(created.ok).toBe(true);
    expect(
      await accounts.verifyPasswordSignIn('ada@example.com', 'correct horse battery staple'),
    ).toEqual({ ok: true, userId: created.ok && created.userId });
  });

  it('stores a hash, never the password', async () => {
    const store = fakeStore();
    await signUp(new AccountService(store));
    const stored = [...store.hashes.values()][0];
    expect(stored).toBeDefined();
    expect(stored).not.toContain('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$/);
  });

  it('normalizes the address, so signup and sign-in agree on case', async () => {
    const accounts = new AccountService(fakeStore());
    await signUp(accounts, { email: '  Ada@Example.COM ' });
    expect(
      (await accounts.verifyPasswordSignIn('ada@example.com', 'correct horse battery staple')).ok,
    ).toBe(true);
  });

  it('refuses a second account for the same address', async () => {
    const accounts = new AccountService(fakeStore());
    await signUp(accounts);
    expect(await signUp(accounts)).toEqual({ ok: false, reason: 'email_in_use' });
  });

  it('rejects a wrong password', async () => {
    const accounts = new AccountService(fakeStore());
    await signUp(accounts);
    expect(await accounts.verifyPasswordSignIn('ada@example.com', 'wrong')).toEqual({
      ok: false,
      reason: 'wrong_password',
    });
  });

  /**
   * An account created by Apple, Google, or a magic link has no password hash.
   * That must fail like any other bad credential — not throw, and not somehow
   * succeed against a null.
   */
  it('rejects password sign-in for an account that has no password', async () => {
    const store = fakeStore();
    const accounts = new AccountService(store);
    await accounts.resolveEmail('ada@example.com');
    expect(await accounts.verifyPasswordSignIn('ada@example.com', 'anything')).toEqual({
      ok: false,
      reason: 'no_password',
    });
  });

  it('rejects an unknown address', async () => {
    const accounts = new AccountService(fakeStore());
    expect(await accounts.verifyPasswordSignIn('nobody@example.com', 'anything')).toEqual({
      ok: false,
      reason: 'no_account',
    });
  });

  it('resets a password for an existing account, and the old one stops working', async () => {
    const accounts = new AccountService(fakeStore());
    const created = await signUp(accounts);
    expect(await accounts.setPasswordForEmail('ada@example.com', 'a whole new passphrase')).toBe(
      created.ok && created.userId,
    );
    expect(
      (await accounts.verifyPasswordSignIn('ada@example.com', 'correct horse battery staple')).ok,
    ).toBe(false);
    expect(
      (await accounts.verifyPasswordSignIn('ada@example.com', 'a whole new passphrase')).ok,
    ).toBe(true);
  });

  /** A reset token proves inbox possession for an account that exists. It must
   * not be a back door into creating one — that would be a signup route with no
   * name and weaker enumeration properties. */
  it('creates no account when resetting an address that has none', async () => {
    const store = fakeStore();
    expect(
      await new AccountService(store).setPasswordForEmail('nobody@example.com', 'passphrase here'),
    ).toBeNull();
    expect(store.users.size).toBe(0);
  });
});
