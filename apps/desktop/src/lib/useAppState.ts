import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, type AppStateDto } from './tauri';

/**
 * The single source of truth for `AppStateDto` in every window, refreshed
 * exactly when something changed instead of on a fixed timer. The Rust
 * session runner already emits a fully event-driven `lilypad://session`
 * stream (`commands.rs`'s `spawn_session_runner`) for this exact purpose —
 * previously nothing in the frontend called `listen()` on it, so every
 * window independently polled `get_state` on 800-1000ms timers regardless of
 * whether anything had actually changed. See
 * `docs/audit/m3/desktop-ux.md` Finding 8.
 *
 * Deliberately still calls `get_state()` (rather than trying to derive
 * `AppStateDto`'s full shape from the raw `SessionEvent` stream itself) —
 * `get_state` stays the one authoritative snapshot shape; the event is only
 * the "something changed, go re-fetch" signal, which keeps this hook from
 * duplicating the state-machine reduction `apply_session_event` already does
 * on the Rust side.
 */
export function useAppState(): AppStateDto | null {
  const [state, setState] = useState<AppStateDto | null>(null);

  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const s = await api.getState();
        if (alive) setState(s);
      } catch {
        /* not running inside Tauri (e.g. a plain `vite` preview) */
      }
    };

    void refresh();

    let unlisten: (() => void) | undefined;
    listen('lilypad://session', () => {
      void refresh();
    })
      .then((fn) => {
        if (alive) {
          unlisten = fn;
        } else {
          // Effect already cleaned up (fast unmount) before the listener
          // finished attaching — tear it down immediately instead of leaking.
          fn();
        }
      })
      .catch(() => {
        /* not running inside Tauri */
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return state;
}
