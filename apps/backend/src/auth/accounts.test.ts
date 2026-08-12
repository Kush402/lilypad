import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AccountService, type AccountStore } from './accounts.js';
import type { OAuthProvider, ProviderIdentity } from './providers.js';

function fakeStore(): AccountStore & {
  users: Map<string, string>;
  identities: Map<string, string>;
} {
  const users = new Map<string, string>(); // userId → email
  const identities = new Map<string, string>(); // "provider:subject" → userId
  return {
    users,
    identities,
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
