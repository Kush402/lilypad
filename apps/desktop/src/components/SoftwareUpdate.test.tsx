import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SoftwareUpdate } from './SoftwareUpdate';
import { updater } from '../lib/tauri';

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
