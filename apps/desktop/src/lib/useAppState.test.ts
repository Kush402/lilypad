import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAppState } from './useAppState';
import { api, type AppStateDto } from './tauri';

vi.mock('./tauri', () => ({
  api: {
    getState: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

function dto(overrides: Partial<AppStateDto> = {}): AppStateDto {
  return {
    device_id: 'desktop-1',
    backend_base_url: 'http://localhost:8080',
    session: 'idle',
    current_room_id: null,
    pending_request: null,
    plugin_health: {},
    connection_path: null,
    ...overrides,
  };
}

describe('useAppState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches state once on mount', async () => {
    vi.mocked(api.getState).mockResolvedValue(dto({ session: 'idle' }));
    const { listen } = await import('@tauri-apps/api/event');
    vi.mocked(listen).mockResolvedValue(vi.fn());

    const { result } = renderHook(() => useAppState());

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.session).toBe('idle');
    expect(api.getState).toHaveBeenCalledTimes(1);
  });

  it('subscribes to the lilypad://session event', async () => {
    vi.mocked(api.getState).mockResolvedValue(dto());
    const { listen } = await import('@tauri-apps/api/event');
    vi.mocked(listen).mockResolvedValue(vi.fn());

    renderHook(() => useAppState());

    await waitFor(() =>
      expect(listen).toHaveBeenCalledWith('lilypad://session', expect.any(Function)),
    );
  });

  it('re-fetches state when the event fires, without a timer', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getState)
      .mockResolvedValueOnce(dto({ session: 'idle' }))
      .mockResolvedValueOnce(dto({ session: 'active' }));

    const { listen } = await import('@tauri-apps/api/event');
    let eventHandler: (() => void) | undefined;
    vi.mocked(listen).mockImplementation((async (
      _name: string,
      handler: (...args: unknown[]) => void,
    ) => {
      eventHandler = handler;
      return vi.fn();
    }) as typeof listen);

    const { result } = renderHook(() => useAppState());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current?.session).toBe('idle');
    expect(api.getState).toHaveBeenCalledTimes(1);

    // No timer-driven re-fetch — advancing time alone must not trigger one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(api.getState).toHaveBeenCalledTimes(1);

    // The event firing IS what triggers the re-fetch.
    await act(async () => {
      eventHandler?.();
      await Promise.resolve();
    });
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(result.current?.session).toBe('active');

    vi.useRealTimers();
  });

  it('unsubscribes on unmount', async () => {
    vi.mocked(api.getState).mockResolvedValue(dto());
    const unlisten = vi.fn();
    const { listen } = await import('@tauri-apps/api/event');
    vi.mocked(listen).mockResolvedValue(unlisten);

    const { unmount } = renderHook(() => useAppState());
    await waitFor(() => expect(listen).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('never throws when running outside Tauri (getState/listen rejecting)', async () => {
    vi.mocked(api.getState).mockRejectedValue(new Error('not in tauri'));
    const { listen } = await import('@tauri-apps/api/event');
    vi.mocked(listen).mockRejectedValue(new Error('not in tauri'));

    const { result } = renderHook(() => useAppState());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });
});
