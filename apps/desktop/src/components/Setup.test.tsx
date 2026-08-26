import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Setup } from './Setup';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(),
}));
// The linking panel has its own suite (AccountPanel.test.tsx); stubbing it here
// keeps these tests about the wizard's own ordering and its final claim.
vi.mock('./AccountPanel', () => ({
  AccountPanel: () => <div data-testid="account-panel" />,
}));

function status(overrides: Partial<{ screen_capture: boolean; accessibility: boolean }> = {}) {
  return { screen_capture: false, accessibility: false, ...overrides };
}

/** Grant both permissions, which is what unlocks steps 2 and 3. */
function grantAll(handler: ((event: { payload: unknown }) => void) | undefined) {
  handler?.({ payload: status({ screen_capture: true, accessibility: true }) });
}

/** `noUncheckedIndexedAccess` makes `arr[n]` possibly-`undefined`; every call
 * site below already knows the element exists (asserted by the surrounding
 * `getAllByText` succeeding at all), so this documents that invariant once
 * instead of a non-null assertion at every call site. */
function nth(elements: HTMLElement[], index: number): HTMLElement {
  const el = elements[index];
  if (!el) throw new Error(`expected an element at index ${index}`);
  return el;
}

/** Permissions live behind step 1 now, so any test that wants to see a
 * permission row has to be signed in first. Mirrors what `AccountSignIn`
 * reports upward via `onChange`. */
function mockSignedIn(link: 'linked' | 'unlinked' | 'unknown' = 'unlinked') {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'get_permission_status') return status();
    if (cmd === 'get_link_state') return { state: link };
    if (cmd === 'get_account_state')
      return { signedIn: true, email: 'ada@example.com', userId: 'user-1' };
    return undefined;
  });
}

