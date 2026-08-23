import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Setup } from './Setup';
import { AccountPanel } from './AccountPanel';
import { invoke } from '@tauri-apps/api/core';
import { api, type LinkStateDto } from '../lib/tauri';

/**
 * An unlinked Mac must not talk to the backend on a timer.
 *
 * `get_link_state` is not a cheap read: on a machine with no cached identity
 * it performs a full device sign-in — `POST /devices/challenge` followed by a
 * signed `POST /devices/token` — and on an unlinked machine the second half
 * can only ever answer 403. `Setup` and `Control` each ran that on a 3s
 * interval for as long as they were open and unlinked.
 *
 * Measured against production on 2026-08-21 during a real first-run test: 64
 * challenges and 61 rejected token exchanges in the 3m21s before the phone
 * approved, stopping at the exact second it did. Every one of them was
 * pointless, because only `AccountPanel` can cause that transition — a desktop
 * cannot enrol itself (`/devices/enroll` answers 403
 * `desktop_enrollment_requires_approval` for `kind: "desktop"`) and the only
 * other path burns a code bound at mint time to this machine's public key,
 * with a 120-second life. Outside that window there is nothing to observe.
 *
 * These tests are the guard. They assert the CALL COUNT over time, because
 * that is the customer-visible cost — battery and radio on their Mac, and
 * ~40 requests a minute per unlinked machine against ours.
 */

vi.mock('../lib/tauri', () => ({
  api: { getLinkState: vi.fn(), startEnrollment: vi.fn(), showQrWindow: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: vi.fn() }),
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,stub') },
}));
vi.mock('./AgentProviderCard', () => ({ AgentProviderCard: () => null }));
vi.mock('./AccountSignIn', () => ({ AccountSignIn: () => null }));

const unlinked: LinkStateDto = {
  state: 'unlinked',
  user_id: null,
  device_id: null,
  detail: null,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Permissions granted: that is the state in which the old code polled, so it
  // is the state this has to prove quiet.
  vi.mocked(invoke).mockImplementation(async (cmd: string) =>
    cmd === 'get_permission_status' ? { screen_capture: true, accessibility: true } : undefined,
  );
  vi.mocked(api.getLinkState).mockResolvedValue(unlinked);
  vi.mocked(api.startEnrollment).mockResolvedValue({
    code: 'a'.repeat(24),
    expiresInSeconds: 120,
    apiBaseUrl: 'https://api.takedia.com',
    deviceName: 'macos desktop',
    platform: 'macos',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Let mounted effects settle, then run the clock forward `ms` inside `act`. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('an unlinked Mac left sitting on screen', () => {
  it('does not poll the backend from the Setup wizard', async () => {
    render(<Setup />);
    await elapse(0);
    const afterMount = vi.mocked(api.getLinkState).mock.calls.length;

    // A minute of a user reading the permission copy, or looking for their
    // phone. The old code issued twenty exchanges in this window.
    await elapse(60_000);

    expect(vi.mocked(api.getLinkState).mock.calls.length).toBe(afterMount);
  });

  it('still polls while an enrollment code is actually on screen', async () => {
    render(<AccountPanel />);
    await elapse(0);

    const button = await screen.findByRole('button', { name: 'Link this computer' });
    await act(async () => {
      button.click();
    });
    const afterMint = vi.mocked(api.getLinkState).mock.calls.length;

    // The code lives 120s and approval happens on the phone, so this window is
    // the one place a poll can learn something. It must survive the fix.
    await elapse(30_000);

    expect(vi.mocked(api.getLinkState).mock.calls.length).toBeGreaterThan(afterMint);
  });

  it('tells its host the moment linking lands, so nobody has to poll for it', async () => {
    const onLinked = vi.fn();
    vi.mocked(api.getLinkState).mockResolvedValue({
      state: 'linked',
      user_id: 'u-1',
      device_id: 'd-1',
      detail: null,
    });

    render(<AccountPanel onLinked={onLinked} />);
    await elapse(0);

    expect(onLinked).toHaveBeenCalled();
  });
});

describe('an enrollment code nobody scanned', () => {
  /**
   * `DESKTOP_ENROLLMENT_TTL_SECONDS` is 120: the backend forgets the code
   * after two minutes. `enrollment` was only cleared on SUCCESS, so a user who
   * opened this step, did not scan, and walked away left the poll running
   * every 3s indefinitely — against a code that no longer existed. The panel
   * already showed an "Expired" badge; the poll simply did not consult it.
   */
  it('stops polling once the code has expired', async () => {
    render(<AccountPanel />);
    await elapse(0);

    const button = await screen.findByRole('button', { name: 'Link this computer' });
    await act(async () => {
      button.click();
    });

    // Alive: the poll is doing its job.
    const afterMint = vi.mocked(api.getLinkState).mock.calls.length;
    await elapse(30_000);
    expect(vi.mocked(api.getLinkState).mock.calls.length).toBeGreaterThan(afterMint);

    // Past the 120s TTL the code is gone server-side and nothing can change.
    await elapse(120_000);
    const afterExpiry = vi.mocked(api.getLinkState).mock.calls.length;
    await elapse(60_000);

    expect(vi.mocked(api.getLinkState).mock.calls.length).toBe(afterExpiry);
  });

  it('still says so on screen, so the user knows to mint another', async () => {
    render(<AccountPanel />);
    await elapse(0);
    const button = await screen.findByRole('button', { name: 'Link this computer' });
    await act(async () => {
      button.click();
    });

    await elapse(121_000);

    expect(screen.getByText('This code has expired.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New code' })).toBeInTheDocument();
  });
});
