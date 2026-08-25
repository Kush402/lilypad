import { orderPairs, reconcile, type PairedDesktop, type RemotePair } from '../pairs';

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

/**
 * The order "Your laptops" is read in.
 *
 * Stored order is the order the laptops were paired in, which stops being
 * interesting the moment there is more than one of them. The same rule as
 * "Your devices": what you were just using is at the top.
 */
describe('orderPairs', () => {
  const pair = (over: Partial<PairedDesktop>): PairedDesktop =>
    ({
      desktopDeviceId: 'd',
      name: 'Laptop',
      apiBaseUrl: 'https://api.example',
      connectSecret: 's',
      addedAt: 0,
      lastConnectedAt: null,
      ...over,
    }) as PairedDesktop;

  it('puts the laptop you were last on first', () => {
    const old = pair({ desktopDeviceId: 'old', addedAt: 1, lastConnectedAt: 100 });
    const recent = pair({ desktopDeviceId: 'recent', addedAt: 2, lastConnectedAt: 200 });
    expect(orderPairs([old, recent]).map((p) => p.desktopDeviceId)).toEqual(['recent', 'old']);
  });

  it('falls back to most recently added for laptops never connected to', () => {
    const first = pair({ desktopDeviceId: 'first', addedAt: 1 });
    const second = pair({ desktopDeviceId: 'second', addedAt: 2 });
    expect(orderPairs([first, second]).map((p) => p.desktopDeviceId)).toEqual(['second', 'first']);
  });

  it('ranks any connection above a laptop that has never been used', () => {
    const never = pair({ desktopDeviceId: 'never', addedAt: 9 });
    const used = pair({ desktopDeviceId: 'used', addedAt: 1, lastConnectedAt: 5 });
    expect(orderPairs([never, used]).map((p) => p.desktopDeviceId)).toEqual(['used', 'never']);
  });

  it('does not reorder the live cache other code mutates', () => {
    const rows = [pair({ desktopDeviceId: 'a', addedAt: 1 }), pair({ desktopDeviceId: 'b', addedAt: 2 })];
    orderPairs(rows);
    expect(rows.map((p) => p.desktopDeviceId)).toEqual(['a', 'b']);
  });
});