describe('Setup', () => {
  let eventHandler: ((event: { payload: unknown }) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandler = undefined;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'unlinked' };
      return undefined;
    });
    vi.mocked(listen).mockImplementation((async (
      _name: string,
      handler: (e: { payload: unknown }) => void,
    ) => {
      eventHandler = handler;
      return vi.fn();
    }) as unknown as typeof listen);
  });

  /**
   * Ordering regression. First run used to be permissions → link → pair, with
   * no mention of an account anywhere and a QR code as its last screen, which
   * taught the wrong model of what Lilypad is. The account comes first now
   * (ADR-0012) — not because anything below needs it, but because it is step 1
   * of the product.
   */
  it('puts the account step before the permissions step', async () => {
    render(<Setup />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_permission_status'));

    // `AccountSignIn` renders its own h2, so filter to the numbered steps.
    const steps = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent ?? '')
      .filter((text) => /^\d+ · /.test(text));
    expect(steps[0]).toBe('1 · Your account');
    expect(steps[1]).toBe('2 · Permissions');
  });

  /**
   * The count is a promise, and a customer checks it against the screen.
   *
   * It said "Four steps" while the third and fourth were the same act — pick up
   * the phone, scan a QR — performed twice with two different codes. ADR-0015
   * removed the first of those, so the number had to move with it: a wizard
   * that promises four and shows three has miscounted in front of the person
   * it is trying to reassure.
   */
  it('promises exactly as many steps as it numbers', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'linked' };
      if (cmd === 'get_account_state')
        return { signedIn: true, email: 'ada@example.com', userId: 'user-1' };
      return undefined;
    });

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    await screen.findByText('3 · Pair your phone');
    const numbered = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent ?? '')
      .filter((text) => /^\d+ · /.test(text));
    expect(numbered).toEqual(['1 · Your account', '2 · Permissions', '3 · Pair your phone']);
    expect(screen.getByText(/Three steps\./)).toBeInTheDocument();
    expect(screen.queryByText(/Four steps/)).not.toBeInTheDocument();
  });

  /**
   * Reported from the installed build: first run showed "Sign in",
   * "Permissions" and "Ask" together, so a stranger who had not yet made an
   * account was being asked for Screen Recording — the most alarming thing
   * Lilypad ever requests — and to paste an AI provider's API key. Neither has
   * any reason to be answered by someone who has not said who they are yet.
   */
  it('does not ask for OS permissions before there is an account', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());

    expect(await screen.findByTestId('permissions-step-locked')).toHaveTextContent(
      /finish step 1 first/i,
    );
    expect(screen.queryByText('Screen Recording')).not.toBeInTheDocument();
    expect(screen.queryByText('Grant')).not.toBeInTheDocument();
  });

  /** Ask needs an API key and blocks nothing; offering it on a Mac that cannot
   * yet capture or type put optional configuration ahead of the product. */
  it('does not offer Ask until the Mac can actually do something', async () => {
    mockSignedIn();
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());

    expect(screen.queryByTestId('ask-optional')).not.toBeInTheDocument();
    grantAll(eventHandler);
    expect(await screen.findByTestId('ask-optional')).toBeInTheDocument();
  });

  it('fetches initial status and shows both permission rows', async () => {
    mockSignedIn();
    render(<Setup />);
    // `findByText`, not `waitFor(invoke was called)` + `getByText`. Waiting for
    // the COMMAND leaves a gap: the call having happened says nothing about its
    // promise having resolved and React having re-rendered. On this machine the
    // microtask always flushed first and it passed; on a loaded CI runner it
    // did not, and the run went red on working code with
    // "Unable to find an element with the text: Screen Recording".
    expect(await screen.findByText('Screen Recording')).toBeInTheDocument();
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_permission_status');
  });

  it('Grant calls the prompting request_permission command', async () => {
    mockSignedIn();
    render(<Setup />);
    await screen.findByText('Screen Recording');
    vi.mocked(invoke).mockResolvedValueOnce(true);

    fireEvent.click(nth(screen.getAllByText('Grant'), 0));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('request_permission', { kind: 'screen_capture' }),
    );
  });

  it('Open Settings deep-links via open_permission_settings', async () => {
    mockSignedIn();
    render(<Setup />);
    await screen.findByText('Screen Recording');

    fireEvent.click(nth(screen.getAllByText('Open Settings'), 0));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('open_permission_settings', { kind: 'screen_capture' }),
    );
  });

  it('updates status when a lilypad://permission event fires, without a poll timer', async () => {
    mockSignedIn();
    render(<Setup />);
    await waitFor(() =>
      expect(listen).toHaveBeenCalledWith('lilypad://permission', expect.any(Function)),
    );

    eventHandler?.({ payload: status({ screen_capture: true }) });

    await waitFor(() => expect(screen.getAllByText('Granted')).toHaveLength(1));
  });

  it('shows a Done button once both permissions are granted, which closes the window', async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getCurrentWindow).mockReturnValue({ close: closeMock } as never);

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());

    grantAll(eventHandler);

    fireEvent.click(await screen.findByText('Done'));
    expect(closeMock).toHaveBeenCalled();
  });

  // ── First run as a whole (P1) ───────────────────────────────────────────
  // Offering to pair a phone with a computer that cannot capture or type is a
  // step out of order — it would connect and then show nothing.
  //
  // The ownership card is NOT withheld the same way, and that is the change of
  // 2026-08-25: it moved under step 1 because signing in is what fills it in
  // ([ADR-0015](../../../docs/adr/0015-ownership-follows-sign-in.md)). It is a
  // statement about the account, not a step between the user and a session.
  it('withholds pairing until the permissions are granted', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());

    expect(screen.queryByTestId('pair-step-locked')).not.toBeInTheDocument();
    // …while the ownership card is already there, saying what it needs.
    expect(await screen.findByTestId('link-step-locked')).toBeInTheDocument();

    grantAll(eventHandler);

    expect(await screen.findByTestId('pair-step-locked')).toBeInTheDocument();
  });

  /**
   * Ordering, reported from the running app: signed out, the dashboard offered
   * "Sign in to Lilypad" and directly beneath it a live enrollment QR counting
   * down — the last step of a flow whose first step had not happened, with
   * nothing relating the two. The QR is now a recovery path rather than the
   * front door, and it still adopts this machine onto whichever account the
   * scanning PHONE holds — so it still has to be ordered rather than left
   * sitting there looking like a second way to log in.
   */
  it('says nothing about this computer until somebody has signed in on it', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    expect(await screen.findByTestId('link-step-locked')).toHaveTextContent(/sign in above first/i);
    expect(screen.queryByTestId('account-panel')).not.toBeInTheDocument();
  });

  /**
   * The defect this ordering exists for, reported from the running app: the
   * pairing QR was reachable — from the tray, the dashboard's "+", and here —
   * on a computer nobody had signed into or linked. A pair made in that state
   * belongs to no account: it appears in nobody's "Your devices" and can be
   * revoked from nowhere, which is the state
   * [ADR-0010](../../../docs/adr/0010-explicit-device-linking.md) rejected and
   * `docs/api.md` said would end "when P1 makes enrolment mandatory".
   *
   * Signing in is now what puts a Mac on an account (ADR-0015), so reaching
   * this state means the sign-in enrollment did not land. The step still has
   * to refuse rather than offer a button `/pairing/create` answers 404 to.
   */
  it('does not offer to pair a phone while this computer is on no account', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    expect(await screen.findByTestId('pair-step-locked')).toHaveTextContent(
      /isn’t on your account yet/i,
    );
    expect(screen.queryByText('Show pairing code')).not.toBeInTheDocument();
  });

  it('offers pairing once this computer is on the account', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'linked' };
      return undefined;
    });

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    expect(await screen.findByText('Show pairing code')).toBeInTheDocument();
    expect(screen.queryByTestId('pair-step-locked')).not.toBeInTheDocument();
  });

  it('shows this computer’s account status once signed in', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'unlinked' };
      if (cmd === 'get_account_state')
        return { signedIn: true, email: 'ada@example.com', userId: 'user-1' };
      return undefined;
    });

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    expect(await screen.findByTestId('account-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('link-step-locked')).not.toBeInTheDocument();
  });

  /**
   * The defect this whole change exists for. The wizard used to finish with
   * "All set — you can start pairing now" as soon as the two permissions were
   * granted, which is the one thing P1's definition of done forbids: the
   * desktop announcing it is ready before a phone has approved it. Permissions
   * say what the machine can do, never whose it is.
   */
  it('does not claim the computer is on an account when it is not', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    const done = await screen.findByTestId('setup-done-unlinked');
    expect(done).toHaveTextContent(/not on an account yet/i);
    expect(screen.queryByTestId('setup-done-linked')).not.toBeInTheDocument();
  });

  /**
   * The closing card used to say "✓ Permissions are done, so you can pair a
   * phone" to an unlinked user — four lines below the step that explains they
   * cannot, and contrary to the backend.
   *
   * `/pairing/create` resolves the desktop's ownership and refuses a computer
   * on no account: `actAsDevice`'s only `allow` is `owner` since the unowned
   * lane closed, and an unlinked Mac holds no device token to be an actor with.
   * Verified against a running backend — no token, `404 not_found`. Telling a
   * first-run customer to go and do the one thing that cannot work is how a
   * setup wizard loses them at the last card.
   */
  it('does not tell an unlinked computer it can pair', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    const done = await screen.findByTestId('setup-done-unlinked');
    expect(done).toHaveTextContent(/can’t pair a phone/i);
    expect(done.textContent ?? '').not.toMatch(/so you can pair/i);
  });

  /**
   * Regression: the final card derived "not on an account" from
   * `state !== 'linked'`, which lumps in `unknown` — the state that means the
   * backend could not be asked, not that nobody owns this machine. A linked
   * user whose wifi dropped mid-setup was told their computer was on no
   * account and pointed at step 2 to fix it, i.e. invited to redo a ceremony
   * they had already completed. `LinkStateDto` calls the two out as
   * deliberately different for exactly this reason.
   */
  it('does not claim the computer is unlinked when the backend cannot be asked', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'unknown' };
      return undefined;
    });

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    expect(await screen.findByTestId('setup-done-unknown')).toHaveTextContent(/could not check/i);
    expect(screen.queryByTestId('setup-done-unlinked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('setup-done-linked')).not.toBeInTheDocument();
  });

  it('says the computer belongs to the account once it is on one', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'linked' };
      return undefined;
    });

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    expect(await screen.findByTestId('setup-done-linked')).toHaveTextContent(
      /belongs to your account/i,
    );
    expect(screen.queryByTestId('setup-done-unlinked')).not.toBeInTheDocument();
  });

  it('opens the pairing code window from the last step', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'linked' };
      return undefined;
    });

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    fireEvent.click(await screen.findByText('Show pairing code'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('show_qr_window'));
  });

  // Regression test for the relaunch heuristic in
  // docs/audit/m3/desktop-ux.md Finding 1: only offer a restart after the
  // user demonstrably opened Settings for a permission AND it still reads
  // ungranted after several consecutive polls — never on a timer alone, and
  // never for a permission nobody tried to grant yet.
  it('offers a restart only after Settings was opened AND 3 consecutive polls still read ungranted', async () => {
    mockSignedIn();
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    await screen.findByText('Screen Recording');

    // Two stale polls with Settings never opened for accessibility — must not offer a restart.
    eventHandler?.({ payload: status() });
    eventHandler?.({ payload: status() });
    expect(screen.queryByText('Restart Lilypad')).not.toBeInTheDocument();

    // User opens Settings for accessibility.
    fireEvent.click(nth(screen.getAllByText('Open Settings'), 1));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('open_permission_settings', { kind: 'accessibility' }),
    );

    // Two more stale polls — not yet at the threshold (3).
    eventHandler?.({ payload: status() });
    eventHandler?.({ payload: status() });
    expect(screen.queryByText('Restart Lilypad')).not.toBeInTheDocument();

    // Third consecutive stale poll after opening Settings — now offer it.
    eventHandler?.({ payload: status() });
    await waitFor(() => expect(screen.getByText('Restart Lilypad')).toBeInTheDocument());
  });

  it('a granted permission resets its stale-poll counter', async () => {
    mockSignedIn();
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    await screen.findByText('Screen Recording');

    fireEvent.click(nth(screen.getAllByText('Open Settings'), 1)); // accessibility
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('open_permission_settings', { kind: 'accessibility' }),
    );

    eventHandler?.({ payload: status() });
    eventHandler?.({ payload: status() });
    // Granted in between — counter resets.
    eventHandler?.({ payload: status({ accessibility: true }) });
    eventHandler?.({ payload: status() });
    eventHandler?.({ payload: status() });

    expect(screen.queryByText('Restart Lilypad')).not.toBeInTheDocument();
  });
});

