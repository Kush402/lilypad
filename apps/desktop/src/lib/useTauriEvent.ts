import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

/**
 * Read once on mount, then again every time the backend says the answer
 * changed.
 *
 * Each Tauri window is a separate webview running its own copy of this bundle,
 * and `open_window` HIDES the others rather than closing them — so a window
 * keeps whatever it read the last time it was mounted, for as long as the app
 * runs. Anything read once on mount is therefore not "current", it is
 * "whenever this window first opened".
 *
 * That produced the bug this hook exists to kill: signing in on the dashboard
 * left Settings showing the sign-in form, because Settings had read the
 * account state before the sign-in and nothing ever told it otherwise. One
 * product, two windows, two different answers to "who is signed in".
 *
 * The handler is read through a ref so an inline arrow at the call site cannot
 * re-subscribe on every render — the same rule `useLiveResource` follows for
 * its fetcher, and for the same reason.
 */
export function useTauriEvent(event: string, onEvent: () => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    handler.current();
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen(event, () => handler.current())
      .then((fn) => {
        // The effect may have cleaned up (a fast unmount) before the listener
        // finished attaching — tear it down now rather than leak it.
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {
        /* not running inside Tauri (e.g. a plain `vite` preview) */
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [event]);
}
