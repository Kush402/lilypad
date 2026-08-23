import { reconcile, type PairedDesktop, type RemotePair } from '../pairs';

/**
 * The phone's laptop list used to be checked against nothing. A laptop revoked
 * from the other side, or belonging to a deleted account, kept appearing under
 * "Your laptops" until the user tapped it and the connect failed with
 * `not_trusted` — the wrong place to find out.
 *
 * These are the rules that decide what survives. The function is pure so they
 * can be stated without a keychain or a network, and because it DELETES rows:
 * every rule here is one that, wrong, loses a working laptop.
 */

const local = (over: Partial<PairedDesktop> = {}): PairedDesktop => ({
  desktopDeviceId: 'desktop-aaa',
  name: 'macos desktop',
  apiBaseUrl: 'https://api.takedia.com',
  connectSecret: 'secret-1',
  addedAt: 1,
  lastConnectedAt: null,
  ...over,
});

const remote = (over: Partial<RemotePair> = {}): RemotePair => ({
  desktopDeviceId: 'desktop-aaa',
  name: 'macos desktop',
  revoked: false,
  ...over,
});

const BASE = 'https://api.takedia.com';

describe('what the backend can take away', () => {
  it('keeps a laptop the backend still knows', () => {
    expect(reconcile([local()], [remote()], BASE)).toHaveLength(1);
  });

  it('drops a laptop the backend says was revoked', () => {
    expect(reconcile([local()], [remote({ revoked: true })], BASE)).toEqual([]);
  });

  it('drops a laptop the backend has never heard of', () => {
    // Account deleted, device revoked, pair purged — all the same to the phone.
    expect(reconcile([local()], [], BASE)).toEqual([]);
  });

  it('keeps the connect secret of a surviving pair, which only this phone has', () => {
    const [kept] = reconcile([local()], [remote()], BASE);
    expect(kept.connectSecret).toBe('secret-1');
  });
});

describe('what one backend may not speak for', () => {
  /**
   * A phone may hold pairs on several backends — that is what makes
   * self-hosting work. Pruning across them would delete a perfectly good
   * self-hosted laptop because takedia.com had never heard of it.
   */
  it("leaves another backend's laptops alone", () => {
    const selfHosted = local({
      desktopDeviceId: 'desktop-bbb',
      apiBaseUrl: 'https://lilypad.example.internal',
    });

    const kept = reconcile([local(), selfHosted], [], BASE);

    expect(kept).toEqual([selfHosted]);
  });

  it('matches backends regardless of a trailing slash', () => {
    const withSlash = local({ apiBaseUrl: 'https://api.takedia.com/' });
    expect(reconcile([withSlash], [], BASE)).toEqual([]);
    expect(reconcile([withSlash], [remote()], BASE)).toHaveLength(1);
  });
});

describe('what reconciliation must never do', () => {
  /**
   * The per-pair connect secret lives only on this phone, so a row restored
   * from the backend alone could never connect. Adding it would put a button
   * on screen that always fails; re-scanning the QR is what restores it.
   */
  it('does not invent a laptop the backend knows but this phone does not', () => {
    expect(reconcile([], [remote({ desktopDeviceId: 'desktop-ccc' })], BASE)).toEqual([]);
  });

  it('adopts a rename made on the laptop', () => {
    const [kept] = reconcile([local()], [remote({ name: 'Work Mac' })], BASE);
    expect(kept.name).toBe('Work Mac');
  });

  it('keeps the local name when the backend has none, rather than blanking it', () => {
    const [kept] = reconcile([local({ name: 'My Mac' })], [remote({ name: null })], BASE);
    expect(kept.name).toBe('My Mac');
  });
});
