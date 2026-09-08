import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SoftwareUpdate } from './SoftwareUpdate';
import { updater } from '../lib/tauri';
import { AUTO_CHECK_INTERVAL_MS } from '../lib/useUpdater';

vi.mock('../lib/tauri', () => ({
  updater: {
    currentVersion: vi.fn().mockResolvedValue('0.1.0'),
    check: vi.fn(),
    relaunch: vi.fn(),
  },
}));

/** Build a fake `Update` whose downloadAndInstall drives the progress events. */
function fakeUpdate(version = '0.2.0', body: string | null = null) {
  return {
    version,
    currentVersion: '0.1.0',
    body,
    downloadAndInstall: vi.fn(
      async (
        onEvent?: (e: {
          event: string;
          data?: { contentLength?: number; chunkLength?: number };
        }) => void,
      ) => {
        onEvent?.({ event: 'Started', data: { contentLength: 100 } });
        onEvent?.({ event: 'Progress', data: { chunkLength: 100 } });
        onEvent?.({ event: 'Finished' });
      },
    ),
  };
}

describe('SoftwareUpdate — the automatic check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updater.currentVersion).mockResolvedValue('0.1.0');
  });

  it('keeps asking, because an app that never restarts never gets a launch check', async () => {
    // Measured 2026-09-08: this Mac last launched Lilypad three hours BEFORE
    // v0.1.31 published and was still on 0.1.30 a day later. A launch-only
    // check had nothing to fire on.
    vi.useFakeTimers();
    try {
      vi.mocked(updater.check).mockResolvedValue(null);
      render(<SoftwareUpdate variant="banner" />);
      await vi.waitFor(() => expect(updater.check).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS + 1);
      expect(updater.check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking once it has something, so a finished download is not discarded', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(updater.check).mockResolvedValue(fakeUpdate('0.2.0') as never);
      render(<SoftwareUpdate variant="banner" />);
      await vi.waitFor(() => expect(updater.check).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS * 3);
      expect(updater.check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SoftwareUpdate — panel (Diagnostics)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updater.currentVersion).mockResolvedValue('0.1.0');
  });

  it('shows the current version', async () => {
    vi.mocked(updater.check).mockResolvedValue(null);
    render(<SoftwareUpdate variant="panel" />);
    await waitFor(() => expect(screen.getByText('0.1.0')).toBeInTheDocument());
  });

  it('manual check reports up-to-date when no update is returned', async () => {
    vi.mocked(updater.check).mockResolvedValue(null);
    render(<SoftwareUpdate variant="panel" />);

    screen.getByText('Check for updates').click();
    await waitFor(() => expect(screen.getByText(/latest version/i)).toBeInTheDocument());
    expect(updater.check).toHaveBeenCalled();
  });

  it('runs the full check → download → ready → relaunch flow', async () => {
    vi.mocked(updater.check).mockResolvedValue(fakeUpdate('0.2.0', 'Bug fixes') as any);
    render(<SoftwareUpdate variant="panel" />);

    screen.getByText('Check for updates').click();
    await waitFor(() => expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument());
    expect(screen.getByText('Bug fixes')).toBeInTheDocument();

    screen.getByText(/Download & install/i).click();
    await waitFor(() => expect(screen.getByText('Restart to update')).toBeInTheDocument());

    screen.getByText('Restart to update').click();
    await waitFor(() => expect(updater.relaunch).toHaveBeenCalled());
  });
});

describe('SoftwareUpdate — banner (launch prompt)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updater.currentVersion).mockResolvedValue('0.1.0');
  });

  it('renders nothing when the silent check finds no update', async () => {
    vi.mocked(updater.check).mockResolvedValue(null);
    const { container } = render(<SoftwareUpdate variant="banner" />);
    await waitFor(() => expect(updater.check).toHaveBeenCalled());
    expect(container.querySelector('.update-banner')).toBeNull();
  });

  it('surfaces a prompt when the silent check finds an update', async () => {
    vi.mocked(updater.check).mockResolvedValue(fakeUpdate('0.3.0') as any);
    render(<SoftwareUpdate variant="banner" />);
    await waitFor(() => expect(screen.getByText(/0\.3\.0/)).toBeInTheDocument());
    expect(screen.getByText(/Download & install/i)).toBeInTheDocument();
  });
});

describe('SoftwareUpdate — when a step fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updater.currentVersion).mockResolvedValue('0.1.0');
  });

  it('names the check when the check is what failed', async () => {
    vi.mocked(updater.check).mockRejectedValue(new Error('no network'));

    render(<SoftwareUpdate variant="banner" />);

    expect(await screen.findByText(/Couldn’t check for updates\. no network/)).toBeInTheDocument();
  });

  it('names the download when the download is what failed', async () => {
    // The bug this replaces: both steps collapsed into one phase, so a
    // download that died halfway was reported as "Update check failed" —
    // the wrong step, sending the reader to look in the wrong place.
    const update = fakeUpdate();
    update.downloadAndInstall.mockRejectedValue(new Error('disk full'));
    vi.mocked(updater.check).mockResolvedValue(update as never);

    render(<SoftwareUpdate variant="banner" />);
    (await screen.findByRole('button', { name: 'Download & install' })).click();

    expect(await screen.findByText(/Couldn’t download the update\. disk full/)).toBeInTheDocument();
  });

  it('offers a retry rather than leaving a dead end', async () => {
    // Previously the error state rendered a message and no buttons at all, so
    // the update stayed unavailable until the app was restarted.
    const update = fakeUpdate();
    update.downloadAndInstall.mockRejectedValueOnce(new Error('disk full'));
    vi.mocked(updater.check).mockResolvedValue(update as never);

    render(<SoftwareUpdate variant="banner" />);
    (await screen.findByRole('button', { name: 'Download & install' })).click();
    (await screen.findByTestId('update-retry')).click();

    // Retried the DOWNLOAD, not the check: the update already found is still
    // the right one, and re-checking would make the user wait on the feed
    // again for an answer already in hand.
    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledTimes(2));
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Restart to update' })).toBeInTheDocument();
  });

  it('re-checks when it was the check that failed', async () => {
    vi.mocked(updater.check).mockRejectedValueOnce(new Error('no network'));
    vi.mocked(updater.check).mockResolvedValueOnce(fakeUpdate() as never);

    render(<SoftwareUpdate variant="banner" />);
    (await screen.findByTestId('update-retry')).click();

    expect(await screen.findByText(/Lilypad 0\.2\.0/)).toBeInTheDocument();
    expect(updater.check).toHaveBeenCalledTimes(2);
  });
});
