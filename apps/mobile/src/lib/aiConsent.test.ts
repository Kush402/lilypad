import {
  grantAiConsent,
  hasAiConsent,
  hasUnresolvedRevocation,
  resetAiConsentCache,
  revokeAiConsent,
  targetFor,
} from './aiConsent';

/**
 * A keychain that behaves like the real one in the ways that matter here:
 * items are separate, and either a read, a write or a delete can fail on its
 * own. The L-266 defect is only visible when a delete fails while writes still
 * work, which a single in-memory boolean cannot express.
 */
const mockItems = new Map<string, string>();
const mockFail = { set: false, reset: false };

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly' },
  getGenericPassword: jest.fn(async ({ service }: { service: string }) => {
    const stored = mockItems.get(service);
    return stored === undefined ? false : { username: 'u', password: stored };
  }),
  setGenericPassword: jest.fn(
    async (_u: string, password: string, { service }: { service: string }) => {
      if (mockFail.set) throw new Error('keychain write denied');
      mockItems.set(service, password);
      return true;
    },
  ),
  resetGenericPassword: jest.fn(async ({ service }: { service: string }) => {
    if (mockFail.reset) throw new Error('keychain delete denied');
    mockItems.delete(service);
    return true;
  }),
}));

function target(over: Partial<Parameters<typeof grantAiConsent>[0]> = {}) {
  return {
    desktopDeviceId: 'mac-a',
    origin: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    local: false,
    policy: 1,
    revision: 'abc123',
    ...over,
  };
}

const MAC_A = target();
const MAC_A_ELSEWHERE = target({ origin: 'https://gw.example.com' });
const MAC_B = target({ desktopDeviceId: 'mac-b' });
const MAC_A_OTHER_MODEL = target({ model: 'gpt-4o' });

beforeEach(() => {
  mockItems.clear();
  mockFail.set = false;
  mockFail.reset = false;
  resetAiConsentCache();
});

describe('consent is bound to a destination (L-265)', () => {
  it('agreeing to one Mac and provider does not agree to another', async () => {
    await grantAiConsent(MAC_A);
    resetAiConsentCache();

    expect(await hasAiConsent(MAC_A)).toBe(true);
    // Same Mac, endpoint changed underneath: the agreement was to a party,
    // and this is a different party.
    expect(await hasAiConsent(MAC_A_ELSEWHERE)).toBe(false);
    // Same provider, different Mac: a second machine is a second decision.
    expect(await hasAiConsent(MAC_B)).toBe(false);
  });

  it('refuses when the Mac disclosed no destination at all', async () => {
    await grantAiConsent(MAC_A);
    // `targetFor` returns null, and null can never match a grant — the point
    // being that an undisclosed destination must not inherit an old yes.
    expect(targetFor('mac-a', undefined)).toBeNull();
    expect(await hasAiConsent(null)).toBe(false);
  });

  it('ignores a grant recorded under older consent wording', async () => {
    // Written by hand at policy 0, the way a build from before the current
    // wording would have left it.
    mockItems.set(
      'com.takedia.lilypad.ai-consent',
      JSON.stringify([{ ...MAC_A, policy: 0, grantedAt: '2026-01-01T00:00:00Z' }]),
    );
    expect(await hasAiConsent(MAC_A)).toBe(false);
  });

  it('asks again when the Mac switches model under the same endpoint', async () => {
    // The card named a model. A different one is a different statement, even
    // though the provider and origin are unchanged.
    await grantAiConsent(MAC_A);
    resetAiConsentCache();
    expect(await hasAiConsent(MAC_A)).toBe(true);
    expect(await hasAiConsent(MAC_A_OTHER_MODEL)).toBe(false);
  });

  it('refuses a disclosure made under wording this phone does not have', async () => {
    // `targetFor` returns null, so there is nothing to agree to. The phone
    // would otherwise show its own copy while the Mac meant something else.
    expect(
      targetFor('mac-a', {
        profileId: 'openai',
        providerName: 'OpenAI',
        origin: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        local: false,
        consentPolicy: 99,
        consentRevision: 'r',
        source: 'settings',
      }),
    ).toBeNull();
  });

  it("carries the Mac's revision through without keying on it", async () => {
    // The grant must not depend on a digest the other device computes: a Mac
    // that reported a stale revision could otherwise reuse an old agreement.
    await grantAiConsent(target({ revision: 'first' }));
    resetAiConsentCache();
    expect(await hasAiConsent(target({ revision: 'second' }))).toBe(true);
    // But a change the person would have SEEN still asks again.
    expect(await hasAiConsent(target({ revision: 'second', local: true }))).toBe(false);
  });
});

describe('withdrawal survives a restart (L-266)', () => {
  it('stays withdrawn when the grant could not be deleted', async () => {
    await grantAiConsent(MAC_A);
    resetAiConsentCache();

    // The exact failure the defect was about: the delete fails, so the stored
    // "granted" is still on disk afterwards.
    mockFail.reset = true;
    expect(await revokeAiConsent(MAC_A)).toBe(true); // durable — via the tombstone
    expect(mockItems.get('com.takedia.lilypad.ai-consent')).toContain('mac-a');

    // Restart. Before the fix this read the surviving grant back and carried
    // on sharing.
    resetAiConsentCache();
    expect(await hasAiConsent(MAC_A)).toBe(false);
  });

  it('reports failure rather than claiming success when nothing can be stored', async () => {
    await grantAiConsent(MAC_A);
    resetAiConsentCache();

    mockFail.set = true;
    mockFail.reset = true;
    expect(await revokeAiConsent(MAC_A)).toBe(false);
    expect(hasUnresolvedRevocation()).toBe(true);
    // Blocked for this run even though nothing could be written down.
    expect(await hasAiConsent(MAC_A)).toBe(false);
  });

  it('lets the person agree again after withdrawing', async () => {
    await grantAiConsent(MAC_A);
    await revokeAiConsent(MAC_A);
    resetAiConsentCache();
    expect(await hasAiConsent(MAC_A)).toBe(false);

    await grantAiConsent(MAC_A);
    resetAiConsentCache();
    expect(await hasAiConsent(MAC_A)).toBe(true);
  });

  it('withdrawing one destination leaves the others alone', async () => {
    await grantAiConsent(MAC_A);
    await grantAiConsent(MAC_B);
    await revokeAiConsent(MAC_A);
    resetAiConsentCache();

    expect(await hasAiConsent(MAC_A)).toBe(false);
    expect(await hasAiConsent(MAC_B)).toBe(true);
  });
});

describe('failure directions', () => {
  it('fails closed when the tombstone item cannot be read', async () => {
    await grantAiConsent(MAC_A);
    resetAiConsentCache();
    const keychain = jest.requireMock('react-native-keychain') as {
      getGenericPassword: jest.Mock;
    };
    keychain.getGenericPassword.mockRejectedValueOnce(new Error('locked'));

    // An unreadable revocation list must never be read as "no revocations".
    expect(await hasAiConsent(MAC_A)).toBe(false);
  });
});