/**
 * The same window, twice — see `Setup.tsx`'s `mode`.
 *
 * Finishing setup used to leave the wizard as the only route back to the two
 * things it configures that are NOT one-time: the Ask AI provider and the
 * account on this Mac. So a customer who wanted to change an API key three
 * weeks later opened a window headed "Set up Lilypad · Three steps", read three
 * numbered steps they had already done, and found the field they came for at
 * the bottom under "Optional", behind a permission gate it has nothing to do
 * with.
 */
describe('Setup — wizard or settings', () => {
  let eventHandler: ((event: { payload: unknown }) => void) | undefined;

  /** Signed in, both permissions granted: a Mac that finished setup. */
  function mockComplete() {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status')
        return status({ screen_capture: true, accessibility: true });
      if (cmd === 'get_link_state') return { state: 'linked' };
      if (cmd === 'get_account_state')
        return { signedIn: true, email: 'ada@example.com', userId: 'user-1' };
      return undefined;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandler = undefined;
    vi.mocked(listen).mockImplementation((async (
      _name: string,
      handler: (e: { payload: unknown }) => void,
    ) => {
      eventHandler = handler;
      return vi.fn();
    }) as unknown as typeof listen);
    vi.mocked(getCurrentWindow).mockReturnValue({
      close: vi.fn(),
      setTitle: vi.fn(),
    } as unknown as ReturnType<typeof getCurrentWindow>);
  });

  it('opens as Settings on a Mac that already finished setup', async () => {
    mockComplete();
    render(<Setup />);

    await screen.findByTestId('setup-settings');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Lilypad Settings');
    // Not a step, not numbered, and nothing to be "done" with.
    const numbered = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent ?? '')
      .filter((text) => /^\d+ · /.test(text));
    expect(numbered).toEqual([]);
    expect(screen.queryByTestId('setup-done')).toBeNull();
  });

  it('renames the window, so macOS stops calling it Setup', async () => {
    const setTitle = vi.fn();
    vi.mocked(getCurrentWindow).mockReturnValue({
      close: vi.fn(),
      setTitle,
    } as unknown as ReturnType<typeof getCurrentWindow>);
    mockComplete();
    render(<Setup />);

    await screen.findByTestId('setup-settings');
    await waitFor(() => expect(setTitle).toHaveBeenCalledWith('Lilypad — Settings'));
  });

  /** The whole point of the change: the one field people come back for. */
  it('offers Ask AI without a permission gate', async () => {
    mockComplete();
    render(<Setup />);

    await screen.findByTestId('setup-settings');
    expect(screen.getByTestId('ask-optional')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ask AI' })).toBeInTheDocument();

    // A permission revoked in System Settings while this window is open must
    // not take the API key field away with it — Ask does not use Screen
    // Recording, and losing the field is how it became unreachable before.
    await waitFor(() => expect(listen).toHaveBeenCalled());
    eventHandler?.({ payload: status({ accessibility: true }) });
    await waitFor(() => expect(screen.getByTestId('ask-optional')).toBeInTheDocument());
  });

  /**
   * Signing out inside Settings leaves the window in Settings — the mode is
   * decided once — so every locked-state sentence has to work without step
   * numbers. "Finish step 1 first" names a step that is not on the screen.
   */
  it('does not point at numbered steps in a window that has none', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status')
        return status({ screen_capture: true, accessibility: true });
      if (cmd === 'get_link_state') return { state: 'unlinked' };
      // Signed out, but the permissions say this Mac finished setup long ago.
      if (cmd === 'get_account_state') return { signedIn: false, email: null, userId: null };
      return undefined;
    });
    render(<Setup />);

    // Signed out with both permissions granted is a Settings window, not a
    // wizard: the permissions half of setup is still done.
    await screen.findByTestId('setup-wizard');
    expect(screen.getByTestId('permissions-step-locked')).toHaveTextContent(/finish step 1/i);
  });

  it('says "sign in above" instead of "step 1" once it is the Settings window', async () => {
    mockComplete();
    const { rerender } = render(<Setup />);
    await screen.findByTestId('setup-settings');
    rerender(<Setup />);

    // Nothing in a Settings window may cite a step number, because there are
    // none on screen to follow.
    const numbered = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent ?? '')
      .filter((text) => /^\d+ · /.test(text));
    expect(numbered).toEqual([]);
    expect(screen.queryByText(/step 1/i)).toBeNull();
  });

  it('stays a wizard for a first run, and does not rename itself mid-flow', async () => {
    // Signed in, nothing granted yet: still setting up.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'linked' };
      if (cmd === 'get_account_state')
        return { signedIn: true, email: 'ada@example.com', userId: 'user-1' };
      return undefined;
    });
    render(<Setup />);
    await screen.findByTestId('setup-wizard');

    // Granting the last permission finishes the wizard. It must FINISH it —
    // not silently become a different window with different headings while the
    // user is still reading it.
    await waitFor(() => expect(listen).toHaveBeenCalled());
    eventHandler?.({ payload: status({ screen_capture: true, accessibility: true }) });

    await screen.findByTestId('setup-done');
    expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Set up Lilypad');
  });
});
