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
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen(event, () => handler.current())
      .then((fn) => {
        // The effect may have cleaned up (a fast unmount) before the listener
        // finished attaching — tear it down now rather than leak it.
        if (alive) {
          unlisten = fn;
          // Subscribe before the first read. Reading first leaves a lost-wakeup
          // gap: state can change after that snapshot but before `listen`
          // finishes attaching, and a quiet session then leaves this webview
          // frozen forever on the old answer. A read after attachment observes
          // everything that happened in the gap; a simultaneous event merely
          // causes a second race-safe refresh.
          handler.current();
        } else fn();
      })
      .catch(() => {
        // Outside Tauri (e.g. a plain `vite` preview) there is no event source,
        // but the resource should still get its ordinary mount-time read.
        if (alive) handler.current();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [event]);
}
